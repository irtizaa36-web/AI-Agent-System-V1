import { randomUUID } from "node:crypto";
import type {
  PriceReferenceCard,
  ServiceQuote,
  ServiceRequest,
  ServiceType,
  TrackerDocument,
} from "../types";
import { stageMessage, type StageInput } from "../outbox";
import { logActivity } from "../state";
import {
  checkReferences,
  providerSlug,
  screeningQuestions,
} from "./screening";

/**
 * SERVICES — state transitions for the services lane (v3 plan §4).
 *
 * End-to-end: intake → screening → quotes → references → compare → book
 * (hard stop) → rate. Every function is a pure state transition: it
 * returns the next document and a small result; the CLI wires it to
 * state. Nothing here sends a message — outbound is staged in the outbox.
 *
 * Send authority: screening questions and the single follow-up nudge
 * stage at "routine" (standing authority). Booking confirmations stage at
 * "per_message" with kind "booking" — already in HARD_STOP_KINDS, so they
 * can never auto-send; `book` only STAGES, `approveServiceBooking` is the
 * explicit tap that books.
 */

const NUDGE_AFTER_MS = 48 * 3600_000;

export interface CreateRequestInput {
  readonly type: ServiceType;
  readonly specs: string;
  readonly budgetCeiling: number;
  readonly timingWindow: string;
  /** v3 Phase 4 (plan §9): the 25-mile service price card captured at intake. */
  readonly priceCard?: PriceReferenceCard;
}

function inventoryName(type: ServiceType, specs: string): string {
  const label = type === "home" ? "Home service" : "Cleaning";
  const short = specs.trim().slice(0, 60);
  return `${label}: ${short}`;
}

/**
 * Intake: validate and open a service request, linking a new inventory
 * service row (status "requested"). Budget must be > 0; specs required.
 */
export function createServiceRequest(
  doc: TrackerDocument,
  input: CreateRequestInput,
  now: string,
): { doc: TrackerDocument; request: ServiceRequest; inventoryId: string } {
  if (input.type !== "home" && input.type !== "cleaning") {
    throw new Error(`--type must be home|cleaning, got "${input.type}".`);
  }
  if (!input.specs || input.specs.trim().length === 0) {
    throw new Error("--specs is required — describe the work needed.");
  }
  if (!Number.isFinite(input.budgetCeiling) || input.budgetCeiling <= 0) {
    throw new Error(`--budget must be a number > 0, got "${String(input.budgetCeiling)}".`);
  }
  const requestId = `svc-req-${randomUUID().slice(0, 8)}`;
  const request: ServiceRequest = {
    id: requestId,
    serviceType: input.type,
    specs: input.specs.trim(),
    budgetCeiling: input.budgetCeiling,
    timingWindow: input.timingWindow,
    status: "requested",
    quotes: [],
    screenedProviders: [],
    references: [],
    lastQuoteActivityAt: now,
    createdAt: now,
    updatedAt: now,
    priceCard: input.priceCard,
  };
  const inventoryId = `inv-svc-${randomUUID().slice(0, 8)}`;
  const d1: TrackerDocument = {
    ...doc,
    serviceRequests: [...doc.serviceRequests, request],
    inventory: {
      ...doc.inventory,
      services: [
        ...doc.inventory.services,
        {
          id: inventoryId,
          name: inventoryName(input.type, input.specs),
          status: "requested",
          serviceType: input.type,
          quotesReceived: 0,
          serviceRequestId: requestId,
          createdAt: now,
          updatedAt: now,
        },
      ],
    },
    updatedAt: now,
  };
  const d2 = logActivity(
    d1,
    "booking",
    `Service request opened: ${inventoryName(input.type, input.specs)} — budget $${input.budgetCeiling}, window "${input.timingWindow}".`,
    now,
  );
  return { doc: d2, request, inventoryId };
}

function findRequest(doc: TrackerDocument, requestId: string): ServiceRequest {
  const request = doc.serviceRequests.find((r) => r.id === requestId);
  if (!request) throw new Error(`Unknown service request "${requestId}".`);
  return request;
}

