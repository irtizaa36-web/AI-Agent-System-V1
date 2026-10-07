import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryMarketplaceStorage, MarketplaceState, seedDocument } from "./state";
import { stageMessage, flushOutbox, recordSent, autoSendable, HARD_STOP_KINDS } from "./outbox";
import { evaluateLadders, applyDueDrops, isLiveListingStatus } from "./selling/ladder";
import { scoreContact, prefilterLead, StubTrustSignalProvider, PREFILTER_DECLINE_THRESHOLD } from "./selling/prefilter";
import type { Lead, Listing, TrackerDocument } from "./types";

const NOW = "2026-09-27T05:00:00Z";

// ---------- fixtures (hand-written, never the real seed) ----------

function fixtureDoc(): TrackerDocument {
  return {
    version: 3,
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
    learning: { pricingHistory: [], approvalPatterns: {}, negotiationOutcomes: {}, contactTrustScores: {}, huntKills: [], providerTrust: {} },
    inventory: { items: [], services: [], hunts: [] },
    updatedAt: NOW,
  };
}

function fixtureListing(over: Partial<Listing> = {}): Listing {
  return {
    id: "lamp",
    kind: "sale",
    title: "Fixture Lamp",
    price: 40,
    priceFirm: true,
    payment: "cash",
    meetup: "Fixture Public Spot",
    status: "active",
    monitoring: true,
    holdTimeoutHours: 24,
    createdAt: "2026-09-10T05:00:00Z",
    updatedAt: "2026-09-10T05:00:00Z",
    ...over,
  };
}

function fixtureLead(over: Partial<Lead> = {}): Lead {
  return {
    id: "buyer-1",
    listingId: "lamp",
    name: "Buyer One",
    threadId: "thread-1",
    channel: "messenger",
    status: "new",
    queuePosition: 1,
    firstSeenAt: NOW,
    lastContactAt: NOW,
    needsAgentFollowUp: true,
    awaiting: "them",
    nudgeLevel: 0,
    notes: [],
    ...over,
  };
}

function ladderListing(createdAt: string, drops: readonly { dayOffset: number; price: number }[], floor: number, over: Partial<Listing> = {}) {
  return fixtureListing({
    createdAt,
    priceLadder: { drops, floor, approvedAt: "2026-09-10T05:00:00Z", appliedDrops: [] },
    ...over,
  });
}

// ---------- price ladders ----------

test("ladder: drops due once their day offset elapses", () => {
  // 17 days old — both the day-7 and day-14 drops are due.
  const doc = { ...fixtureDoc(), listings: [ladderListing("2026-09-10T05:00:00Z", [{ dayOffset: 7, price: 35 }, { dayOffset: 14, price: 30 }], 30)] };
  const due = evaluateLadders(doc, NOW);
  assert.equal(due.length, 1);
  assert.deepEqual(due[0].drops.map((d) => d.dayOffset), [7, 14], "oldest-due-first");
  assert.deepEqual(due[0].drops.map((d) => d.price), [35, 30]);
});

test("ladder: nothing due before the first day offset", () => {
  // 2 days old — day-7 drop not yet due.
  const doc = { ...fixtureDoc(), listings: [ladderListing("2026-09-25T05:00:00Z", [{ dayOffset: 7, price: 35 }], 30)] };
  assert.deepEqual(evaluateLadders(doc, NOW), []);
});

test("ladder: unapproved schedules never execute", () => {
  const listing = ladderListing("2026-09-10T05:00:00Z", [{ dayOffset: 7, price: 35 }], 30);
  const unapproved = { ...listing, priceLadder: { ...listing.priceLadder!, approvedAt: undefined } };
  const doc = { ...fixtureDoc(), listings: [unapproved] };
  assert.deepEqual(evaluateLadders(doc, NOW), []);
});

test("ladder: sold/paused listings are skipped", () => {
  const doc = {
    ...fixtureDoc(),
    listings: [ladderListing("2026-09-10T05:00:00Z", [{ dayOffset: 7, price: 35 }], 30, { status: "sold" })],
  };
  assert.deepEqual(evaluateLadders(doc, NOW), []);
});

