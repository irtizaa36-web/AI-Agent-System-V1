import { test } from "node:test";
import assert from "node:assert/strict";
import { seedDocument } from "./state";
import type { Lead, Listing, TrackerDocument } from "./types";
import { DEFAULT_CONFIG, resolveConfig, ConfigError } from "./config";
import { classifyOffer, extractOffer, respondToOffer, stageNegotiationReply, setFloorPrice } from "./selling/negotiation";
import { advanceExpiredHolds, holdLead, stageAdvanceMessages, activeHoldFor } from "./selling/queue";
import { classifySender, recordOwnerActivity, isWatchOnly } from "./owner_activity";
import { flushOutbox, stageMessage } from "./outbox";
import { sendDueNudges } from "./selling/nudge";
import { evaluateRentalMessage, readRentalMessage, specificPickupTime, asksForDelivery, checklistComplete } from "./selling/rental_tree";
import { requestBooking, approveBooking } from "./selling/rentals";
import { applyStaleDrops, planStaleDrops, retireMissingListings } from "./selling/health";
import { intakeReadiness, buildIntakeDraft, type IntakeSidecar } from "./selling/intake";
import { buildDigest, formatDigest } from "./digest";
import { parseJsonLenient, setParseFailureSink, type ParseFailure } from "./parse";
import { createChannelPollers, type LeadEvent } from "./channels";
import { renderTemplate } from "./templates";
import { parseComps } from "./selling/comps";
import { rollSummaries } from "./summarize";
import { createMarketplaceDeps } from "./deps";
import { InMemoryMarketplaceStorage } from "./state";
import { runMarketplaceCommand } from "../cli/marketplace-commands";
import type { CliDeps } from "../cli/index";

const NOW = "2026-09-26T12:00:00.000Z";
const HOUR = 3600_000;

function at(offsetHours: number): string {
  return new Date(new Date(NOW).getTime() + offsetHours * HOUR).toISOString();
}

function lead(id: string, listingId: string, queuePosition: number, extra: Partial<Lead> = {}): Lead {
  return {
    id,
    listingId,
    name: `Buyer ${id.toUpperCase()}`,
    threadId: `${id}-thread`,
    channel: "messenger",
    status: "contacted",
    queuePosition,
    firstSeenAt: at(-48 + queuePosition),
    lastContactAt: at(-24),
    needsAgentFollowUp: true,
    awaiting: "them",
    nudgeLevel: 0,
    notes: [],
    ...extra,
  };
}

/** Seed plus a $100 "desk" sale listing (floor $85) with three queued buyers. */
function fixture(listingExtra: Partial<Listing> = {}): TrackerDocument {
  const seed = seedDocument(NOW);
  const desk: Listing = {
    id: "desk",
    kind: "sale",
    title: "Standing Desk",
    price: 100,
    priceFirm: true,
    payment: "cash or Venmo",
    meetup: "Highland Village area — public meetup",
    status: "active",
    monitoring: true,
    holdTimeoutHours: DEFAULT_CONFIG.queue.holdTimeoutHours,
    floorPrice: 85,
    createdAt: at(-72),
    updatedAt: at(-72),
    ...listingExtra,
  };
  return {
    ...seed,
    listings: [...seed.listings, desk],
    leads: [...seed.leads, lead("a", "desk", 1), lead("b", "desk", 2), lead("c", "desk", 3)],
    authority: [
      ...seed.authority,
      { scope: "selling:desk", autonomous: ["reply", "confirm", "hold", "advance-queue", "mark-sold", "nudge"], approvalRequired: ["price-change"] },
    ],
  };
}

// ---------- 1. negotiation bands ----------

test("negotiation: offers are banded <10% hold, 10–25% counter, 25%+ decline", () => {
  assert.equal(classifyOffer(100, 100), "at-asking");
  assert.equal(classifyOffer(100, 91), "hold");
  assert.equal(classifyOffer(100, 90), "counter", "exactly 10% below is the counter band");
  assert.equal(classifyOffer(100, 76), "counter");
  assert.equal(classifyOffer(100, 75), "decline", "exactly 25% below is the decline band");
  assert.equal(classifyOffer(100, 40), "decline");
});

