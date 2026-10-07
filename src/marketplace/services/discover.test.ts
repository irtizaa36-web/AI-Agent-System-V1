import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServiceRequest, TrackerDocument } from "../types";
import { createServiceRequest } from "./requests";
import {
  buildDiscoveryQueries,
  discoverProviders,
  discoverProvidersWithQueries,
  formatCandidate,
  parseDiscoveryResults,
  type DiscoverySearchRunner,
  type DiscoveredProvider,
} from "./discover";

const NOW = "2026-09-27T05:00:00Z";

function fixtureDoc(): TrackerDocument {
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

function homeRequest(specs = "mount large living room TV on drywall"): ServiceRequest {
  return createServiceRequest(
    fixtureDoc(),
    { type: "home", specs, budgetCeiling: 150, timingWindow: "weekday evenings" },
    NOW,
  ).request;
}

function cleaningRequest(): ServiceRequest {
  return createServiceRequest(
    fixtureDoc(),
    { type: "cleaning", specs: "deep clean 2br apartment", budgetCeiling: 200, timingWindow: "saturday morning" },
    NOW,
  ).request;
}

function searchPayload(items: Array<Record<string, unknown>>): string {
  return JSON.stringify({ data: items });
}

function listing(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listing_id: "111",
    title: "TV Mounting Pro",
    price: "$50",
    location: "Houston, TX",
    distance: "3 mi",
    seller_id: "seller-1",
    product_url: "https://www.facebook.com/marketplace/item/111",
    description: "we mount tvs",
    ...overrides,
  };
}

test("buildDiscoveryQueries: cleaning uses fixed service terms", () => {
  assert.deepEqual(buildDiscoveryQueries(cleaningRequest()), [
    "house cleaning",
    "deep cleaning",
    "cleaning service",
  ]);
});

test("buildDiscoveryQueries: home leads with specs then trade fallbacks", () => {
  const queries = buildDiscoveryQueries(homeRequest());
  assert.equal(queries[0], "mount large living room TV on drywall");
  assert.ok(queries.includes("TV mounting"));
  assert.ok(queries.includes("handyman"));
});

test("parseDiscoveryResults: parses candidates, skips rows missing id/title/seller", () => {
  const parsed = parseDiscoveryResults(
    searchPayload([listing(), listing({ listing_id: "222", title: "Handyman Dan", price: "$40", seller_id: "seller-2" }), { title: "no id" }, { listing_id: "333" }]),
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].listingId, "111");
  assert.equal(parsed[0].price, 50);
  assert.equal(parsed[1].sellerId, "seller-2");
});

test("parseDiscoveryResults: garbage in, empty out", () => {
  assert.deepEqual(parseDiscoveryResults("not json"), []);
  assert.deepEqual(parseDiscoveryResults(JSON.stringify({ data: "nope" })), []);
});

test("discoverProviders: dedupes across queries, first sighting wins", async () => {
  const runner: DiscoverySearchRunner = async (args) => {
    const q = args[args.indexOf("--query") + 1];
    if (q === "house cleaning") return searchPayload([listing({ listing_id: "a", title: "Clean Co" })]);
    return searchPayload([listing({ listing_id: "a", title: "Clean Co" }), listing({ listing_id: "b", title: "Sparkle" })]);
  };
  const found = await discoverProviders(cleaningRequest(), runner);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((c) => c.listingId), ["a", "b"]);
});

test("discoverProviders: a failed query degrades, never kills the pass", async () => {
  const runner: DiscoverySearchRunner = async (args) => {
    const q = args[args.indexOf("--query") + 1];
    if (q === "deep cleaning") throw new Error("boom");
    return searchPayload([listing({ listing_id: "z", title: "Mop Squad" })]);
  };
  const found = await discoverProviders(cleaningRequest(), runner);
  assert.equal(found.length, 1);
  assert.equal(found[0].listingId, "z");
});

test("discoverProvidersWithQueries: exposes per-query results for cross-post counting", async () => {
  const runner: DiscoverySearchRunner = async () =>
    searchPayload([listing({ listing_id: "a", seller_id: "s1" }), listing({ listing_id: "b", seller_id: "s1" })]);
  const pass = await discoverProvidersWithQueries(homeRequest("fix sink"), runner);
  assert.equal(pass.perQuery.length, pass.queries.length);
  assert.ok(pass.perQuery.every((q) => q.length === 2));
});

test("discoverProviders: passes radius center, never a street address", async () => {
  const seen: string[][] = [];
  const runner: DiscoverySearchRunner = async (args) => {
    seen.push([...args]);
    return searchPayload([]);
  };
  await discoverProviders(homeRequest(), runner);
  assert.ok(seen.length > 0);
  for (const args of seen) {
    const flat = args.join(" ");
    assert.ok(flat.includes("29.74096"), "latitude present");
    assert.ok(flat.includes("-95.44716"), "longitude present");
    assert.ok(flat.includes("25"), "radius present");
    assert.ok(!flat.toLowerCase().includes("westcreek"), "no street address");
  }
});

test("formatCandidate: compact one-line + url", () => {
  const c: DiscoveredProvider = {
    listingId: "111",
    title: "TV Mounting Pro",
    price: 50,
    location: "Houston, TX",
    distance: "3 mi",
    sellerId: "seller-1",
    productUrl: "https://www.facebook.com/marketplace/item/111",
  };
  const line = formatCandidate(c, "85 (account age ≥ 2y (+20))");
  assert.ok(line.includes("TV Mounting Pro"));
  assert.ok(line.includes("$50"));
  assert.ok(line.includes("trust 85"));
  assert.ok(line.includes("https://www.facebook.com/marketplace/item/111"));
});