function syncInventoryServices(
  doc: TrackerDocument,
  request: ServiceRequest,
  now: string,
): TrackerDocument {
  return {
    ...doc,
    inventory: {
      ...doc.inventory,
      services: doc.inventory.services.map((s) =>
        s.serviceRequestId === request.id
          ? {
              ...s,
              status:
                request.status === "quoted"
                  ? ("quoted" as const)
                  : request.status === "booked"
                    ? ("booked" as const)
                    : request.status === "done"
                      ? ("done" as const)
                      : s.status,
              quotesReceived: request.quotes.length,
              chosenProviderId: request.providerId ?? s.chosenProviderId,
              cost: s.cost,
              updatedAt: now,
            }
          : s,
      ),
    },
  };
}

export interface AddQuoteInput {
  readonly providerName: string;
  readonly amount: number;
  readonly notes?: string;
  readonly available?: string;
  readonly threadId?: string;
}

/**
 * Record a provider quote: appends to request.quotes, flips status to
 * "quoted", updates the inventory row. The quote itself IS quote-request
 * activity — it resets the 48h nudge clock.
 */
export function addQuote(
  doc: TrackerDocument,
  requestId: string,
  input: AddQuoteInput,
  now: string,
): { doc: TrackerDocument; quote: ServiceQuote } {
  const request = findRequest(doc, requestId);
  if (request.status !== "requested" && request.status !== "quoted") {
    throw new Error(`Cannot add a quote to request ${requestId} — status is "${request.status}".`);
  }
  if (!input.providerName || input.providerName.trim().length === 0) {
    throw new Error("--provider is required.");
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    throw new Error(`--amount must be a number > 0, got "${String(input.amount)}".`);
  }
  const quote: ServiceQuote = {
    providerId: providerSlug(input.providerName),
    providerName: input.providerName.trim(),
    amount: input.amount,
    notes: input.notes ?? "",
    available: input.available,
    threadId: input.threadId,
    at: now,
  };
  const updated: ServiceRequest = {
    ...request,
    status: "quoted",
    quotes: [...request.quotes, quote],
    lastQuoteActivityAt: now,
    updatedAt: now,
  };
  let d1: TrackerDocument = {
    ...doc,
    serviceRequests: doc.serviceRequests.map((r) => (r.id === requestId ? updated : r)),
    updatedAt: now,
  };
  d1 = syncInventoryServices(d1, updated, now);
  const d2 = logActivity(
    d1,
    "booking",
    `Quote $${quote.amount} from ${quote.providerName} for "${inventoryName(request.serviceType, request.specs)}"${quote.available ? ` (available: ${quote.available})` : ""}.`,
    now,
  );
  return { doc: d2, quote };
}

/** Latest quote from one provider (providers may re-quote; recency wins). */
export function latestQuote(request: ServiceRequest, providerId: string): ServiceQuote | undefined {
  const ours = request.quotes.filter((q) => q.providerId === providerId);
  return ours.length === 0 ? undefined : ours[ours.length - 1];
}

export interface ScreeningStaged {
  readonly doc: TrackerDocument;
  readonly messageId: string;
  readonly body: string;
}

/**
 * Stage the screening questions as ONE message at `routine` tier, before
 * any price talk (trust protocol phase a). Karen voice: terse, direct,
 * no fluff. The provider is recorded as screened for this request.
 */