test("negotiation: extractOffer reads the buyer's number, ignoring the asking price", () => {
  assert.equal(extractOffer("It says $100, would you take $80?", 100), 80);
  assert.equal(extractOffer("can you do 70", 100), 70);
  assert.equal(extractOffer("is this still available?", 100), undefined);
  assert.equal(extractOffer("I'll pay $100", 100), undefined);
});

test("negotiation: polite hold under 10% — restates the firm price, no counter", () => {
  const { doc, decision, lead: l } = respondToOffer(fixture(), "desk", "a", 95, NOW);
  assert.equal(decision.action, "polite-hold");
  assert.equal(decision.counterPrice, undefined);
  const staged = stageNegotiationReply(doc, l, decision, NOW);
  const body = staged.outbox.at(-1)!.body;
  assert.match(body, /firm at \$100/);
  assert.doesNotMatch(body, /\$95|\$85/);
});

test("negotiation: 10–25% below gets exactly one firm counter at the floor, framed as bottom line", () => {
  let doc = fixture();
  const first = respondToOffer(doc, "desk", "a", 80, NOW);
  assert.equal(first.decision.action, "counter");
  assert.equal(first.decision.counterPrice, 85);
  const body = stageNegotiationReply(first.doc, first.lead, first.decision, NOW).outbox.at(-1)!.body;
  assert.match(body, /\$85/);
  assert.match(body, /bottom line/);
  doc = first.doc;
  // A second offer in the counter band restates the bottom line — never a second counter.
  const second = respondToOffer(doc, "desk", "a", 82, NOW);
  assert.equal(second.decision.action, "bottom-line");
  assert.equal(second.decision.counterPrice, 85);
  assert.equal(second.lead.negotiation!.countered, true);
});

test("negotiation: 25%+ below declines without a counter and restates asking", () => {
  const { doc, decision, lead: l } = respondToOffer(fixture(), "desk", "a", 60, NOW);
  assert.equal(decision.action, "decline");
  assert.equal(decision.counterPrice, undefined);
  const body = stageNegotiationReply(doc, l, decision, NOW).outbox.at(-1)!.body;
  assert.match(body, /pass at \$60/);
  assert.match(body, /is \$100/);
  assert.doesNotMatch(body, /\$85/);
});

test("negotiation: after 2 rounds with no agreement the agent stops and escalates, no message", () => {
  let doc = fixture();
  doc = respondToOffer(doc, "desk", "a", 80, NOW).doc; // round 1: counter
  doc = respondToOffer(doc, "desk", "a", 81, NOW).doc; // round 2: bottom line
  const third = respondToOffer(doc, "desk", "a", 82, NOW);
  assert.equal(third.decision.action, "escalate");
  assert.equal(third.decision.template, undefined, "no buyer message on escalation");
  assert.equal(third.decision.escalation!.reason, "negotiation-stalled");
  assert.equal(third.lead.negotiation!.status, "escalated");
  // Once escalated, the agent stays out of it.
  const fourth = respondToOffer(third.doc, "desk", "a", 83, NOW);
  assert.equal(fourth.decision.action, "stand-down");
  assert.equal(fourth.decision.template, undefined);
});

test("negotiation: meeting the floor after the counter is agreement; never below the floor", () => {
  let doc = fixture();
  doc = respondToOffer(doc, "desk", "a", 80, NOW).doc;
  const deal = respondToOffer(doc, "desk", "a", 85, NOW);
  assert.equal(deal.decision.action, "accept");
  assert.equal(deal.decision.agreedPrice, 85);
  // Below the floor after the counter: not accepted.
  const low = respondToOffer(doc, "desk", "a", 84, NOW);
  assert.notEqual(low.decision.action, "accept");
  assert.ok(low.decision.agreedPrice === undefined);
});

