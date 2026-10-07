import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServiceRequest, TrackerDocument } from "../types";
import { flushOutbox, HARD_STOP_KINDS, pendingMessages, stageMessage } from "../outbox";
import {
  addQuote,
  approveServiceBooking,
  availabilityFit,
  compareProviders,
  createServiceRequest,
  latestQuote,
  rateService,
  recordReference,
  requestServiceBooking,
  servicesNudgeDue,
  stageScreening,
  stageServiceNudge,
} from "./requests";
import { formatComparison } from "./format";
import {
  checkReferences,
  detectHomeSubtype,
  REFERENCE_RED_FLAG_WORDS,
  screeningQuestions,
} from "./screening";

const NOW = "2026-09-27T05:00:00Z";
const LATER = "2026-09-29T06:00:00Z"; // 49h after NOW — past the 48h nudge line

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

function openRequest(doc: TrackerDocument, over: Partial<{ specs: string; type: "home" | "cleaning"; budget: number; window: string }> = {}) {
  const { doc: d2, request } = createServiceRequest(
    doc,
    {
      type: over.type ?? "home",
      specs: over.specs ?? "Mount 65-inch TCL TV in the living room",
      budgetCeiling: over.budget ?? 120,
      timingWindow: over.window ?? "weekday evenings this week",
    },
    NOW,
  );
  return { doc: d2, request };
}

function quotedRequest(doc: TrackerDocument) {
  const { doc: d2, request } = openRequest(doc);
  const { doc: d3 } = stageScreening(d2, request.id, "Ace Mounts", "thread-ace", NOW);
  const { doc: d4 } = addQuote(d3, request.id, { providerName: "Ace Mounts", amount: 100, notes: "includes hardware", available: "weekday evenings" }, NOW);
  return { doc: d4, requestId: request.id };
}

// ---------- intake validation ----------

test("services: intake opens a request and links an inventory row", () => {
  const { doc, request } = openRequest(fixtureDoc());
  assert.equal(request.status, "requested");
  assert.equal(request.budgetCeiling, 120);
  assert.deepEqual(request.quotes, []);
  assert.equal(doc.inventory.services.length, 1);
  const row = doc.inventory.services[0];
  assert.equal(row.status, "requested");
  assert.equal(row.serviceRequestId, request.id);
  assert.equal(row.quotesReceived, 0);
  assert.ok(doc.activity.some((a) => a.text.includes("Service request opened")));
});

test("services: intake rejects zero/negative budget", () => {
  assert.throws(
    () => createServiceRequest(fixtureDoc(), { type: "home", specs: "Mount a TV", budgetCeiling: 0, timingWindow: "soon" }, NOW),
    /--budget must be a number > 0/,
  );
  assert.throws(
    () => createServiceRequest(fixtureDoc(), { type: "home", specs: "Mount a TV", budgetCeiling: -50, timingWindow: "soon" }, NOW),
    /--budget must be a number > 0/,
  );
  assert.throws(
    () => createServiceRequest(fixtureDoc(), { type: "home", specs: "Mount a TV", budgetCeiling: NaN, timingWindow: "soon" }, NOW),
    /--budget must be a number > 0/,
  );
});

test("services: intake requires specs and a valid type", () => {
  assert.throws(
    () => createServiceRequest(fixtureDoc(), { type: "home", specs: "   ", budgetCeiling: 50, timingWindow: "soon" }, NOW),
    /--specs is required/,
  );
  assert.throws(
    () => createServiceRequest(fixtureDoc(), { type: "repair" as never, specs: "Fix it", budgetCeiling: 50, timingWindow: "soon" }, NOW),
    /--type must be home\|cleaning/,
  );
});

// ---------- quotes ----------