export function stageScreening(
  doc: TrackerDocument,
  requestId: string,
  providerName: string,
  threadId: string | undefined,
  now: string,
): ScreeningStaged {
  const request = findRequest(doc, requestId);
  if (request.status === "cancelled" || request.status === "done") {
    throw new Error(`Cannot screen for request ${requestId} — status is "${request.status}".`);
  }
  if (!providerName || providerName.trim().length === 0) throw new Error("--provider is required.");
  const name = providerName.trim();
  const questions = screeningQuestions(request.serviceType, request.specs);
  const body = [
    `Hey ${name} — quick screen before we talk price on the job:`,
    ...questions.map((q, i) => `${i + 1}. ${q}?`),
    `Answer those and I'll send the full details.`,
  ].join("\n");
  const input: StageInput = {
    kind: "screening",
    channel: "messenger",
    threadId: threadId ?? `services:${requestId}`,
    recipient: name,
    body,
    // Standing authority: screening is routine outreach, not a commitment.
    sendAuthority: "routine",
  };
  const { doc: d1, message } = stageMessage(doc, input, now);
  const screened = request.screenedProviders.includes(name)
    ? request.screenedProviders
    : [...request.screenedProviders, name];
  const updated: ServiceRequest = { ...request, screenedProviders: screened, updatedAt: now };
  const d2: TrackerDocument = {
    ...d1,
    serviceRequests: d1.serviceRequests.map((r) => (r.id === requestId ? updated : r)),
    updatedAt: now,
  };
  const d3 = logActivity(d2, "booking", `Screening questions sent to ${name} for request ${requestId}.`, now);
  return { doc: d3, messageId: message.id, body };
}

export interface AddReferenceInput {
  readonly providerName: string;
  readonly score: number;
  readonly notes?: string;
}

/**
 * Record a reference check (trust protocol phase b): the agent texts/calls
 * the provider's past clients with the scoring rubric; this records the
 * result. checkReferences() surfaces red flags at compare time.
 */
export function recordReference(
  doc: TrackerDocument,
  requestId: string,
  input: AddReferenceInput,
  now: string,
): { doc: TrackerDocument } {
  const request = findRequest(doc, requestId);
  if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) {
    throw new Error(`--score must be an integer 1–5, got "${String(input.score)}".`);
  }
  if (!input.providerName || input.providerName.trim().length === 0) throw new Error("--provider is required.");
  const name = input.providerName.trim();
  const updated: ServiceRequest = {
    ...request,
    references: [
      ...request.references,
      {
        providerId: providerSlug(name),
        providerName: name,
        score: input.score,
        notes: input.notes ?? "",
        at: now,
      },
    ],
    updatedAt: now,
  };
  const d1: TrackerDocument = {
    ...doc,
    serviceRequests: doc.serviceRequests.map((r) => (r.id === requestId ? updated : r)),
    updatedAt: now,
  };
  return {
    doc: logActivity(d1, "system", `Reference recorded for ${name} on request ${requestId}: ${input.score}/5.`, now),
  };
}

// ---------------------------------------------------------------------------
// Quote comparison (pure over state; format lives in ./format)
// ---------------------------------------------------------------------------

const AVAILABILITY_STOP_WORDS = new Set([
  "with", "from", "this", "that", "your", "you", "have", "need", "needs", "the",
  "and", "for", "are", "but", "not", "you", "all", "can", "had", "her", "was",
  "one", "our", "out", "has", "have", "week", "days", "day",
]);

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !AVAILABILITY_STOP_WORDS.has(w));
}

/**
 * Heuristic availability fit: does the provider's stated availability
 * share any content word with the request window? ("evenings this week"
 * vs "weekday evenings" ⇒ fits.) Anything subtler is for the human.
 */
export function availabilityFit(available: string | undefined, timingWindow: string): string {
  if (!available || available.trim().length === 0) return "not stated";
  const windowWords = new Set(contentWords(timingWindow));
  if (contentWords(available).some((w) => windowWords.has(w))) return "fits window";
  return "stated — check manually";
}

export interface ComparisonRow {
  readonly providerId: string;
  readonly providerName: string;
  readonly quote: ServiceQuote;
  readonly vsBudget: string;
  readonly availabilityFit: string;
  readonly screened: boolean;
  readonly referenceAvg?: number;
  readonly referenceCount: number;
  readonly redFlags: readonly string[];
  /** Qualified ⇒ has a quote, is screened, and has no reference red flags. */
  readonly qualified: boolean;
  readonly disqualifiedReason?: string;
}