test("negotiation: no floor on the listing → counter band gets the polite hold, never a made-up counter", () => {
  const { decision } = respondToOffer(fixture({ floorPrice: undefined }), "desk", "a", 80, NOW);
  assert.equal(decision.action, "polite-hold");
  assert.equal(decision.counterPrice, undefined);
});

test("negotiation: floor must be below asking", () => {
  assert.throws(() => setFloorPrice(fixture(), "desk", 120, NOW), /below the \$100/);
  const doc = setFloorPrice(fixture(), "desk", 90, NOW);
  assert.equal(doc.listings.find((l) => l.id === "desk")!.floorPrice, 90);
});

// ---------- 2. buyer queue + auto-advance timeouts ----------

test("queue: default hold timeout is 12 hours", () => {
  assert.equal(DEFAULT_CONFIG.queue.holdTimeoutHours, 12);
  const { lead: l } = holdLead(fixture(), "desk", "a", NOW);
  assert.equal(l.holdExpiresAt, at(12));
});

test("queue: never two active holds on one item", () => {
  const { doc } = holdLead(fixture(), "desk", "a", NOW);
  assert.throws(() => holdLead(doc, "desk", "b", at(1)), /one active hold per item/);
  // Once A's hold has expired, B can hold.
  assert.doesNotThrow(() => holdLead(doc, "desk", "b", at(13)));
});

test("queue: expiry notifies the lapsed buyer and offers the next in strict line order the same terms", () => {
  let doc = fixture();
  // Give C the best reliability score — strict order must still pick B (position 2) over C.
  doc = { ...doc, buyers: { "buyer c": { name: "Buyer C", threads: [], contacts: 5, ghosts: 0, holdsExpired: 0, lowballs: 0, completed: 3, score: 100, updatedAt: NOW } } };
  ({ doc } = holdLead(doc, "desk", "a", NOW));
  const { doc: d2, result } = advanceExpiredHolds(doc, "desk", at(12));
  assert.deepEqual(result.expired.map((e) => e.id), ["a"]);
  assert.equal(result.advanced!.id, "b");
  assert.equal(result.offeredPrice, 100);
  assert.equal(activeHoldFor(d2, "desk", at(12))!.id, "b");
  assert.equal(d2.leads.filter((l) => l.listingId === "desk" && l.status === "hold").length, 1);

  const { doc: d3, staged } = stageAdvanceMessages(d2, "desk", result, at(12));
  assert.equal(staged, 2);
  const [lapsed, offer] = d3.outbox.slice(-2);
  assert.equal(lapsed.leadId, "a");
  assert.match(lapsed.body, /hold has lapsed/);
  assert.equal(offer.leadId, "b");
  assert.match(offer.body, /Same terms: \$100/);
  assert.match(offer.body, /12 hours/);
});

test("queue: the same terms carry over when the lapsed buyer had agreed a floor price", () => {
  let doc = fixture();
  doc = respondToOffer(doc, "desk", "a", 80, NOW).doc;
  doc = respondToOffer(doc, "desk", "a", 85, NOW).doc; // agreed at $85
  ({ doc } = holdLead(doc, "desk", "a", NOW));
  const { result } = advanceExpiredHolds(doc, "desk", at(13));
  assert.equal(result.advanced!.id, "b");
  assert.equal(result.offeredPrice, 85);
});

test("queue: live holds don't advance, and nobody advances past a confirmed sale", () => {
  let doc = fixture();
  ({ doc } = holdLead(doc, "desk", "a", NOW));
  assert.equal(advanceExpiredHolds(doc, "desk", at(6)).result.advanced, undefined);

  // A second, stale hold record alongside a confirmed buyer: expiry must not hand out a hold.
  const withConfirmed: TrackerDocument = {
    ...doc,
    leads: doc.leads.map((l) => (l.id === "c" ? { ...l, status: "confirmed" as const } : l)),
  };
  const { result } = advanceExpiredHolds(withConfirmed, "desk", at(13));
  assert.equal(result.expired.length, 1);
  assert.equal(result.advanced, undefined);
});