test("services: add-quote appends, flips status to quoted, updates inventory", () => {
  const { doc: d1, request } = openRequest(fixtureDoc());
  const { doc: d2, quote } = addQuote(d1, request.id, { providerName: "Ace Mounts", amount: 100 }, NOW);
  const r = d2.serviceRequests.find((x) => x.id === request.id)!;
  assert.equal(r.status, "quoted");
  assert.equal(r.quotes.length, 1);
  assert.equal(quote.providerId, "ace-mounts");
  assert.equal(d2.inventory.services[0].status, "quoted");
  assert.equal(d2.inventory.services[0].quotesReceived, 1);
  // A second quote from another provider keeps status quoted.
  const { doc: d3 } = addQuote(d2, request.id, { providerName: "Quick Fixers", amount: 90 }, NOW);
  assert.equal(d3.serviceRequests.find((x) => x.id === request.id)!.status, "quoted");
  assert.equal(d3.serviceRequests.find((x) => x.id === request.id)!.quotes.length, 2);
});

test("services: add-quote rejects non-positive amounts and unknown requests", () => {
  const { doc, request } = openRequest(fixtureDoc());
  assert.throws(
    () => addQuote(doc, request.id, { providerName: "Ace Mounts", amount: 0 }, NOW),
    /--amount must be a number > 0/,
  );
  assert.throws(() => addQuote(doc, "nope", { providerName: "Ace Mounts", amount: 50 }, NOW), /Unknown service request/);
});

test("services: latest quote wins when a provider re-quotes", () => {
  const { doc: d1, request } = openRequest(fixtureDoc());
  const { doc: d2 } = addQuote(d1, request.id, { providerName: "Ace Mounts", amount: 100 }, NOW);
  const { doc: d3 } = addQuote(d2, request.id, { providerName: "Ace Mounts", amount: 85 }, NOW);
  const r = d3.serviceRequests.find((x) => x.id === request.id)!;
  assert.equal(latestQuote(r, "ace-mounts")!.amount, 85);
});

// ---------- screening ----------

test("services: screening templates are per-subtype and detected from specs", () => {
  assert.deepEqual(screeningQuestions("home", "mount 65 inch TV"), [
    "send a photo of a similar mount you've done",
    "do you bring the mount or should I supply it",
  ]);
  assert.deepEqual(screeningQuestions("home", "fix the leaky faucet"), [
    "are you licensed/insured for this work",
    "what's your warranty",
  ]);
  assert.deepEqual(screeningQuestions("cleaning", "deep clean the apartment"), [
    "do you bring supplies/products",
    "how do you price — hourly or flat",
  ]);
  // Ambiguous home specs default to mounting.
  assert.equal(detectHomeSubtype("help around the house this weekend"), "mounting");
});

test("services: screen stages ONE routine message with all questions, marks screened", () => {
  const { doc: d1, request } = openRequest(fixtureDoc());
  const { doc: d2, messageId, body } = stageScreening(d1, request.id, "Ace Mounts", "thread-ace", NOW);
  assert.ok(body.includes("send a photo of a similar mount you've done"));
  assert.ok(body.includes("do you bring the mount or should I supply it"));
  const staged = pendingMessages(d2).find((m) => m.id === messageId)!;
  assert.equal(staged.kind, "screening");
  assert.equal(staged.sendAuthority, "routine");
  assert.equal(staged.threadId, "thread-ace");
  assert.deepEqual(d2.serviceRequests.find((r) => r.id === request.id)!.screenedProviders, ["Ace Mounts"]);
  // Screening the same provider twice doesn't duplicate the record.
  const { doc: d3 } = stageScreening(d2, request.id, "Ace Mounts", "thread-ace", NOW);
  assert.deepEqual(d3.serviceRequests.find((r) => r.id === request.id)!.screenedProviders, ["Ace Mounts"]);
});

// ---------- references ----------