export interface ComparisonResult {
  readonly rows: readonly ComparisonRow[];
  readonly recommendation: string;
}

/**
 * Side-by-side quote comparison. A provider is qualified only when all
 * three hold: a quote is on file, screening questions went out, and the
 * reference check is red-flag-free. Booking is recommendable only for a
 * qualified provider — the recommendation names the cheapest qualified
 * provider, or "no qualified provider" with each candidate's blocker.
 */
export function compareProviders(request: ServiceRequest): ComparisonResult {
  const byProvider = new Map<string, ServiceQuote>();
  for (const q of request.quotes) byProvider.set(q.providerId, q); // latest wins
  const rows: ComparisonRow[] = [];
  for (const quote of byProvider.values()) {
    const check = checkReferences(quote.providerName, request.references);
    const screened = request.screenedProviders.some((n) => providerSlug(n) === quote.providerId);
    const redFlags = check.redFlags;
    const diff = quote.amount - request.budgetCeiling;
    const vsBudget =
      diff > 0 ? `$${quote.amount} (+$${diff} over budget)` : diff < 0 ? `$${quote.amount} ($${-diff} under budget)` : `$${quote.amount} (at budget)`;
    let disqualifiedReason: string | undefined;
    if (redFlags.length > 0) disqualifiedReason = `red flags: ${redFlags.join("; ")}`;
    else if (!screened) disqualifiedReason = "screening questions not sent";
    rows.push({
      providerId: quote.providerId,
      providerName: quote.providerName,
      quote,
      vsBudget,
      availabilityFit: availabilityFit(quote.available, request.timingWindow),
      screened,
      referenceAvg: check.avg,
      referenceCount: check.count,
      redFlags,
      qualified: disqualifiedReason === undefined,
      disqualifiedReason,
    });
  }
  rows.sort((a, b) => a.quote.amount - b.quote.amount);
  const qualified = rows.filter((r) => r.qualified);
  const recommendation =
    qualified.length === 0
      ? `no qualified provider${rows.length > 0 ? ` — ${rows.map((r) => `${r.providerName} (${r.disqualifiedReason})`).join("; ")}` : " (no quotes yet)"}`
      : `Recommendation: ${qualified[0].providerName} — ${qualified[0].vsBudget}, screened, no reference red flags${qualified[0].referenceAvg !== undefined ? ` (ref avg ${qualified[0].referenceAvg.toFixed(1)}/5 over ${qualified[0].referenceCount})` : ""}.`;
  return { rows, recommendation };
}

// ---------------------------------------------------------------------------
// Follow-up: one nudge 48h after the last quote-request activity
// ---------------------------------------------------------------------------

export interface DueServiceNudge {
  readonly request: ServiceRequest;
}

/**
 * Which requests are due for their one follow-up nudge right now.
 * Single level, not escalating (mirrors the selling nudge pattern but
 * without the 24h/72h/7d ladder): a request still waiting on quotes gets
 * exactly one nudge, 48h after the last quote-request activity
 * (request opened or quote added), and only while it isn't booked/done/
 * cancelled. The nudge-staged timestamp is the one-shot guard — re-runs
 * never double-nudge.
 */
export function servicesNudgeDue(doc: TrackerDocument, nowIso: string): DueServiceNudge[] {
  const now = new Date(nowIso).getTime();
  return doc.serviceRequests.filter(
    (r) =>
      (r.status === "requested" || r.status === "quoted") &&
      !r.quoteNudgeSentAt &&
      now - new Date(r.lastQuoteActivityAt).getTime() >= NUDGE_AFTER_MS,
  ).map((request) => ({ request }));
}

/**
 * Stage the one follow-up nudge for a due request at `routine` tier.
 * Addresses the provider thread of the latest quote when known, otherwise
 * the request's service-thread placeholder.
 */