test("queue: watch-only threads are skipped when advancing and get no message", () => {
  let doc = fixture();
  ({ doc } = holdLead(doc, "desk", "a", NOW));
  const skip = new Set(["b-thread"]);
  const { doc: d2, result } = advanceExpiredHolds(doc, "desk", at(13), { skipThreads: skip });
  assert.equal(result.advanced!.id, "c");
  const { staged } = stageAdvanceMessages(d2, "desk", result, at(13), { skipThreads: new Set(["a-thread"]) });
  assert.equal(staged, 1, "only C's offer; A's thread is watch-only");
});

// ---------- 3. owner-activity watch-only ----------

const OWNER = "owner-test-id";

test("owner activity: owner vs agent is told apart by sender id and the agent's own sends", () => {
  let doc = fixture();
  const agentBody = "Hey Buyer A — appreciate the offer, but the Standing Desk is firm at $100.";
  doc = { ...doc, outbox: [...doc.outbox, { id: "o1", kind: "reply", channel: "messenger", threadId: "a-thread", recipient: "Buyer A", body: agentBody, stagedAt: NOW, status: "sent", sendAuthority: "per_message" }] };
  assert.equal(classifySender(doc, { threadId: "a-thread", senderId: OWNER, body: agentBody }, { ownerId: OWNER }), "agent");
  assert.equal(classifySender(doc, { threadId: "a-thread", senderId: OWNER, body: "sure, 3pm works" }, { ownerId: OWNER }), "owner");
  assert.equal(classifySender(doc, { threadId: "a-thread", senderId: "buyer-id", body: "hi" }, { ownerId: OWNER }), "counterparty");
  assert.equal(classifySender(doc, { threadId: "a-thread", senderId: "agent-id", body: "x" }, { ownerId: OWNER, agentId: "agent-id" }), "agent");
  // No owner id configured → nobody is the owner.
  assert.equal(classifySender(doc, { threadId: "a-thread", senderId: "", body: "x" }, { ownerId: "" }), "counterparty");
});

test("owner activity: a message in the last 60 minutes makes the thread watch-only, then it lapses", () => {
  const doc = recordOwnerActivity(fixture(), [{ threadId: "a-thread", senderId: OWNER, body: "on my way", sentAt: NOW }], { ownerId: OWNER });
  assert.equal(doc.ownerActivity["a-thread"], NOW);
  assert.ok(isWatchOnly(doc, "a-thread", at(0.5), 60));
  assert.ok(!isWatchOnly(doc, "a-thread", at(1), 60), "exactly 60 minutes later the window has closed");
  assert.ok(!isWatchOnly(doc, "b-thread", at(0.5), 60));
  assert.ok(isWatchOnly(doc, "a-thread", at(1.5), 120), "the window is configurable");
});

test("owner activity: flush suppresses pending messages for watch-only threads — never sent", () => {
  let doc = recordOwnerActivity(fixture(), [{ threadId: "a-thread", senderId: OWNER, body: "got it", sentAt: NOW }], { ownerId: OWNER });
  doc = stageMessage(doc, { kind: "reply", channel: "messenger", threadId: "a-thread", recipient: "Buyer A", body: "hello A" }, NOW).doc;
  doc = stageMessage(doc, { kind: "reply", channel: "messenger", threadId: "b-thread", recipient: "Buyer B", body: "hello B" }, NOW).doc;
  const { doc: d2, spurt, suppressed } = flushOutbox(doc, at(0.25), 60);
  assert.deepEqual(spurt.map((m) => m.threadId), ["b-thread"]);
  assert.deepEqual(suppressed.map((m) => m.threadId), ["a-thread"]);
  assert.equal(d2.outbox.find((m) => m.threadId === "a-thread")!.status, "suppressed");
});