test("services: reference red flags fire on low scores and flag words", () => {
  const base = { providerId: "ace-mounts", providerName: "Ace Mounts", at: NOW } as const;
  const clean = checkReferences("Ace Mounts", [
    { ...base, score: 5, notes: "great work, on time" },
    { ...base, score: 4, notes: "solid job" },
  ]);
  assert.equal(clean.clean, true);
  assert.equal(clean.avg, 4.5);
  const low = checkReferences("Ace Mounts", [{ ...base, score: 2, notes: "fine" }]);
  assert.equal(low.clean, false);
  assert.ok(low.redFlags.some((f) => f.includes("low score 2/5")));
  const flagged = checkReferences("Ace Mounts", [{ ...base, score: 5, notes: "total ghost, never showed up" }]);
  assert.equal(flagged.clean, false);
  assert.ok(flagged.redFlags.some((f) => f.includes('flag word "ghost"')));
  const empty = checkReferences("Ace Mounts", []);
  assert.equal(empty.clean, false);
  assert.equal(empty.avg, undefined);
});

test("services: the red-flag word list is documented and non-empty", () => {
  assert.ok(REFERENCE_RED_FLAG_WORDS.length >= 10);
  assert.ok(REFERENCE_RED_FLAG_WORDS.includes("scam"));
  assert.ok(REFERENCE_RED_FLAG_WORDS.includes("no-show"));
});

test("services: add-reference validates score bounds", () => {
  const { doc, request } = openRequest(fixtureDoc());
  assert.throws(
    () => recordReference(doc, request.id, { providerName: "Ace Mounts", score: 6 }, NOW),
    /--score must be an integer 1–5/,
  );
  assert.throws(
    () => recordReference(doc, request.id, { providerName: "Ace Mounts", score: 0 }, NOW),
    /--score must be an integer 1–5/,
  );
});

// ---------- comparison ----------

test("services: compare recommends the cheapest qualified provider, surfaces blockers", () => {
  const { doc: d1, requestId } = quotedRequest(fixtureDoc());
  // Quick Fixers quoted too but was never screened.
  const { doc: d2 } = addQuote(d1, requestId, { providerName: "Quick Fixers", amount: 80 }, NOW);
  const { doc: d3 } = recordReference(d2, requestId, { providerName: "Ace Mounts", score: 5, notes: "great work" }, NOW);
  const r = d3.serviceRequests.find((x) => x.id === requestId)!;
  const result = compareProviders(r);
  assert.equal(result.rows.length, 2);
  const ace = result.rows.find((x) => x.providerName === "Ace Mounts")!;
  const quick = result.rows.find((x) => x.providerName === "Quick Fixers")!;
  assert.equal(ace.qualified, true);
  assert.equal(quick.qualified, false);
  assert.ok(quick.disqualifiedReason!.includes("screening"));
  assert.ok(result.recommendation.startsWith("Recommendation: Ace Mounts"));
  // Cheapest qualified wins even when a cheaper unqualified provider exists.
  const { doc: d4 } = stageScreening(d3, requestId, "Quick Fixers", undefined, NOW);
  const r2 = d4.serviceRequests.find((x) => x.id === requestId)!;
  const result2 = compareProviders(r2);
  assert.ok(result2.recommendation.startsWith("Recommendation: Quick Fixers"));
});

test("services: red-flag reference blocks the recommendation", () => {
  const { doc: d1, requestId } = quotedRequest(fixtureDoc());
  const { doc: d2 } = recordReference(d1, requestId, { providerName: "Ace Mounts", score: 2, notes: "damaged the wall" }, NOW);
  const r = d2.serviceRequests.find((x) => x.id === requestId)!;
  const result = compareProviders(r);
  const ace = result.rows.find((x) => x.providerName === "Ace Mounts")!;
  assert.equal(ace.qualified, false);
  assert.ok(ace.redFlags.length >= 2); // low score + "damaged" flag word
  assert.ok(result.recommendation.startsWith("no qualified provider"));
});

test("services: availability fit is heuristic and documented", () => {
  assert.equal(availabilityFit("weekday evenings", "weekday evenings this week"), "fits window");
  assert.equal(availabilityFit(undefined, "weekday evenings"), "not stated");
  assert.equal(availabilityFit("saturdays only", "weekday evenings this week"), "stated — check manually");
});

