import { test } from "node:test";
import assert from "node:assert/strict";
import type { PricingOutcome, TrackerDocument } from "../types";
import { recordSaleOutcome } from "./sales";
import { defaultLadderSuggestion, suggestLadder, LADDER_HISTORY_MIN_SALES } from "../selling/ladder";
import { detectRelist, normalizeSignature, signatureSimilarity } from "../buying/relist";
import { appendTapTimestamp, recomputeApprovalWindows, topWindows, hourOfWeek } from "./approval";
import { decayTrust, decayedScore } from "./trust";
import { formatLearningSummary } from "./summary";
import { priceReferenceCard, buildCardFromComps, buildPriceCard, stubCompSource, formatPriceCard } from "../pricing/reference";
import { formatInventory } from "../inventory";

const NOW = "2026-09-27T12:00:00Z";

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
    learning: { pricingHistory: [], approvalPatterns: {}, negotiationOutcomes: {}, contactTrustScores: {}, huntKills: [], providerTrust: {}, approvalTaps: [], relistSightings: {} },
    inventory: { items: [], services: [], hunts: [] },
    updatedAt: NOW,
  };
}

// ---------- Loop #1: pricing / ladder suggestion ----------

test("recordSaleOutcome appends to pricingHistory with days-to-close from the listing", () => {
  const doc = fixtureDoc();
  const created = { ...doc, listings: [{ id: "lamp", kind: "sale" as const, title: "Fixture Lamp", price: 40, priceFirm: true, payment: "cash", meetup: "Highland Village area", status: "active" as const, monitoring: true, holdTimeoutHours: 24, createdAt: "2026-09-20T12:00:00Z", updatedAt: "2026-09-20T12:00:00Z" }] };
  const { doc: d2, outcome } = recordSaleOutcome(created, { itemId: "lamp", listPrice: 40, finalPrice: 35, soldAt: NOW });
  assert.equal(d2.learning.pricingHistory.length, 1);
  assert.equal(outcome.daysToClose, 7);
  assert.equal(outcome.finalPrice, 35);
});

test("suggestLadder returns the static default with fewer than 5 sales", () => {
  const doc = fixtureDoc();
  const s = suggestLadder(doc, 50);
  assert.equal(s.salesUsed, 0);
  assert.equal(s.floor, 30);
  assert.deepEqual(s.drops.map((d) => d.dayOffset), [7, 14, 21]);
  assert.deepEqual(s.drops.map((d) => d.price), [45, 40, 35]);
  assert.match(s.basis, /static default/);
});

test("suggestLadder recomputes from history at 5+ sales", () => {
  // 6 sales: avg 10 days to close, avg final-vs-list 0.9.
  const history: PricingOutcome[] = Array.from({ length: 6 }, (_, i) => ({
    itemId: `item-${i}`,
    listPrice: 100,
    finalPrice: 90,
    soldAt: NOW,
    daysToClose: 10,
  }));
  const doc = { ...fixtureDoc(), learning: { ...fixtureDoc().learning, pricingHistory: history } };
  const s = suggestLadder(doc, 100);
  assert.equal(s.salesUsed, 6);
  assert.match(s.basis, /recomputed from 6 sales/);
  // Avg days-to-close 10 → offsets 10, 20 (the day-30 drop is absorbed into the floor).
  assert.deepEqual(s.drops.map((d) => d.dayOffset), [10, 20]);
  // Avg ratio 0.9 on $100 → $10 expected discount, $5 steps (min step) → 95, 90;
  // the third drop lands exactly on the floor, so it is absorbed: [95, 90], floor 90.
  assert.deepEqual(s.drops.map((d) => d.price), [95, 90]);
  assert.equal(s.floor, 90);
  // Never below the floor.
  for (const d of s.drops) assert.ok(d.price >= s.floor, `drop $${d.price} below floor $${s.floor}`);
});