test("owner activity: nudges skip watch-only threads without touching their state", () => {
  const doc = fixture();
  const { doc: d2, staged } = sendDueNudges(doc, NOW, { skipThreads: new Set(["a-thread"]) });
  assert.ok(!staged.some((s) => s.lead.id === "a"));
  assert.ok(staged.some((s) => s.lead.id === "b"));
  assert.equal(d2.leads.find((l) => l.id === "a")!.nudgeLevel, 0);
});

test("owner activity: CLI poll goes watch-only — state updates, no message staged", async () => {
  let doc = fixture();
  doc = { ...doc, ownerActivity: { "a-thread": at(-0.25) } };
  const storage = new InMemoryMarketplaceStorage(doc);
  const m = createMarketplaceDeps({ storage, now: () => NOW });
  const out: string[] = [];
  const deps = { stdout: (l: string) => out.push(l), stderr: () => {}, cwd: "/tmp" } as unknown as CliDeps;
  await runMarketplaceCommand(["selling", "offer", "a", "--amount", "80"], m, deps);
  const after = (await m.openState()).document;
  assert.ok(out.some((l) => /watch-only/.test(l)));
  assert.equal(after.leads.find((l) => l.id === "a")!.negotiation!.lastOffer, 80, "state still updated");
  assert.equal(after.outbox.filter((o) => o.threadId === "a-thread").length, 0, "nothing staged");
});

// ---------- 4. rental decision tree ----------

function rentalDoc(): TrackerDocument {
  return seedDocument(NOW);
}

test("rental tree: time phrases — vague vs specific", () => {
  assert.equal(specificPickupTime("tomorrow sometime"), undefined);
  assert.equal(specificPickupTime("this weekend"), undefined);
  assert.equal(specificPickupTime("tomorrow at 3pm"), "tomorrow 3pm");
  assert.equal(specificPickupTime("Sat 10:30"), "Sat 10:30");
  assert.ok(asksForDelivery("can you deliver it?"));
  assert.ok(asksForDelivery("could you meet me at the mall"));
  assert.ok(!asksForDelivery("I'll pick it up Saturday"));
});

test("rental tree: vague time → demand a specific time", () => {
  let doc = rentalDoc();
  doc = { ...doc, leads: doc.leads.map((l) => (l.id === "renter-1" ? { ...l, rental: { rateAgreed: true, depositCommitted: true, depositMethod: "Venmo" } } : l)) };
  const { decision } = evaluateRentalMessage(doc, "bissell", "renter-1", "tomorrow sometime works", NOW);
  assert.equal(decision.step, "demand-specific-time");
  assert.equal(decision.template, "rental-need-time");
});

test("rental tree: no deposit commitment → require the $30 refundable deposit; never waived", () => {
  let doc = rentalDoc();
  doc = { ...doc, leads: doc.leads.map((l) => (l.id === "renter-1" ? { ...l, rental: { rateAgreed: true, depositCommitted: false } } : l)) };
  const first = evaluateRentalMessage(doc, "bissell", "renter-1", "can I get it Saturday at 10am?", NOW);
  assert.equal(first.decision.step, "require-deposit");
  assert.equal(first.decision.context.deposit, 30);
  assert.match(String(first.decision.context.depositMethods), /Venmo.*Zelle.*cash/);
  const waive = evaluateRentalMessage(first.doc, "bissell", "renter-1", "can we skip the deposit? I'm good for it", NOW);
  assert.equal(waive.decision.step, "require-deposit");
  assert.equal(waive.lead.rental!.depositCommitted, false);
});