test("services: formatComparison prints the table and the one-line recommendation", () => {
  const { doc, requestId } = quotedRequest(fixtureDoc());
  const r = doc.serviceRequests.find((x) => x.id === requestId)!;
  const out = formatComparison(r);
  assert.ok(out.includes("QUOTE COMPARISON"));
  assert.ok(out.includes("Ace Mounts"));
  assert.ok(out.includes("SCREENED"));
  assert.ok(out.includes("Recommendation: Ace Mounts"));
});

// ---------- follow-up nudge ----------

test("services: nudge is due 48h after the last quote-request activity, exactly once", () => {
  const { doc, request } = openRequest(fixtureDoc());
  // Fresh — not due yet.
  assert.deepEqual(servicesNudgeDue(doc, NOW), []);
  // 49h later with no activity — due.
  const due = servicesNudgeDue(doc, LATER);
  assert.equal(due.length, 1);
  assert.equal(due[0].request.id, request.id);
  // Staging marks it sent; a re-run never double-nudges.
  const { doc: d2 } = stageServiceNudge(doc, request.id, LATER);
  assert.equal(d2.serviceRequests.find((r) => r.id === request.id)!.quoteNudgeSentAt, LATER);
  assert.deepEqual(servicesNudgeDue(d2, "2026-10-01T00:00:00Z"), []);
});

test("services: a new quote resets the 48h nudge clock", () => {
  const { doc: d1, request } = openRequest(fixtureDoc());
  // Quote lands at the 48h line — activity, not silence.
  const { doc: d2 } = addQuote(d1, request.id, { providerName: "Ace Mounts", amount: 100 }, LATER);
  assert.deepEqual(servicesNudgeDue(d2, LATER), []);
});

test("services: the nudge stages a routine follow-up message", () => {
  const { doc, request } = openRequest(fixtureDoc());
  const { doc: d2, messageId, body } = stageServiceNudge(doc, request.id, LATER);
  const staged = pendingMessages(d2).find((m) => m.id === messageId)!;
  assert.equal(staged.kind, "nudge");
  assert.equal(staged.sendAuthority, "routine");
  assert.ok(body.includes("still waiting on a quote"));
  // Second nudge is refused even manually.
  assert.throws(() => stageServiceNudge(d2, request.id, "2026-10-05T00:00:00Z"), /already nudged once/);
});

// ---------- booking hard stop ----------

test("services: book stages a per_message booking confirmation; status unchanged until approval", () => {
  const { doc: d1, requestId } = quotedRequest(fixtureDoc());
  const { doc: d2, messageId } = requestServiceBooking(d1, requestId, "Ace Mounts", NOW);
  const staged = pendingMessages(d2).find((m) => m.id === messageId)!;
  assert.equal(staged.kind, "booking");
  assert.equal(staged.sendAuthority, "per_message");
  assert.ok(HARD_STOP_KINDS.has(staged.kind));
  const r = d2.serviceRequests.find((x) => x.id === requestId)!;
  assert.equal(r.status, "quoted", "booking alone changes nothing");
  assert.equal(r.bookingPendingFor, "Ace Mounts");
});

test("services: a booking message NEVER auto-sends, even staged at routine tier", () => {
  const { doc: d1 } = stageMessage(fixtureDoc(), {
    kind: "booking",
    channel: "messenger",
    threadId: "services:svc-x",
    recipient: "Ace Mounts",
    body: "mis-tiered booking attempt",
    sendAuthority: "routine",
  }, NOW);
  const { spurt, autoSent } = flushOutbox(d1, NOW);
  assert.equal(autoSent.length, 0, "booking kind must never leave on standing authority");
  assert.equal(spurt.length, 1);
  assert.equal(spurt[0].status, "awaiting-tap");
});

test("services: book refuses providers without quotes and double-booking", () => {
  const { doc: d1, requestId } = quotedRequest(fixtureDoc());
  assert.throws(() => requestServiceBooking(d1, requestId, "Ghost Pro", NOW), /No quote on file/);
  const { doc: d2 } = requestServiceBooking(d1, requestId, "Ace Mounts", NOW);
  assert.throws(() => requestServiceBooking(d2, requestId, "Ace Mounts", NOW), /already has a booking awaiting/);
});

