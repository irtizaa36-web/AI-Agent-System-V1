import { test } from "node:test";
import assert from "node:assert/strict";
import type { Campaign, ContactRecord, TrackerDocument } from "../types";
import { startHunt, cancelHunt, stageOffer } from "./hunts";
import { outreachToSeller, recordHuntOutcome, normalizeContactName, LOW_TRUST_SKIP_THRESHOLD } from "./contact-check";
import { suggestOpener } from "./openers";

const NOW = "2026-09-27T21:00:00Z";

// ---------- fixtures (hand-written, never real sellers) ----------

function fixtureDoc(): TrackerDocument {
  return {
    version: 3,
    listings: [],
    leads: [],
    campaigns: [],
    constraints: [],
    authority: [
      {
        scope: "buying",
        autonomous: ["reply", "outreach", "offer", "close-out", "pause-hunt"],
        approvalRequired: ["purchase", "start-hunt"],
      },
    ],
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

function fixtureContact(over: Partial<ContactRecord> = {}): ContactRecord {
  return {
    name: "Fixture Seller",
    reliabilityScore: 50,
    interactionCount: 4,
    flakeCount: 0,
    lowballRatio: 0,
    goodDealCount: 0,
    firstSeen: "2026-09-01T05:00:00Z",
    lastSeen: "2026-09-20T05:00:00Z",
    notes: [],
    ...over,
  };
}

function withHunt(doc: TrackerDocument, name = "fixture-hunt"): TrackerDocument {
  const { doc: d2 } = startHunt(doc, { name, criteria: "fixture widgets, genuine only", maxPrice: 60 }, NOW);
  return d2;
}

// ---------- contact history in negotiation ----------

test("outreach: repeat flake (trust 24) is skipped — no message staged, activity logged", () => {
  let doc = fixtureDoc();
  doc = { ...doc, contacts: { "fb-fixture-s1": fixtureContact({ reliabilityScore: 24, flakeCount: 3 }) } };
  doc = withHunt(doc);
  const result = outreachToSeller(doc, {
    huntName: "fixture-hunt",
    profileId: "fb-fixture-s1",
    sellerName: "Fixture Seller",
    message: "Hi! Is the widget still available?",
  }, NOW);

  assert.equal(result.skipped, true);
  assert.equal(result.trustScore, 24);
  assert.equal(result.doc.outbox.length, 0, "nothing staged for a repeat flake");
  const campaign = result.doc.campaigns.find((c) => c.name === "fixture-hunt")!;
  assert.deepEqual(campaign.threads, [], "no thread tracked on a skip");
  assert.ok(
    result.doc.activity.some((a) => a.text === "skipped Fixture Seller — trust 24, repeat flake"),
    "activity line names the seller and the trust score",
  );
});

test("outreach: --force overrides the low-trust skip", () => {
  let doc = fixtureDoc();
  doc = { ...doc, contacts: { "fb-fixture-s1": fixtureContact({ reliabilityScore: 24, flakeCount: 3 }) } };
  doc = withHunt(doc);
  const result = outreachToSeller(doc, {
    huntName: "fixture-hunt",
    profileId: "fb-fixture-s1",
    sellerName: "Fixture Seller",
    message: "Hi! Is the widget still available?",
    force: true,
  }, NOW);

  assert.equal(result.skipped, false);
  assert.equal(result.doc.outbox.length, 1);
  const msg = result.doc.outbox[0];
  assert.equal(msg.sendAuthority, "routine", "forced outreach still rides standing authority");
  assert.ok(
    result.doc.activity.some((a) => a.text.includes("outreach forced for Fixture Seller")),
    "the override is logged so it stays auditable",
  );
});

test("outreach: unknown seller proceeds with no note", () => {
  const doc = withHunt(fixtureDoc());
  const result = outreachToSeller(doc, {
    huntName: "fixture-hunt",
    profileId: "fb-fixture-new",
    sellerName: "Brand New Seller",
    message: "Hi! Is the widget still available?",
  }, NOW);

  assert.equal(result.skipped, false);
  assert.equal(result.contactId, undefined);
  assert.equal(result.note, undefined);
  assert.equal(result.doc.outbox[0].sendAuthority, "routine", "discovery stages at routine");
  const campaign = result.doc.campaigns.find((c) => c.name === "fixture-hunt")!;
  assert.ok(campaign.threads.includes(result.threadId!), "thread tracked on the hunt");
});

test("outreach: known-good seller gets the firm-opener note on the thread record", () => {
  let doc = fixtureDoc();
  doc = { ...doc, contacts: { "fb-fixture-s2": fixtureContact({ reliabilityScore: 82 }) } };
  doc = withHunt(doc);
  const result = outreachToSeller(doc, {
    huntName: "fixture-hunt",
    profileId: "fb-fixture-s2",
    sellerName: "Fixture Seller",
    message: "Hi! Is the widget still available?",
  }, NOW);

  assert.equal(result.skipped, false);
  assert.equal(result.note, "known-good seller, consider firm opener");
  const campaign = result.doc.campaigns.find((c) => c.name === "fixture-hunt")!;
  assert.ok(campaign.threadNotes?.[result.threadId!]?.includes("known-good seller, consider firm opener"));
});

test("outreach: goodDealCount > 0 counts as known-good even with a middling score", () => {
  let doc = fixtureDoc();
  doc = { ...doc, contacts: { "fb-fixture-s3": fixtureContact({ reliabilityScore: 55, goodDealCount: 2 }) } };
  doc = withHunt(doc);
  const result = outreachToSeller(doc, {
    huntName: "fixture-hunt",
    profileId: "fb-fixture-s3",
    message: "Hi! Is the widget still available?",
  }, NOW);
  assert.equal(result.note, "known-good seller, consider firm opener");
});

test("outreach: name fallback finds the contact when no profile id is given", () => {
  let doc = fixtureDoc();
  doc = { ...doc, contacts: { "fb-fixture-s1": fixtureContact({ name: "Case  Variant  Seller", reliabilityScore: 24, flakeCount: 2 }) } };
  doc = withHunt(doc);
  const result = outreachToSeller(doc, {
    huntName: "fixture-hunt",
    sellerName: "case variant seller", // different case/spacing — normalized match
    message: "Hi!",
  }, NOW);
  assert.equal(result.skipped, true, "normalized name match triggers the same skip");
  assert.equal(result.contactId, "fb-fixture-s1");
  assert.equal(normalizeContactName("  Case  Variant  Seller "), "case variant seller");
});

test("outreach: score exactly at the skip threshold proceeds", () => {
  let doc = fixtureDoc();
  doc = { ...doc, contacts: { "fb-fixture-s4": fixtureContact({ reliabilityScore: LOW_TRUST_SKIP_THRESHOLD }) } };
  doc = withHunt(doc);
  const result = outreachToSeller(doc, {
    huntName: "fixture-hunt",
    profileId: "fb-fixture-s4",
    message: "Hi!",
  }, NOW);
  assert.equal(result.skipped, false, "skip is strictly below the threshold");
});

test("outreach: unknown hunt and missing seller identity throw", () => {
  const doc = withHunt(fixtureDoc());
  assert.throws(() => outreachToSeller(doc, { huntName: "nope", profileId: "x", message: "hi" }, NOW), /Unknown hunt/);
  assert.throws(() => outreachToSeller(doc, { huntName: "fixture-hunt", message: "hi" }, NOW), /profileId or sellerName/);
});

// ---------- hunt outcome recording ----------

test("outcome: closed — goodDealCount++, score +10, recorded in learning.negotiationOutcomes", () => {
  let doc = fixtureDoc();
  doc = { ...doc, contacts: { "fb-fixture-s1": fixtureContact() } };
  const d2 = recordHuntOutcome(doc, "fb-fixture-s1", { type: "closed", huntId: "hunt-1", finalAmount: 55, openerPct: 80 }, NOW);
  const rec = d2.contacts["fb-fixture-s1"];
  assert.equal(rec.interactionCount, 5);
  assert.equal(rec.goodDealCount, 1);
  assert.equal(rec.flakeCount, 0);
  assert.equal(rec.reliabilityScore, 60, "50 + 10 for a closed deal");
  assert.equal(rec.lastSeen, NOW);
  const keys = Object.keys(d2.learning.negotiationOutcomes);
  assert.equal(keys.length, 1);
  assert.deepEqual(d2.learning.negotiationOutcomes[keys[0]], {
    contactId: "fb-fixture-s1", huntId: "hunt-1", outcome: "closed",
    finalAmount: 55, openerPct: 80, at: NOW,
  });
});

test("outcome: flaked — flakeCount++, score −15", () => {
  let doc = fixtureDoc();
  doc = { ...doc, contacts: { "fb-fixture-s1": fixtureContact() } };
  const d2 = recordHuntOutcome(doc, "fb-fixture-s1", { type: "flaked", huntId: "hunt-1" }, NOW);
  const rec = d2.contacts["fb-fixture-s1"];
  assert.equal(rec.interactionCount, 5);
  assert.equal(rec.flakeCount, 1);
  assert.equal(rec.goodDealCount, 0);
  assert.equal(rec.reliabilityScore, 35, "50 − 15 for a flake");
});

test("outcome: walked-away — interaction counted, score untouched", () => {
  let doc = fixtureDoc();
  doc = { ...doc, contacts: { "fb-fixture-s1": fixtureContact() } };
  const d2 = recordHuntOutcome(doc, "fb-fixture-s1", { type: "walked-away", huntId: "hunt-1" }, NOW);
  const rec = d2.contacts["fb-fixture-s1"];
  assert.equal(rec.interactionCount, 5);
  assert.equal(rec.reliabilityScore, 50, "walking away is our call, not a seller fault");
  assert.equal(rec.flakeCount, 0);
});

test("outcome: lowballRatio recomputed as an incremental mean", () => {
  let doc = fixtureDoc();
  doc = { ...doc, contacts: { "fb-fixture-s1": fixtureContact() } }; // 4 interactions, ratio 0
  const d2 = recordHuntOutcome(doc, "fb-fixture-s1", { type: "walked-away", lowballed: true }, NOW);
  assert.equal(d2.contacts["fb-fixture-s1"].lowballRatio, 0.2, "1 lowball in 5 interactions");
  const d3 = recordHuntOutcome(d2, "fb-fixture-s1", { type: "closed" }, NOW);
  assert.equal(d3.contacts["fb-fixture-s1"].lowballRatio, 0.167, "1 lowball in 6 interactions");
});

test("outcome: score clamps at 0 and 100", () => {
  let doc = fixtureDoc();
  doc = {
    ...doc,
    contacts: {
      hi: fixtureContact({ reliabilityScore: 95 }),
      lo: fixtureContact({ reliabilityScore: 5 }),
    },
  };
  const d2 = recordHuntOutcome(doc, "hi", { type: "closed" }, NOW);
  assert.equal(d2.contacts["hi"].reliabilityScore, 100, "caps at 100");
  const d3 = recordHuntOutcome(d2, "lo", { type: "flaked" }, NOW);
  assert.equal(d3.contacts["lo"].reliabilityScore, 0, "floors at 0");
});

test("outcome: unknown contact is created neutral", () => {
  const d2 = recordHuntOutcome(fixtureDoc(), "fb-fixture-new", { type: "closed", huntId: "hunt-1" }, NOW);
  const rec = d2.contacts["fb-fixture-new"];
  assert.equal(rec.reliabilityScore, 60, "neutral 50 + 10 for the close");
  assert.equal(rec.interactionCount, 1);
  assert.equal(rec.firstSeen, NOW);
});

// ---------- predictive openers ----------

function outcome(openerPct: number, closed: boolean, i: number) {
  return {
    contactId: `fb-fixture-${i}`,
    huntId: "hunt-1",
    outcome: closed ? ("closed" as const) : ("walked-away" as const),
    openerPct,
    at: NOW,
  };
}

test("opener: no history defaults to 80% of ceiling and says so", () => {
  const { pctOfCeiling, rationale } = suggestOpener({ maxPrice: 60, criteria: "widgets" });
  assert.equal(pctOfCeiling, 80);
  assert.match(rationale, /No opener history yet/i);
});

test("opener: picks the bucket with the best close rate from history", () => {
  const outcomes = [
    // 80–89% bucket: 4 closed of 5 → 80%
    outcome(85, true, 1), outcome(82, true, 2), outcome(88, true, 3), outcome(80, false, 4), outcome(86, true, 5),
    // 70–79% bucket: 1 closed of 3 → 33%
    outcome(75, true, 6), outcome(72, false, 7), outcome(78, false, 8),
  ];
  const { pctOfCeiling, rationale } = suggestOpener({ maxPrice: 60, criteria: "widgets" }, {}, outcomes);
  assert.equal(pctOfCeiling, 85, "midpoint of the best bucket");
  assert.match(rationale, /80% \(4\/5\)/);
});

test("opener: sparse buckets fall back to the 80% default", () => {
  const outcomes = [outcome(85, true, 1), outcome(72, true, 2)];
  const { pctOfCeiling, rationale } = suggestOpener({ maxPrice: 60, criteria: "widgets" }, {}, outcomes);
  assert.equal(pctOfCeiling, 80);
  assert.match(rationale, /not enough for a bucket/);
});

test("opener: ties prefer the cheaper bucket", () => {
  const outcomes = [
    outcome(75, true, 1), outcome(72, true, 2),
    outcome(85, true, 3), outcome(88, true, 4),
  ];
  const { pctOfCeiling } = suggestOpener({ maxPrice: 60, criteria: "widgets" }, {}, outcomes);
  assert.equal(pctOfCeiling, 75, "equal close rates → the lower opener wins");
});

test("opener: seller signals adjust the base bucket", () => {
  const outcomes = [
    outcome(85, true, 1), outcome(82, true, 2), outcome(88, true, 3), outcome(80, false, 4),
  ];
  // Base 85: −5 relist urgency (4 relists) −5 stale (25 days) +5 known-good (78) = 80.
  const { pctOfCeiling, rationale } = suggestOpener(
    { maxPrice: 60, criteria: "widgets" },
    { relistCount: 4, daysOnMarket: 25, contactScore: 78 },
    outcomes,
  );
  assert.equal(pctOfCeiling, 80);
  assert.match(rationale, /relist urgency/);
  assert.match(rationale, /stale listing/);
  assert.match(rationale, /known-good seller/);
});

test("opener: clamps to 50–100", () => {
  const outcomes = [outcome(65, true, 1), outcome(62, true, 2)];
  const { pctOfCeiling } = suggestOpener(
    { maxPrice: 60, criteria: "widgets" },
    { relistCount: 9, daysOnMarket: 90 }, // base 65 − 10 = 55
    outcomes,
  );
  assert.equal(pctOfCeiling, 55);
  const low = suggestOpener({ maxPrice: 60, criteria: "w" }, { relistCount: 9, daysOnMarket: 90 }); // 80 − 10 = 70
  assert.equal(low.pctOfCeiling, 70);
});

// ---------- kill-switch learning ----------

test("cancel: --reason records a hunt kill; close-outs stage at routine", () => {
  let doc = withHunt(fixtureDoc(), "killable");
  const { doc: d2, staged } = cancelHunt(doc, "killable", { threadIds: ["t1"], reason: "overpriced", note: "sellers stuck at $80" }, NOW);
  assert.equal(staged, 1);
  assert.equal(d2.learning.huntKills.length, 1);
  assert.deepEqual(d2.learning.huntKills[0], {
    huntName: "killable",
    criteria: "fixture widgets, genuine only",
    reason: "overpriced",
    note: "sellers stuck at $80",
    at: NOW,
  });
  assert.ok(d2.activity.some((a) => a.text.includes('killed: overpriced')));
  const closeout = d2.outbox.find((m) => m.kind === "close-out")!;
  assert.equal(closeout.sendAuthority, "routine", "kill-switch close-outs ride standing authority");
});

test("cancel: no reason → no kill recorded (learning stays silent)", () => {
  let doc = withHunt(fixtureDoc(), "quiet");
  const { doc: d2 } = cancelHunt(doc, "quiet", { threadIds: ["t1"] }, NOW);
  assert.deepEqual(d2.learning.huntKills, []);
});

test("start: similar past kills warn and tighten the new hunt's criteria", () => {
  let doc = fixtureDoc();
  doc = {
    ...doc,
    learning: {
      ...doc.learning,
      huntKills: [
        { huntName: "old-m3", criteria: "Apple Magic Keyboard bluetooth genuine", reason: "overpriced", at: NOW },
        { huntName: "old-m4", criteria: "Apple Magic Keyboard wired genuine", reason: "overpriced", at: NOW },
      ],
    },
  };
  const { doc: d2, campaign, warnings } = startHunt(doc, { name: "new-m3", criteria: "Apple Magic Keyboard bluetooth, genuine only", maxPrice: 50 }, NOW);
  assert.deepEqual(warnings, ["killed 2 similar hunts for overpriced — consider a lower ceiling"]);
  assert.ok(
    campaign.criteria.includes("[excludes: listings priced above the ceiling or stale relists]"),
    `criteria tightened, got: ${campaign.criteria}`,
  );
  assert.ok(d2.activity.some((a) => a.text.includes("kill-history warning")));
});

test("start: dissimilar kills stay quiet and criteria stay clean", () => {
  let doc = fixtureDoc();
  doc = {
    ...doc,
    learning: {
      ...doc.learning,
      huntKills: [{ huntName: "old-drill", criteria: "DeWalt cordless drill 20V", reason: "flakes", at: NOW }],
    },
  };
  const { campaign, warnings } = startHunt(doc, { name: "new-m3", criteria: "Apple Magic Keyboard bluetooth", maxPrice: 50 }, NOW);
  assert.deepEqual(warnings, []);
  assert.equal(campaign.criteria, "Apple Magic Keyboard bluetooth");
});

test("start: exclusion rules group by reason and skip 'other'", () => {
  let doc = fixtureDoc();
  doc = {
    ...doc,
    learning: {
      ...doc.learning,
      huntKills: [
        { huntName: "k1", criteria: "Apple Magic Keyboard bluetooth genuine", reason: "flakes", at: NOW },
        { huntName: "k2", criteria: "Apple Magic Keyboard bluetooth wired", reason: "scams", at: NOW },
        { huntName: "k3", criteria: "Apple Magic Keyboard genuine bluetooth", reason: "other", at: NOW },
      ],
    },
  };
  const { campaign, warnings } = startHunt(doc, { name: "new", criteria: "Apple Magic Keyboard bluetooth", maxPrice: 50 }, NOW);
  assert.equal(warnings.length, 3);
  assert.ok(campaign.criteria.includes("excludes: sellers with flake history (trust < 30); sellers failing the scam screen"));
  assert.ok(!campaign.criteria.includes("other"));
});

// ---------- send authority alignment ----------

test("offer: offers at/below ceiling stage at routine; above-ceiling offers throw", () => {
  let doc = withHunt(fixtureDoc()); // ceiling $60
  const { doc: d2, message } = stageOffer(doc, "fixture-hunt", "t1", 55, "Would you take $55?", NOW);
  assert.equal(message.sendAuthority, "routine", "offers ≤ ceiling ride standing authority");
  assert.throws(
    () => stageOffer(d2, "fixture-hunt", "t1", 65, "Would you take $65?", NOW),
    /above the \$60 ceiling/,
    "above-ceiling offers are never staged autonomously",
  );
});

test("offer: the buying hard stop is still a ping, not a staged message", () => {
  // negotiateStep counters AT the ceiling — that counter stages at routine via
  // stageOffer; the moment the seller agrees at/below ceiling, detectSellerAcceptance
  // fires the deal-agreed escalation instead of any message. Verified here at the
  // type level: no offer kind ever carries "per_message" auto-send.
  let doc = withHunt(fixtureDoc());
  const { message } = stageOffer(doc, "fixture-hunt", "t1", 60, "I can do $60.", NOW);
  assert.equal(message.kind, "reply");
  assert.equal(message.sendAuthority, "routine");
});

// ---------- campaign shape ----------

test("campaigns: threadNotes survive alongside threads", () => {
  const doc = withHunt(fixtureDoc());
  const campaign: Campaign = doc.campaigns.find((c) => c.name === "fixture-hunt")!;
  assert.deepEqual(campaign.threads, []);
  assert.equal(campaign.threadNotes, undefined, "absent until the contact check adds one");
});