test("rental tree: delivery or meet-elsewhere → polite decline, pickup area only", () => {
  const { doc, decision, lead: l } = evaluateRentalMessage(rentalDoc(), "bissell", "renter-1", "Can you deliver it to my place tomorrow at 3pm?", NOW);
  assert.equal(decision.step, "decline-delivery");
  const body = renderTemplate(doc, decision.template, decision.context);
  assert.match(body, /can't deliver, ship, or meet elsewhere/);
  assert.match(body, /Highland Village area only/);
  void l;
});

test("rental tree: booking confirmed ONLY when rate + deposit + specific time are all agreed", () => {
  let doc = rentalDoc();
  let r = evaluateRentalMessage(doc, "bissell", "renter-1", "$30 a day works for me", NOW);
  assert.equal(r.decision.step, "require-deposit");
  r = evaluateRentalMessage(r.doc, "bissell", "renter-1", "Deposit is fine, I'll Venmo it", NOW);
  assert.equal(r.decision.step, "demand-specific-time");
  assert.equal(r.lead.rental!.depositMethod, "Venmo");
  r = evaluateRentalMessage(r.doc, "bissell", "renter-1", "Saturday at 10am", NOW);
  assert.equal(r.decision.step, "ready");
  assert.equal(r.decision.escalation!.reason, "rental-ready");
  assert.ok(checklistComplete(r.lead.rental));
  doc = r.doc;
  const { doc: d2, booking } = requestBooking(doc, "bissell", { leadId: "renter-1", pickupDate: "2026-09-27", returnDate: "2026-09-28" }, NOW);
  assert.equal(approveBooking(d2, booking.id, NOW).booking.status, "booked");

  // Renter 2 has nothing agreed: the booking stays unconfirmable.
  const { doc: d3, booking: b2 } = requestBooking(doc, "bissell", { leadId: "renter-2", pickupDate: "2026-09-27", returnDate: "2026-09-28" }, NOW);
  assert.throws(() => approveBooking(d3, b2.id, NOW), /can't be confirmed yet/);
});

test("rental tree: readRentalMessage keeps earlier facts across messages", () => {
  const c1 = readRentalMessage("deposit ok, cash at pickup");
  assert.ok(c1.depositCommitted);
  assert.equal(c1.depositMethod, "Cash");
  const c2 = readRentalMessage("see you sunday 2pm", c1);
  assert.ok(c2.depositCommitted);
  assert.equal(c2.pickupTime, "sunday 2pm");
});

// ---------- 5. photo-first intake gate ----------

const GOOD_SIDECAR: IntakeSidecar = {
  item: "standing desk",
  confidence: 0.92,
  condition: "used_good",
  flaws: [],
  suggestedTitle: "Standing Desk",
  suggestedDescription: "Electric standing desk.",
  suggestedPrice: 100,
  compBasis: "comps",
};

test("intake: low confidence or unconfirmed specs → 1–2 clarifying questions, no draft", () => {
  assert.deepEqual(intakeReadiness(GOOD_SIDECAR), { ready: true });
  const low = intakeReadiness({ ...GOOD_SIDECAR, confidence: 0.4 });
  assert.equal(low.ready, false);
  assert.ok(!low.ready && low.questions.length >= 1 && low.questions.length <= 2);
  const missing = intakeReadiness({ ...GOOD_SIDECAR, confidence: undefined });
  assert.equal(missing.ready, false, "no stated confidence counts as low");
  const specs = intakeReadiness({ ...GOOD_SIDECAR, unknownSpecs: ["desktop width", "motor count", "max height"] });
  assert.ok(!specs.ready && specs.questions.length === 2, "never more than 2 questions");
  assert.throws(() => buildIntakeDraft(["/nonexistent.jpg"], { ...GOOD_SIDECAR, confidence: 0.3 }), /needs answers before drafting/);
});

// ---------- 6. stale-listing auto-drop ----------

test("stale auto-drop: disabled by default — nothing changes", () => {
  assert.equal(DEFAULT_CONFIG.staleDrop.enabled, false);
  const doc = fixture({ createdAt: at(-24 * 30) });
  const staleDoc = { ...doc, leads: doc.leads.filter((l) => l.listingId !== "desk") };
  const r = applyStaleDrops(staleDoc, NOW);
  assert.ok(r.disabled);
  assert.equal(r.applied.length, 0);
  assert.equal(r.doc, staleDoc);
  assert.equal(planStaleDrops(staleDoc, NOW).length > 0, true, "the preview still sees the candidate");
});

test("stale auto-drop: when enabled, drops by percent, respects the floor, needs price-change authority", () => {
  const cfg = resolveConfig({ staleDrop: { enabled: true, daysStale: 7, dropPercent: 10 } }).staleDrop;
  const base = fixture({ createdAt: at(-24 * 10) });
  const doc: TrackerDocument = { ...base, leads: base.leads.filter((l) => l.listingId !== "desk") };
  // Default ledger: price-change needs approval → nothing applied, surfaced instead.
  const gated = applyStaleDrops(doc, NOW, cfg);
  assert.equal(gated.applied.length, 0);
  assert.equal(gated.needsApproval.find((d) => d.listingId === "desk")!.to, 90);

  const granted: TrackerDocument = {
    ...doc,
    authority: doc.authority.map((g) => (g.scope === "selling:desk" ? { ...g, autonomous: [...g.autonomous, "price-change"], approvalRequired: [] } : g)),
  };
  const first = applyStaleDrops(granted, NOW, cfg);
  const desk = first.doc.listings.find((l) => l.id === "desk")!;
  assert.equal(desk.price, 90);
  assert.equal(desk.originalPrice, 100);
  assert.equal(desk.lastPriceDropAt, NOW);
  // Just dropped: not stale again until another daysStale passes.
  assert.equal(applyStaleDrops(first.doc, at(24), cfg).applied.length, 0);
  // Next drop would be $80 but the floor is $85.
  const second = applyStaleDrops(first.doc, at(24 * 8), cfg);
  assert.equal(second.doc.listings.find((l) => l.id === "desk")!.price, 85);
  // At the floor: no more drops.
  assert.equal(applyStaleDrops(second.doc, at(24 * 16), cfg).applied.length, 0);
});

test("stale auto-drop: an inquiry resets the clock", () => {
  const cfg = resolveConfig({ staleDrop: { enabled: true } }).staleDrop;
  const doc = fixture({ createdAt: at(-24 * 30) });
  const fresh = { ...doc, leads: [...doc.leads, lead("d", "desk", 4, { firstSeenAt: at(-24) })] };
  assert.equal(planStaleDrops(fresh, NOW, cfg).filter((d) => d.listingId === "desk").length, 0);
});

test("config: invalid overrides are rejected", () => {
  assert.throws(() => resolveConfig({ negotiation: { holdBelowFraction: 0.3, declineAtFraction: 0.2 } }), ConfigError);
  assert.throws(() => resolveConfig({ staleDrop: { dropPercent: 150 } }), ConfigError);
});

// ---------- 7. digest ----------

test("digest: four sections, in order, each present even when empty", () => {
  let doc = fixture();
  doc = respondToOffer(doc, "desk", "a", 80, NOW).doc;
  const digest = buildDigest(doc, at(-24), NOW);
  assert.deepEqual(digest.sections.map((s) => s.title), ["ACTIVE LISTINGS + NEW INQUIRIES", "NEGOTIATIONS", "RENTALS", "ACTION NEEDED"]);
  const text = formatDigest(digest);
  assert.match(text, /1\. ACTIVE LISTINGS \+ NEW INQUIRIES[\s\S]*2\. NEGOTIATIONS[\s\S]*3\. RENTALS[\s\S]*4\. ACTION NEEDED/);
  assert.match(text, /Buyer A on "Standing Desk".*last offer \$80 — open, round 1, countered at floor/);
});

// ---------- 8. reliability ----------

test("parse: lenient JSON survives fences and log noise; failures log the raw output", () => {
  const failures: ParseFailure[] = [];
  const restore = setParseFailureSink((f) => failures.push(f));
  try {
    assert.deepEqual(parseJsonLenient('```json\n{"a":1}\n```', "t"), { ok: true, value: { a: 1 } });
    assert.deepEqual(parseJsonLenient('warning: slow\n[{"a":1}]\n', "t"), { ok: true, value: [{ a: 1 }] });
    const bad = parseJsonLenient("<html>rate limited</html>", "comps.search");
    assert.equal(bad.ok, false);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].source, "comps.search");
    assert.match(failures[0].rawExcerpt, /rate limited/);
    assert.deepEqual(parseComps("not json at all"), []);
  } finally {
    restore();
  }
});