test("services: approve-booking requires a pending booking; approval books and updates inventory", () => {
  const { doc: d1, requestId } = quotedRequest(fixtureDoc());
  // No path to booked without book() first.
  assert.throws(() => approveServiceBooking(d1, requestId, NOW), /No booking is pending approval/);
  const { doc: d2 } = requestServiceBooking(d1, requestId, "Ace Mounts", NOW);
  const { doc: d3 } = approveServiceBooking(d2, requestId, NOW);
  const r = d3.serviceRequests.find((x) => x.id === requestId)!;
  assert.equal(r.status, "booked");
  assert.equal(r.providerId, "ace-mounts");
  assert.equal(r.bookingPendingFor, undefined);
  const row = d3.inventory.services.find((s) => s.serviceRequestId === requestId)!;
  assert.equal(row.status, "booked");
  assert.equal(row.chosenProviderId, "ace-mounts");
  assert.equal(row.cost, 100);
  // The staged confirmation is marked sent — his CLI approval IS the tap.
  const bookingMsg = d3.outbox.find((m) => m.kind === "booking")!;
  assert.equal(bookingMsg.status, "sent");
  assert.ok(d3.activity.some((a) => a.text.includes("BOOKED")));
});

// ---------- provider trust ----------

test("services: rate updates provider trust (running mean), marks done", () => {
  const { doc: d1, requestId } = quotedRequest(fixtureDoc());
  const { doc: d2 } = requestServiceBooking(d1, requestId, "Ace Mounts", NOW);
  const { doc: d3 } = approveServiceBooking(d2, requestId, NOW);
  // Rating before booking is refused.
  const unbooked = quotedRequest(fixtureDoc());
  assert.throws(() => rateService(unbooked.doc, unbooked.requestId, 5, undefined, NOW), /rate only after booking/);
  const { doc: d4 } = rateService(d3, requestId, 4, "solid work", NOW);
  const trust = d4.learning.providerTrust["ace-mounts"];
  assert.deepEqual(trust, { score: 4, jobs: 1, lastRating: 4 });
  const r = d4.serviceRequests.find((x) => x.id === requestId)!;
  assert.equal(r.status, "done");
  assert.equal(r.rating, 4);
  assert.equal(d4.inventory.services.find((s) => s.serviceRequestId === requestId)!.status, "done");
});

test("services: provider trust accumulates across jobs", () => {
  // First job rated 4, second job rated 5 → mean 4.5 over 2 jobs.
  const run = (doc: TrackerDocument) => {
    const { doc: d1, requestId } = quotedRequest(doc);
    const { doc: d2 } = requestServiceBooking(d1, requestId, "Ace Mounts", NOW);
    const { doc: d3 } = approveServiceBooking(d2, requestId, NOW);
    return { doc: d3, requestId };
  };
  const { doc: d1, requestId: r1 } = run(fixtureDoc());
  const { doc: d2 } = rateService(d1, r1, 4, undefined, NOW);
  const { doc: d3, requestId: r2 } = run(d2);
  const { doc: d4 } = rateService(d3, r2, 5, undefined, NOW);
  const trust = d4.learning.providerTrust["ace-mounts"];
  assert.equal(trust.jobs, 2);
  assert.equal(trust.score, 4.5);
  assert.equal(trust.lastRating, 5);
});

test("services: rate validates score bounds", () => {
  const { doc: d1, requestId } = quotedRequest(fixtureDoc());
  const { doc: d2 } = requestServiceBooking(d1, requestId, "Ace Mounts", NOW);
  const { doc: d3 } = approveServiceBooking(d2, requestId, NOW);
  assert.throws(() => rateService(d3, requestId, 6, undefined, NOW), /--score must be an integer 1–5/);
  assert.throws(() => rateService(d3, requestId, 2.5, undefined, NOW), /--score must be an integer 1–5/);
});
