import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemoryMarketplaceStorage, MarketplaceState, seedDocument } from "./state";
import { stageMessage } from "./outbox";
import { leadSendAuthority, type TrackerDocument } from "./types";

const NOW = "2026-09-27T05:00:00Z";

/** Minimal hand-written v1-shaped doc: every v1 field, none of the v3 ones. Fixture data only. */
function v1Fixture(): Record<string, unknown> {
  return {
    version: 1,
    listings: [
      {
        id: "fixture-lamp", kind: "sale", title: "Fixture Lamp", price: 40,
        priceFirm: true, payment: "cash", meetup: "Fixture Public Spot",
        status: "active", monitoring: true, holdTimeoutHours: 24,
        createdAt: NOW, updatedAt: NOW,
      },
    ],
    leads: [
      {
        id: "fixture-buyer", listingId: "fixture-lamp", name: "Fixture Buyer",
        threadId: "fixture-thread-1", channel: "messenger", status: "contacted",
        queuePosition: 1, firstSeenAt: NOW, lastContactAt: NOW,
        needsAgentFollowUp: true, awaiting: "them", nudgeLevel: 0, notes: [],
      },
    ],
    campaigns: [
      {
        id: "fixture-hunt", name: "fixture-hunt", status: "active",
        criteria: "fixture criteria", threads: [], createdAt: NOW, updatedAt: NOW,
        // offers[] deliberately omitted — v1 predates it.
      },
    ],
    constraints: [],
    authority: [],
    outbox: [
      {
        id: "fixture-msg-1", kind: "reply", channel: "messenger",
        threadId: "fixture-thread-1", recipient: "Fixture Buyer",
        body: "hi, still available", stagedAt: NOW, status: "pending",
        // sendAuthority deliberately omitted — v1 predates it.
      },
    ],
    bookings: [],
    seenEvents: [],
    buyers: {},
    watermarks: {},
    summaries: {},
    activity: [{ at: NOW, kind: "system", text: "fixture seed" }],
    updatedAt: NOW,
  };
}

// ---------- seed ----------

test("v3: seed document contains all new stores, empty", () => {
  const doc = seedDocument(NOW);
  assert.equal(doc.version, 3);
  assert.deepEqual(doc.serviceRequests, []);
  assert.deepEqual(doc.contacts, {});
  assert.deepEqual(doc.learning, {
    pricingHistory: [],
    approvalPatterns: {},
    negotiationOutcomes: {},
    contactTrustScores: {},
    huntKills: [],
    providerTrust: {},
    approvalTaps: [],
    relistSightings: {},
  });
  assert.deepEqual(doc.inventory, { items: [], services: [], hunts: [] });
});

test("v3: seed keeps existing v2 seed data untouched", () => {
  const doc = seedDocument(NOW);
  assert.ok(doc.listings.some((l) => l.id === "chair" && l.price === 90));
  assert.ok(doc.listings.some((l) => l.id === "bissell"));
  assert.equal(doc.leads.length, 9);
  assert.ok(doc.leads.some((l) => l.id === "ethan" && l.status === "confirmed"));
  assert.ok(doc.campaigns.some((c) => c.name === "keyboard-mouse" && c.status === "cancelled"));
  assert.equal(doc.constraints.length, 1);
  assert.equal(doc.authority.length, 3);
});

// ---------- v1 migration ----------

test("v3: a v1-shaped doc migrates cleanly with defaults", async () => {
  // The constructor stores the fixture as-is; validation runs on load().
  const storage = new InMemoryMarketplaceStorage(v1Fixture() as unknown as TrackerDocument);
  const doc = (await storage.load())!;
  assert.equal(doc.version, 3, "migration stamps v3 after load");
  assert.deepEqual(doc.serviceRequests, []);
  assert.deepEqual(doc.contacts, {});
  assert.deepEqual(doc.learning.pricingHistory, []);
  assert.deepEqual(doc.learning.approvalPatterns, {});
  assert.deepEqual(doc.learning.negotiationOutcomes, {});
  assert.deepEqual(doc.learning.contactTrustScores, {});
  assert.deepEqual(doc.inventory, { items: [], services: [], hunts: [] });
  // Existing v1 content survives the migration.
  assert.equal(doc.listings[0].id, "fixture-lamp");
  assert.equal(doc.leads[0].id, "fixture-buyer");
  assert.deepEqual(doc.campaigns[0].offers, [], "offers[] backfill still applies");
  assert.equal(doc.activity[0].text, "fixture seed");
});

test("v3: migration never grants more authority than v1 allowed", async () => {
  const storage = new InMemoryMarketplaceStorage(v1Fixture() as unknown as TrackerDocument);
  const doc = (await storage.load())!;
  assert.equal(doc.outbox[0].sendAuthority, "per_message", "missing tier ⇒ most restrictive");
  assert.equal(leadSendAuthority(doc.leads[0]), "per_message", "lead without tier ⇒ per_message");
});

test("v3: explicit v3 authority tiers survive validation untouched", async () => {
  const doc = seedDocument(NOW);
  const staged = stageMessage(doc, {
    kind: "reply", channel: "messenger", threadId: "t1",
    recipient: "Fixture Buyer", body: "auto-tier test", sendAuthority: "auto",
  }, NOW);
  const storage = new InMemoryMarketplaceStorage(staged.doc);
  const loaded = (await storage.load())!;
  assert.equal(loaded.outbox[0].sendAuthority, "auto");
});

// ---------- round-trips ----------