test("parse: one malformed item is skipped and logged; the rest of the payload survives", async () => {
  const failures: ParseFailure[] = [];
  const restore = setParseFailureSink((f) => failures.push(f));
  try {
    const exec = async (cmd: string) => {
      if (cmd === "agentmail-cli") return JSON.stringify([{ id: "1", from: "a", snippet: "hi", date: "2026-09-26T00:00:00Z" }, { id: "2", from: "b", snippet: "x", date: "not a date" }]);
      throw new Error("offline");
    };
    const pollers = createChannelPollers(exec);
    const events = await pollers.find((p) => p.name === "agentmail")!.poll(NOW);
    assert.equal(events.length, 1);
    assert.ok(failures.some((f) => f.source === "agentmail.item" && /unparseable date/.test(f.error)));
  } finally {
    restore();
  }
});

test("parse: an unreadable my-listings payload retires nothing", async () => {
  const restore = setParseFailureSink(() => {});
  try {
    const doc = fixture({ fbListingId: "fb-1" });
    const { retired } = await retireMissingListings(doc, async () => "Error: session expired", NOW);
    assert.equal(retired.length, 0);
  } finally {
    restore();
  }
});

test("parse: a failing model summarizer keeps the old summary and doesn't throw", async () => {
  const restore = setParseFailureSink(() => {});
  try {
    const doc = await rollSummaries(fixture(), [{ id: "e1", channel: "messenger", threadId: "a-thread", senderName: "A", body: "hi", sentAt: NOW }], async () => {
      throw new Error("model returned garbage");
    }, NOW);
    assert.equal(doc.summaries["a-thread"], undefined);
  } finally {
    restore();
  }
});

