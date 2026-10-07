import { test } from "node:test";
import assert from "node:assert/strict";
import type { TrackerDocument } from "../types";
import { scoreContact } from "./prefilter";
import {
  batchPriceAnomaly,
  countSellerCrossPosts,
  fetchSellerInfoSignals,
  liveTrustSignalProvider,
  observePrice,
  resolveLiveTrustSignals,
  type TrustRunner,
} from "./trust-live";

const NOW = "2026-09-27T05:00:00Z";
const LATER = "2026-09-27T06:00:00Z";

function sellerInfoPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    sellers: [
      {
        listing_id: "111",
        seller_id: "seller-1",
        seller_name: "Test Seller",
        trust_signals: {
          account_age_in_years: 3,
          rating_average: 4.8,
          rating_count: 12,
          ...overrides,
        },
      },
    ],
  });
}

function blankDoc(): TrackerDocument {
  return {
    version: 3,
    ownerActivity: {},
    listings: [],
    leads: [],
    campaigns: [],
    constraints: [],
    authority: [],
    outbox: [],
    bookings: [],
    seenEvents: [],
    buyers: {},
    watermarks: {},
    summaries: {},
    activity: [],
    serviceRequests: [],
    contacts: {},
    learning: {
      pricingHistory: [],
      approvalPatterns: {},
      negotiationOutcomes: {},
      contactTrustScores: {},
      huntKills: [],
      providerTrust: {},
    },
    inventory: { items: [], services: [], hunts: [] },
    updatedAt: NOW,
  };
}

test("fetchSellerInfoSignals: maps account_age_in_years to days", async () => {
  const runner: TrustRunner = async () => sellerInfoPayload();
  const { signals, reputation } = await fetchSellerInfoSignals("111", runner);
  assert.equal(signals.accountAgeDays, 1095);
  assert.equal(reputation.sellerName, "Test Seller");
  assert.equal(reputation.ratingAverage, 4.8);
  assert.equal(reputation.ratingCount, 12);
});

test("fetchSellerInfoSignals: missing trust block degrades to unknown", async () => {
  const runner: TrustRunner = async () => JSON.stringify({ sellers: [{}] });
  const { signals } = await fetchSellerInfoSignals("111", runner);
  assert.equal(signals.accountAgeDays, undefined);
  assert.deepEqual(scoreContact(signals).reasons, []);
});

test("fetchSellerInfoSignals: throws on lookup failure (caller degrades)", async () => {
  const runner: TrustRunner = async () => {
    throw new Error("network down");
  };
  await assert.rejects(() => fetchSellerInfoSignals("111", runner), /network down/);
});

test("countSellerCrossPosts: counts distinct listings per seller across queries", () => {
  const perQuery = [
    [
      { listingId: "a", sellerId: "s1" },
      { listingId: "b", sellerId: "s2" },
    ],
    [
      { listingId: "a", sellerId: "s1" }, // dup across queries — counted once
      { listingId: "c", sellerId: "s1" },
    ],
  ];
  assert.equal(countSellerCrossPosts("s1", perQuery), 2);
  assert.equal(countSellerCrossPosts("s2", perQuery), 1);
  assert.equal(countSellerCrossPosts("nobody", perQuery), 0);
});

test("batchPriceAnomaly: cheap-vs-median yields severity, at/above median yields 0", () => {
  assert.equal(batchPriceAnomaly(50, [40, 50, 60]), 0);
  assert.equal(batchPriceAnomaly(70, [40, 50, 60]), 0);
  const sev = batchPriceAnomaly(25, [40, 50, 60]);
  assert.ok(sev > 0 && sev <= 1);
  assert.equal(sev, 0.5); // (50-25)/50
  assert.equal(batchPriceAnomaly(undefined, [40, 50]), 0);
  assert.equal(batchPriceAnomaly(10, []), 0);
});

test("observePrice: first sighting records, no anomaly", () => {
  const { doc, anomaly } = observePrice(blankDoc(), "L1", 50, NOW);
  assert.equal(anomaly, undefined);
  assert.equal(doc.learning.observedPrices?.["L1"]?.price, 50);
});

test("observePrice: ≥20% re-sighting change yields severity and re-records", () => {
  const d1 = observePrice(blankDoc(), "L1", 50, NOW).doc;
  const { doc: d2, anomaly } = observePrice(d1, "L1", 30, LATER);
  assert.ok(anomaly !== undefined && anomaly > 0);
  assert.equal(Math.round(anomaly! * 100) / 100, 0.4);
  assert.equal(d2.learning.observedPrices?.["L1"]?.price, 30);
  const small = observePrice(d2, "L1", 32, LATER);
  assert.equal(small.anomaly, undefined); // 6.7% — immaterial
});

test("resolveLiveTrustSignals: composes age + cross-posts + batch anomaly", async () => {
  const runner: TrustRunner = async (args) => {
    if (args.includes("seller-info")) return sellerInfoPayload({ account_age_in_years: 0.01 }); // ~4 days → −25
    throw new Error("unexpected call");
  };
  const perQuery = [[{ listingId: "x", sellerId: "s9" }], [{ listingId: "y", sellerId: "s9" }], [{ listingId: "z", sellerId: "s9" }]];
  const result = await resolveLiveTrustSignals(
    { listingId: "111", sellerId: "s9", price: 10, batchPrices: [45, 50, 55], perQueryResults: perQuery },
    runner,
  );
  assert.equal(result.signals.accountAgeDays, 4);
  assert.equal(result.signals.crossPostCount, 3);
  assert.ok((result.signals.priceAnomaly ?? 0) > 0);
  // 50 − 25 (new account) − 10 (3 cross-posts) − 24 (80% below median) = −9 → clamped 0
  assert.ok(result.score.score < 40);
});

test("resolveLiveTrustSignals: seller-info failure degrades to neutral, never throws", async () => {
  const runner: TrustRunner = async () => {
    throw new Error("down");
  };
  const result = await resolveLiveTrustSignals({ listingId: "111" }, runner);
  assert.equal(result.score.score, 50);
  assert.equal(result.reputation, undefined);
});

test("liveTrustSignalProvider: adapter resolves listing_id as contactId", async () => {
  const runner: TrustRunner = async () => sellerInfoPayload({ account_age_in_years: 5 });
  const provider = liveTrustSignalProvider(runner);
  const signals = await provider.getSignals("111", "thread-1");
  assert.equal(signals.accountAgeDays, 1825);
});