export function stageServiceNudge(
  doc: TrackerDocument,
  requestId: string,
  now: string,
): { doc: TrackerDocument; messageId: string; body: string } {
  const request = findRequest(doc, requestId);
  if (request.quoteNudgeSentAt) throw new Error(`Request ${requestId} was already nudged once — no second nudge.`);
  const last = request.quotes[request.quotes.length - 1];
  const body = [
    `Hey${last ? ` ${last.providerName}` : ""} — still waiting on a quote for: ${request.specs}.`,
    `What's your number and availability for ${request.timingWindow}?`,
  ].join("\n");
  const { doc: d1, message } = stageMessage(
    doc,
    {
      kind: "nudge",
      channel: "messenger",
      threadId: last?.threadId ?? `services:${requestId}`,
      recipient: last?.providerName ?? "prospective providers",
      body,
      sendAuthority: "routine",
    },
    now,
  );
  const updated: ServiceRequest = { ...request, quoteNudgeSentAt: now, updatedAt: now };
  const d2: TrackerDocument = {
    ...d1,
    serviceRequests: d1.serviceRequests.map((r) => (r.id === requestId ? updated : r)),
    updatedAt: now,
  };
  const d3 = logActivity(d2, "nudge", `48h quote follow-up nudge staged for request ${requestId}.`, now);
  return { doc: d3, messageId: message.id, body };
}

// ---------------------------------------------------------------------------
// Booking hard stop — nothing books without his explicit tap
// ---------------------------------------------------------------------------

/**
 * Stage a booking confirmation for his tap. This is the hard stop:
 * kind "booking" is in HARD_STOP_KINDS, so the staged message can NEVER
 * auto-send regardless of tier — it waits in the spurt for his approval
 * card. Nothing about the request status changes here; the request stays
 * "quoted" with bookingPendingFor set until approveServiceBooking runs.
 */
export function requestServiceBooking(
  doc: TrackerDocument,
  requestId: string,
  providerName: string,
  now: string,
): { doc: TrackerDocument; messageId: string; body: string } {
  const request = findRequest(doc, requestId);
  if (request.status !== "quoted") {
    throw new Error(`Cannot book request ${requestId} — status is "${request.status}" (need quotes first).`);
  }
  if (request.bookingPendingFor) {
    throw new Error(`Request ${requestId} already has a booking awaiting his tap for ${request.bookingPendingFor}.`);
  }
  if (!providerName || providerName.trim().length === 0) throw new Error("--provider is required.");
  const name = providerName.trim();
  const id = providerSlug(name);
  const quote = latestQuote(request, id);
  if (!quote) throw new Error(`No quote on file from ${name} for request ${requestId} — book only a provider who quoted.`);
  const body = [
    `Booking confirmation for your approval:`,
    `${name} — $${quote.amount} for "${request.specs}".`,
    `Window: ${request.timingWindow}. Budget: $${request.budgetCeiling}.`,
    `Approve with "marketplace services approve-booking --request ${requestId}" — nothing books without your tap.`,
  ].join("\n");
  const { doc: d1, message } = stageMessage(
    doc,
    {
      kind: "booking",
      channel: "messenger",
      threadId: quote.threadId ?? `services:${requestId}`,
      recipient: name,
      body,
      // Belt and suspenders: per_message tier AND kind "booking" is in
      // HARD_STOP_KINDS — flushOutbox can never auto-send this.
      sendAuthority: "per_message",
    },
    now,
  );
  const updated: ServiceRequest = { ...request, bookingPendingFor: name, updatedAt: now };
  const d2: TrackerDocument = {
    ...d1,
    serviceRequests: d1.serviceRequests.map((r) => (r.id === requestId ? updated : r)),
    updatedAt: now,
  };
  const d3 = logActivity(d2, "booking", `Booking staged for ${name} on request ${requestId} — awaiting his tap.`, now);
  return { doc: d3, messageId: message.id, body };
}

/**
 * His explicit tap: confirm the pending booking. Flips the request to
 * "booked", records the chosen provider, and updates the inventory row
 * (status "booked", cost = quoted amount). Throws unless a booking is
 * actually pending — there is no path to "booked" without book() first.
 */