test("ladder: applyDueDrops reprices, flips status, logs, mirrors inventory — and is idempotent", () => {
  const doc = {
    ...fixtureDoc(),
    listings: [ladderListing("2026-09-10T05:00:00Z", [{ dayOffset: 7, price: 35 }, { dayOffset: 14, price: 30 }], 30)],
    inventory: {
      items: [
        {
          id: "inv-1", name: "Fixture Lamp", status: "active" as const, listPrice: 40,
          listingId: "lamp", createdAt: "2026-09-10T05:00:00Z", updatedAt: "2026-09-10T05:00:00Z",
        },
      ],
      services: [],
      hunts: [],
    },
  };
  const { doc: d2, applied } = applyDueDrops(doc, NOW);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].from, 40);
  assert.equal(applied[0].to, 30);
  const listing = d2.listings[0];
  assert.equal(listing.price, 30);
  assert.equal(listing.status, "price-dropped");
  assert.ok(isLiveListingStatus(listing.status));
  assert.deepEqual(listing.priceLadder!.appliedDrops, [7, 14]);
  assert.ok(d2.activity.some((a) => a.kind === "listing" && a.text.includes("Price ladder") && a.text.includes("$40 → $30")));
  const item = d2.inventory.items[0];
  assert.equal(item.listPrice, 30);
  assert.equal(item.status, "price-dropped");
  // Second run applies nothing — the appliedDrops record makes it idempotent.
  const second = applyDueDrops(d2, NOW);
  assert.equal(second.applied.length, 0);
  assert.equal(second.doc.listings[0].price, 30);
});

test("ladder: drops never cross the floor (clamped, not skipped)", () => {
  const doc = { ...fixtureDoc(), listings: [ladderListing("2026-09-10T05:00:00Z", [{ dayOffset: 7, price: 35 }, { dayOffset: 14, price: 25 }], 30)] };
  const { doc: d2, applied } = applyDueDrops(doc, NOW);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].to, 30, "day-14 drop of $25 clamped to the $30 floor");
  assert.ok(d2.listings[0].price >= 30);
});

// ---------- pre-filtering ----------

test("prefilter: stub provider returns all-unknown signals and does no network", async () => {
  const signals = await StubTrustSignalProvider.getSignals("contact-1", "thread-1");
  assert.deepEqual(signals, {});
  const { score } = scoreContact(signals);
  assert.equal(score, 50, "unknown signals stay neutral");
});

test("prefilter: weights punish fresh/spammy contacts and reward established ones", () => {
  assert.equal(scoreContact({ accountAgeDays: 3, crossPostCount: 8, stockPhotoSuspect: true }).score, 0);
  const good = scoreContact({ accountAgeDays: 800, verifiedBadge: true });
  assert.equal(good.score, 80);
  assert.ok(good.reasons.some((r) => r.includes("≥ 2y")));
  const anomaly = scoreContact({ accountAgeDays: 400, priceAnomaly: 1 });
  assert.equal(anomaly.score, 50 + 15 - 30);
});

test("prefilter: score < 40 auto-declines with a routine-tier decline message", () => {
  const doc = { ...fixtureDoc(), listings: [fixtureListing()], leads: [fixtureLead()] };
  const { doc: d2, score, declined } = prefilterLead(
    doc, "buyer-1", { accountAgeDays: 2, crossPostCount: 10, stockPhotoSuspect: true }, NOW,
  );
  assert.ok(score < PREFILTER_DECLINE_THRESHOLD);
  assert.equal(declined, true);
  const lead = d2.leads[0];
  assert.equal(lead.status, "dead");
  assert.equal(lead.trustScore, score);
  assert.ok(lead.notes.some((n) => n.includes("Auto-declined")));
  assert.ok(d2.activity.some((a) => a.text.includes("Auto-declined") && a.text.includes(`trust ${score}`)));
  const decline = d2.outbox.find((m) => m.leadId === "buyer-1");
  assert.ok(decline, "a decline message is staged");
  assert.equal(decline!.kind, "close-out");
  assert.equal(decline!.sendAuthority, "routine", "declines ride on standing authority");
  assert.ok(autoSendable(decline!), "decline must actually auto-send on flush");
  assert.equal(d2.learning.contactTrustScores["buyer one"], score);
});

test("prefilter: score >= 40 records the score and continues the normal flow", () => {
  const doc = { ...fixtureDoc(), listings: [fixtureListing()], leads: [fixtureLead()] };
  const { doc: d2, score, declined } = prefilterLead(
    doc, "buyer-1", { accountAgeDays: 400, verifiedBadge: true }, NOW,
  );
  assert.ok(score >= PREFILTER_DECLINE_THRESHOLD);
  assert.equal(declined, false);
  const lead = d2.leads[0];
  assert.equal(lead.status, "new", "lead untouched");
  assert.equal(lead.trustScore, score);
  assert.ok(lead.trustReasons && lead.trustReasons.length > 0);
  assert.equal(d2.outbox.length, 0, "no decline staged");
  assert.equal(d2.learning.contactTrustScores["buyer one"], score);
});

test("prefilter: unknown lead throws", () => {
  assert.throws(() => prefilterLead(fixtureDoc(), "nope", {}, NOW), /Unknown lead/);
});

// ---------- standing send authority ----------