test("suggestLadder stays strictly decreasing and floors small prices", () => {
  const s = defaultLadderSuggestion(12);
  assert.ok(s.floor >= 1);
  assert.ok(s.drops.length >= 1);
  for (let i = 1; i < s.drops.length; i++) assert.ok(s.drops[i].price < s.drops[i - 1].price);
});

test("LADDER_HISTORY_MIN_SALES is 5", () => {
  assert.equal(LADDER_HISTORY_MIN_SALES, 5);
});

// ---------- Loop #2: relist detection ----------

test("normalizeSignature is order-insensitive and drops stopwords", () => {
  const a = normalizeSignature("Sony WH-1000XM4 Headphones, beige — great condition!");
  const b = normalizeSignature("Beige Sony WH1000XM4 headset");
  assert.equal(a, normalizeSignature(a));
  assert.ok(signatureSimilarity(a, b) >= 0.5, `similarity ${signatureSimilarity(a, b)} below threshold`);
});

test("detectRelist: first sighting is count 1, repeat is a matched relist with an activity line", () => {
  let doc = fixtureDoc();
  const r1 = detectRelist(doc, "seller-1", "Sony WH-1000XM4 headphones beige", NOW);
  assert.equal(r1.relistCount, 1);
  assert.equal(r1.matched, false);
  assert.equal(r1.doc.activity.length, 0, "no activity line on first sighting");
  const r2 = detectRelist(r1.doc, "seller-1", "Beige Sony WH1000XM4 headset", NOW);
  assert.equal(r2.relistCount, 2);
  assert.equal(r2.matched, true);
  assert.match(r2.doc.activity[0].text, /relisted 2x — urgency signal/);
  // A different item is a separate count.
  const r3 = detectRelist(r2.doc, "seller-1", "IKEA Poang armchair birch", NOW);
  assert.equal(r3.relistCount, 1);
  assert.equal(r3.matched, false);
});

// ---------- Loop #4: approval windows ----------

test("hourOfWeek maps a tap into the right slot in his timezone", () => {
  // 2026-09-21 is a Monday; 14:00 UTC = 09:00 CDT.
  assert.equal(hourOfWeek("2026-09-21T14:00:00Z", "America/Chicago"), 1 * 24 + 9);
});

test("appendTapTimestamp keeps the rolling 14-day window", () => {
  const taps = appendTapTimestamp(["2026-09-01T00:00:00Z"], "2026-09-27T12:00:00Z");
  assert.deepEqual(taps, ["2026-09-27T12:00:00Z"]);
});

test("recomputeApprovalWindows builds the per-hour-of-week distribution", () => {
  const doc = {
    ...fixtureDoc(),
    learning: {
      ...fixtureDoc().learning,
      approvalTaps: [
        "2026-09-21T14:00:00Z", // Mon 9am CDT
        "2026-09-21T14:30:00Z", // Mon 9am CDT
        "2026-09-22T20:00:00Z", // Tue 3pm CDT
      ],
    },
  };
  const { doc: d2, hourlyTapProbability, tapsInWindow } = recomputeApprovalWindows(doc, NOW);
  assert.equal(tapsInWindow, 3);
  const sum = hourlyTapProbability.reduce((s, p) => s + p, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `distribution sums to ${sum}`);
  assert.ok(Math.abs(hourlyTapProbability[33] - 2 / 3) < 1e-9);
  assert.ok(Math.abs(hourlyTapProbability[63] - 1 / 3) < 1e-9);
  assert.equal(hourlyTapProbability.length, 168);
  // Stored back on approvalPatterns["hourly"].
  assert.ok(d2.learning.approvalPatterns["hourly"]?.hourlyTapProbability);
  const top = topWindows(hourlyTapProbability, 6);
  assert.equal(top[0].label, "Mon 9am");
  assert.ok(Math.abs(top[0].probability - 2 / 3) < 1e-9);
  assert.equal(top[1].label, "Tue 3pm");
});