export function approveServiceBooking(
  doc: TrackerDocument,
  requestId: string,
  now: string,
): { doc: TrackerDocument } {
  const request = findRequest(doc, requestId);
  if (!request.bookingPendingFor) {
    throw new Error(`No booking is pending approval on request ${requestId} — run "services book" first.`);
  }
  if (request.status !== "quoted") {
    throw new Error(`Cannot approve booking on request ${requestId} — status is "${request.status}".`);
  }
  const id = providerSlug(request.bookingPendingFor);
  const quote = latestQuote(request, id);
  const updated: ServiceRequest = {
    ...request,
    status: "booked",
    providerId: id,
    bookingPendingFor: undefined,
    updatedAt: now,
  };
  let d1: TrackerDocument = {
    ...doc,
    serviceRequests: doc.serviceRequests.map((r) => (r.id === requestId ? updated : r)),
    updatedAt: now,
  };
  // His CLI approval IS the tap: mark the staged booking confirmation sent.
  d1 = {
    ...d1,
    outbox: d1.outbox.map((m) =>
      m.kind === "booking" && m.threadId === (quote?.threadId ?? `services:${requestId}`) && (m.status === "pending" || m.status === "awaiting-tap")
        ? { ...m, status: "sent" as const, sentAt: now }
        : m,
    ),
  };
  d1 = syncInventoryServices(d1, updated, now);
  // Cost lands on the inventory row at booking time.
  d1 = {
    ...d1,
    inventory: {
      ...d1.inventory,
      services: d1.inventory.services.map((s) =>
        s.serviceRequestId === requestId && quote ? { ...s, cost: quote.amount, updatedAt: now } : s,
      ),
    },
  };
  const d2 = logActivity(
    d1,
    "booking",
    `BOOKED: ${request.bookingPendingFor} for request ${requestId}${quote ? ` at $${quote.amount}` : ""} — his tap confirmed.`,
    now,
  );
  return { doc: d2 };
}

// ---------------------------------------------------------------------------
// Post-service rating → provider trust (learning loop #6)
// ---------------------------------------------------------------------------

/**
 * Record his post-service 1–5 rating: updates the provider trust record
 * (running mean over his ratings — separate from buyer/seller contact
 * scores), marks the request and inventory row "done".
 */
export function rateService(
  doc: TrackerDocument,
  requestId: string,
  score: number,
  notes: string | undefined,
  now: string,
): { doc: TrackerDocument } {
  const request = findRequest(doc, requestId);
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw new Error(`--score must be an integer 1–5, got "${String(score)}".`);
  }
  if (request.status !== "booked") {
    throw new Error(`Cannot rate request ${requestId} — status is "${request.status}" (rate only after booking).`);
  }
  if (!request.providerId) throw new Error(`Request ${requestId} has no booked provider.`);
  const prev = doc.learning.providerTrust[request.providerId] ?? { score: 0, jobs: 0 };
  const jobs = prev.jobs + 1;
  const trust = {
    score: (prev.score * prev.jobs + score) / jobs,
    jobs,
    lastRating: score,
  };
  const updated: ServiceRequest = { ...request, status: "done", rating: score, updatedAt: now };
  let d1: TrackerDocument = {
    ...doc,
    serviceRequests: doc.serviceRequests.map((r) => (r.id === requestId ? updated : r)),
    learning: {
      ...doc.learning,
      providerTrust: { ...doc.learning.providerTrust, [request.providerId]: trust },
    },
    updatedAt: now,
  };
  d1 = syncInventoryServices(d1, updated, now);
  const d2 = logActivity(
    d1,
    "booking",
    `Service done: request ${requestId} rated ${score}/5${notes ? ` — ${notes}` : ""}. Provider trust now ${trust.score.toFixed(1)} over ${jobs} job(s).`,
    now,
  );
  return { doc: d2 };
}