test("v3: price ladder round-trips through save/load", async () => {
  const doc = seedDocument(NOW);
  const ladder = {
    drops: [
      { dayOffset: 7, price: 85 },
      { dayOffset: 14, price: 80 },
    ],
    floor: 75,
    approvedAt: NOW,
  };
  const d2: TrackerDocument = {
    ...doc,
    listings: doc.listings.map((l) => (l.id === "chair" ? { ...l, priceLadder: ladder } : l)),
  };
  const storage = new InMemoryMarketplaceStorage();
  const state = await MarketplaceState.open(storage, { seed: () => d2, now: () => NOW });
  const loaded = (await storage.load())!;
  assert.deepEqual(loaded.listings.find((l) => l.id === "chair")!.priceLadder, ladder);
  assert.equal(loaded.version, 3);
  assert.deepEqual(state.document.listings.find((l) => l.id === "chair")!.priceLadder, ladder);
});

test("v3: lead sendAuthority persists and defaults when absent", async () => {
  const doc = seedDocument(NOW);
  const d2: TrackerDocument = {
    ...doc,
    leads: [
      ...doc.leads,
      {
        id: "fixture-auto", listingId: "chair", name: "Fixture Auto",
        threadId: "fixture-thread-auto", channel: "messenger", status: "new",
        queuePosition: 9, firstSeenAt: NOW, lastContactAt: NOW,
        needsAgentFollowUp: true, awaiting: "them", nudgeLevel: 0,
        sendAuthority: "auto", notes: [],
      },
    ],
  };
  const storage = new InMemoryMarketplaceStorage(d2);
  const loaded = (await storage.load())!;
  const auto = loaded.leads.find((l) => l.id === "fixture-auto")!;
  assert.equal(auto.sendAuthority, "auto");
  assert.equal(leadSendAuthority(auto), "auto");
  const legacy = loaded.leads.find((l) => l.id === "kat")!;
  assert.equal(legacy.sendAuthority, undefined);
  assert.equal(leadSendAuthority(legacy), "per_message");
});

test("v3: service request + contact + inventory round-trip through save/load", async () => {
  const doc = seedDocument(NOW);
  const d2: TrackerDocument = {
    ...doc,
    serviceRequests: [
      {
        id: "sr-fixture", serviceType: "home", specs: "mount a 65-inch TV",
        budgetCeiling: 120, timingWindow: "weekday evenings", status: "quoted",
        quotes: [
          { providerId: "p1", providerName: "Fixture Mounts", amount: 90, notes: "evenings ok", at: NOW },
          { providerId: "p2", providerName: "Fixture Handyman", amount: 110, notes: "", at: NOW },
        ],
        screenedProviders: ["Fixture Mounts"],
        references: [],
        lastQuoteActivityAt: NOW,
        createdAt: NOW, updatedAt: NOW,
      },
    ],
    contacts: {
      "fb-fixture-1": {
        reliabilityScore: 50, interactionCount: 1, flakeCount: 0,
        lowballRatio: 0, goodDealCount: 0, firstSeen: NOW, lastSeen: NOW,
        notes: ["first inbound on fixture-lamp"],
      },
    },
    inventory: {
      items: [
        {
          id: "inv-lamp", name: "Fixture Lamp", status: "active",
          listPrice: 40, listingId: "fixture-lamp", createdAt: NOW, updatedAt: NOW,
        },
      ],
      services: [
        {
          id: "inv-sr", name: "TV mounting", status: "quoted",
          serviceType: "home", quotesReceived: 2, serviceRequestId: "sr-fixture",
          createdAt: NOW, updatedAt: NOW,
        },
      ],
      hunts: [
        {
          id: "inv-hunt", name: "fixture-wanted", status: "active",
          criteria: "fixture criteria", ceiling: 60, createdAt: NOW, updatedAt: NOW,
        },
      ],
    },
  };
  const storage = new InMemoryMarketplaceStorage();
  await storage.save(d2);
  const loaded = (await storage.load())!;
  assert.equal(loaded.serviceRequests[0].quotes.length, 2);
  assert.equal(loaded.serviceRequests[0].quotes[0].amount, 90);
  assert.equal(loaded.contacts["fb-fixture-1"].reliabilityScore, 50);
  assert.equal(loaded.inventory.items[0].status, "active");
  assert.equal(loaded.inventory.services[0].quotesReceived, 2);
  assert.equal(loaded.inventory.hunts[0].ceiling, 60);
});

test("v3: learning store accumulates outcome records", async () => {
  const doc = seedDocument(NOW);
  const d2: TrackerDocument = {
    ...doc,
    learning: {
      pricingHistory: [
        { itemId: "inv-lamp", listPrice: 40, finalPrice: 35, soldAt: NOW, daysToClose: 6 },
      ],
      approvalPatterns: {
        "evening": { windowDays: 14, tapCount: 12, avgTapDelayMinutes: 47, lastTapAt: NOW },
      },
      negotiationOutcomes: {
        "fb-fixture-1:fixture-hunt": {
          contactId: "fb-fixture-1", huntId: "fixture-hunt",
          outcome: "closed", finalAmount: 55, at: NOW,
        },
      },
      contactTrustScores: { "fb-fixture-1": 72 },
      huntKills: [],
      providerTrust: { "fixture-cleaner": { score: 4.5, jobs: 2, lastRating: 5 } },
    },
  };
  const storage = new InMemoryMarketplaceStorage(d2);
  const loaded = (await storage.load())!;
  assert.equal(loaded.learning.pricingHistory[0].finalPrice, 35);
  assert.equal(loaded.learning.approvalPatterns["evening"].avgTapDelayMinutes, 47);
  assert.equal(loaded.learning.negotiationOutcomes["fb-fixture-1:fixture-hunt"].outcome, "closed");
  assert.equal(loaded.learning.contactTrustScores["fb-fixture-1"], 72);
  assert.equal(loaded.learning.providerTrust["fixture-cleaner"].jobs, 2);
});