test("sweep: a failing listing or payload is reported and the run continues", async () => {
  // A listing with an empty meetup makes the same-terms offer fail to render inside the advance step,
  // and the poller returns garbage — neither may crash the sweep.
  let doc = fixture({ meetup: "" });
  ({ doc } = holdLead(doc, "desk", "a", at(-13)));
  const storage = new InMemoryMarketplaceStorage(doc);
  const garbagePoller = { name: "messenger" as const, poll: async (): Promise<LeadEvent[]> => { throw new Error("poller blew up"); } };
  const m = createMarketplaceDeps({ storage, now: () => NOW, pollers: () => [garbagePoller] });
  const out: string[] = [];
  const deps = { stdout: (l: string) => out.push(l), stderr: () => {}, cwd: "/tmp" } as unknown as CliDeps;
  const origWrite = process.stderr.write;
  const logged: string[] = [];
  (process.stderr as { write: unknown }).write = (chunk: string) => { logged.push(String(chunk)); return true; };
  try {
    await runMarketplaceCommand(["sweep"], m, deps);
  } finally {
    (process.stderr as { write: unknown }).write = origWrite;
  }
  const text = out.join("\n");
  assert.match(text, /poll: FAILED \(poller blew up\)/);
  assert.match(text, /"Standing Desk" failed/);
  assert.match(text, /advance: \d+ hold\(s\) expired/, "the advance step still finished");
  assert.match(text, /No nudges due|Staged nudge|staged/, "later steps still ran");
  assert.ok(logged.some((l) => l.includes("marketplace.parse_failure") && l.includes("sweep.poll")), "structured failure record logged");
  const after = (await m.openState()).document;
  assert.ok(after.activity.some((a) => a.kind === "parse-failure"));
});