test("recomputeApprovalWindows with no taps yields all-zero windows", () => {
  const { hourlyTapProbability, tapsInWindow } = recomputeApprovalWindows(fixtureDoc(), NOW);
  assert.equal(tapsInWindow, 0);
  assert.ok(hourlyTapProbability.every((p) => p === 0));
  assert.deepEqual(topWindows(hourlyTapProbability, 6), []);
});

// ---------- Loop #5: trust decay ----------

test("decayedScore regresses 10% toward 50 per week, never crossing 50", () => {
  assert.equal(decayedScore(70, 1), 68);
  assert.equal(decayedScore(30, 1), 32);
  assert.equal(decayedScore(80, 2), 74.3);
  assert.equal(decayedScore(50, 10), 50);
  assert.ok(decayedScore(55, 52) >= 50, "never decays below 50 from above");
  assert.ok(decayedScore(45, 52) <= 50, "never decays above 50 from below");
  assert.equal(decayedScore(70, 0), 70, "no full weeks → no decay");
});

test("decayTrust only touches contacts idle 7+ days", () => {
  const doc = {
    ...fixtureDoc(),
    contacts: {
      stale: { reliabilityScore: 80, interactionCount: 5, flakeCount: 0, lowballRatio: 0, goodDealCount: 1, firstSeen: "2026-08-01T00:00:00Z", lastSeen: "2026-09-13T00:00:00Z", notes: [] },
      fresh: { reliabilityScore: 80, interactionCount: 5, flakeCount: 0, lowballRatio: 0, goodDealCount: 1, firstSeen: "2026-08-01T00:00:00Z", lastSeen: "2026-09-25T00:00:00Z", notes: [] },
      neutral: { reliabilityScore: 50, interactionCount: 2, flakeCount: 0, lowballRatio: 0, goodDealCount: 0, firstSeen: "2026-08-01T00:00:00Z", lastSeen: "2026-08-01T00:00:00Z", notes: [] },
    },
  };
  const { doc: d2, decayed } = decayTrust(doc, NOW);
  assert.equal(decayed.length, 1);
  assert.equal(decayed[0].id, "stale");
  assert.equal(decayed[0].weeksInactive, 2);
  assert.equal(d2.contacts["stale"].reliabilityScore, 74.3);
  assert.equal(d2.contacts["fresh"].reliabilityScore, 80, "6 days idle → untouched");
  assert.equal(d2.contacts["neutral"].reliabilityScore, 50, "neutral never moves");
});

// ---------- Price reference tool ----------

test("priceReferenceCard computes avg/median/low/high/n", () => {
  const stats = priceReferenceCard([{ price: 30 }, { price: 40 }, { price: 35 }, { price: 100 }]);
  assert.equal(stats.n, 4);
  assert.equal(stats.avg, 51.25);
  assert.equal(stats.median, 37.5);
  assert.equal(stats.low, 30);
  assert.equal(stats.high, 100);
});

test("priceReferenceCard with no comps is an honest empty card", () => {
  const stats = priceReferenceCard([]);
  assert.deepEqual(stats, { avg: 0, median: 0, low: 0, high: 0, n: 0 });
});

test("buildCardFromComps stamps the 25-mile Highland Village basis", () => {
  const card = buildCardFromComps("Sony WH-1000XM4", [{ price: 100 }, { price: 120 }]);
  assert.equal(card.radiusMiles, 25);
  assert.equal(card.n, 2);
  assert.match(card.basis, /25 mi of Highland Village area/);
  assert.ok(!card.basis.includes("Westcreek"), "no street address anywhere");
});

test("buildPriceCard works off the stub source with no network", async () => {
  const source = stubCompSource([{ price: 50, title: "Lamp A" }, { price: 60, title: "Lamp B" }]);
  const card = await buildPriceCard(source, "lamp");
  assert.equal(card.n, 2);
  assert.equal(card.avg, 55);
  assert.match(formatPriceCard(card), /avg \$55/);
});

test("formatPriceCard says so when the card is empty", () => {
  assert.match(formatPriceCard(buildCardFromComps("lamp", [])), /no comps/);
});