function stagedRoutineReply(doc: TrackerDocument) {
  return stageMessage(doc, {
    kind: "reply", channel: "messenger", threadId: "t1", recipient: "A", body: "hi A",
    sendAuthority: "routine",
  }, NOW);
}

test("flush: routine/auto tiers auto-send; per_message waits for the tap", () => {
  let doc = fixtureDoc();
  ({ doc } = stagedRoutineReply(doc));
  ({ doc } = stageMessage(doc, {
    kind: "nudge", channel: "messenger", threadId: "t2", recipient: "B", body: "nudge B",
    sendAuthority: "auto",
  }, NOW));
  ({ doc } = stageMessage(doc, {
    kind: "reply", channel: "messenger", threadId: "t3", recipient: "C", body: "hi C",
    sendAuthority: "per_message",
  }, NOW));
  const { doc: d2, spurt, autoSent } = flushOutbox(doc, NOW);
  assert.equal(autoSent.length, 2, "routine + auto dispatch under standing authority");
  assert.ok(autoSent.every((m) => m.status === "sent" && m.sentAt === NOW && m.body.length > 0), "sentAt recorded, body kept for audit");
  assert.equal(spurt.length, 1, "only the per_message card awaits his tap");
  assert.equal(spurt[0].recipient, "C");
  assert.ok(d2.outbox.every((m) => m.status !== "pending"));
});

test("flush: hard-stop kinds NEVER auto-send, regardless of tier", () => {
  let doc = fixtureDoc();
  const hardStops = [
    { kind: "confirmation" as const, tier: "routine" as const },   // price commitment + post-acceptance pickup
    { kind: "booking" as const, tier: "auto" as const },            // rental booking commit
    { kind: "sms-draft" as const, tier: "auto" as const },         // Voice SMS stays drafts-only
    { kind: "confirmation" as const, tier: "auto" as const },      // belt and suspenders
  ];
  for (const [i, h] of hardStops.entries()) {
    ({ doc } = stageMessage(doc, {
      kind: h.kind, channel: "messenger", threadId: `h${i}`, recipient: "Z", body: `hard stop ${i}`,
      sendAuthority: h.tier,
    }, NOW));
  }
  const { spurt, autoSent } = flushOutbox(doc, NOW);
  assert.equal(autoSent.length, 0, "no hard-stop kind auto-sends");
  assert.equal(spurt.length, 4, "every hard-stop message waits for his tap");
  assert.ok(spurt.every((m) => HARD_STOP_KINDS.has(m.kind)));
});

test("recordSent: taps feed the approval-window learning stats", () => {
  let doc = fixtureDoc();
  ({ doc } = stageMessage(doc, {
    kind: "reply", channel: "messenger", threadId: "t1", recipient: "A", body: "hi A",
    sendAuthority: "per_message",
  }, "2026-09-27T04:00:00Z"));
  const flushed = flushOutbox(doc, NOW);
  assert.equal(flushed.spurt.length, 1);
  const d2 = recordSent(flushed.doc, [flushed.spurt[0].id], NOW);
  const stats = d2.learning.approvalPatterns["global"];
  assert.ok(stats, "tap recorded into learning.approvalPatterns");
  assert.equal(stats.tapCount, 1);
  assert.equal(stats.lastTapAt, NOW);
  assert.equal(stats.avgTapDelayMinutes, 60, "staged 04:00, tapped 05:00");
  assert.equal(d2.outbox[0].status, "sent");
  assert.equal(d2.outbox[0].sentAt, NOW);
});

// ---------- v1-seeded doc still loads ----------

test("v1: a v1-shaped doc still loads and migrates to v3", async () => {
  const v1 = {
    version: 1,
    listings: [
      {
        id: "fixture-lamp", kind: "sale", title: "Fixture Lamp", price: 40,
        priceFirm: true, payment: "cash", meetup: "Fixture Public Spot",
        status: "active", monitoring: true, holdTimeoutHours: 24,
        createdAt: NOW, updatedAt: NOW,
      },
    ],
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
    updatedAt: NOW,
  };
  const storage = new InMemoryMarketplaceStorage(v1 as unknown as TrackerDocument);
  const doc = (await storage.load())!;
  assert.equal(doc.version, 3);
  assert.equal(doc.listings[0].id, "fixture-lamp");
  assert.deepEqual(doc.learning.approvalPatterns, {});
  assert.deepEqual(doc.inventory, { items: [], services: [], hunts: [] });
});

test("seed: the real seed document still opens cleanly on the v3 branch", async () => {
  const storage = new InMemoryMarketplaceStorage();
  const state = await MarketplaceState.open(storage, { seed: () => seedDocument(NOW), now: () => NOW });
  assert.equal(state.document.version, 3);
  assert.ok(state.document.listings.length > 0);
});