// ---------- Inventory readout ----------

test("formatInventory groups items, services, and hunts by status", () => {
  const doc = {
    ...fixtureDoc(),
    inventory: {
      items: [
        { id: "i1", name: "Sony WH-1000XM4", status: "active" as const, listPrice: 120, createdAt: NOW, updatedAt: NOW },
        { id: "i2", name: "BISSELL Little Green", status: "sold" as const, listPrice: 25, soldPrice: 25, createdAt: NOW, updatedAt: NOW },
      ],
      services: [
        { id: "s1", name: "Cleaning: 2BR deep clean", status: "requested" as const, serviceType: "cleaning" as const, quotesReceived: 0, createdAt: NOW, updatedAt: NOW },
      ],
      hunts: [
        { id: "h1", name: "Magic Keyboard", status: "active" as const, criteria: "apple magic keyboard", ceiling: 60, createdAt: NOW, updatedAt: NOW },
        { id: "h2", name: "Tint", status: "killed" as const, criteria: "tesla tint", createdAt: NOW, updatedAt: NOW },
      ],
    },
  };
  const out = formatInventory(doc);
  assert.match(out, /ITEMS FOR SALE \(2\)/);
  assert.match(out, /\[active\] Sony WH-1000XM4 — \$120/);
  assert.match(out, /\[sold\] BISSELL Little Green — sold \$25/);
  assert.match(out, /SERVICE REQUESTS \(1\)/);
  assert.match(out, /\[requested\] Cleaning: 2BR deep clean — 0 quote\(s\)/);
  assert.match(out, /WANTED-ITEM HUNTS \(2\)/);
  assert.match(out, /\[active\] Magic Keyboard — ceiling \$60/);
  assert.match(out, /\[killed\] Tint/);
});

test("formatInventory handles an empty inventory", () => {
  const out = formatInventory(fixtureDoc());
  assert.match(out, /ITEMS FOR SALE \(0\)/);
  assert.match(out, /\(none\)/);
});

// ---------- Analytics summary ----------

test("formatLearningSummary covers sales, openers, kills, and providers", () => {
  const doc = {
    ...fixtureDoc(),
    learning: {
      ...fixtureDoc().learning,
      pricingHistory: [
        { itemId: "a", listPrice: 100, finalPrice: 90, soldAt: NOW, daysToClose: 10 },
        { itemId: "b", listPrice: 50, finalPrice: 50, soldAt: NOW, daysToClose: 4 },
      ],
      negotiationOutcomes: {
        o1: { contactId: "c1", outcome: "closed" as const, openerPct: 75, at: NOW },
        o2: { contactId: "c2", outcome: "walked-away" as const, openerPct: 75, at: NOW },
        o3: { contactId: "c3", outcome: "closed" as const, openerPct: 95, at: NOW },
      },
      huntKills: [
        { huntName: "k1", criteria: "keyboard", reason: "overpriced" as const, at: NOW },
        { huntName: "k2", criteria: "tint", reason: "flakes" as const, at: NOW },
        { huntName: "k3", criteria: "mouse", reason: "overpriced" as const, at: NOW },
      ],
      providerTrust: { "yohan-le": { score: 4.5, jobs: 2 } },
    },
  };
  const out = formatLearningSummary(doc);
  assert.match(out, /SALES: 2 recorded/);
  assert.match(out, /avg days-to-close: 7\.0/);
  assert.match(out, /avg final-vs-list: 95%/);
  assert.match(out, /opener 70–79%: 1\/2 closed \(50%\)/);
  assert.match(out, /opener 90–99%: 1\/1 closed \(100%\)/);
  assert.match(out, /HUNT KILLS: 3 recorded/);
  assert.match(out, /overpriced: 2/);
  assert.match(out, /flakes: 1/);
  assert.match(out, /PROVIDER RATINGS: 1 provider\(s\) rated/);
  assert.match(out, /yohan-le: avg 4\.50 \(2 job\(s\)\)/);
});
