import { randomUUID } from "node:crypto";
import type { ContactRecord, NegotiationOutcome as StoredOutcome, OutboxMessage, TrackerDocument } from "../types";
import { logActivity } from "../state";
import { stageMessage } from "../outbox";

/**
 * BUYING — contact history in negotiation (v3 plan §3, Phase 2).
 *
 * Before first outreach to a seller in a hunt, look the seller up in the
 * cross-listing `contacts` store:
 *   - profile id hit first; normalized name match as the fallback,
 *   - reliabilityScore < 30 → SKIP the outreach (repeat flake): no message
 *     is staged, only an activity line. `--force` overrides the skip.
 *   - score >= 70 or goodDealCount > 0 → attach "known-good seller,
 *     consider firm opener" to the thread record.
 *
 * After hunt interactions resolve, recordHuntOutcome updates the contact
 * record (the single write path for hunt-side contact learning).
 */

/** Repeat-flake cutoff: sellers below this score are skipped on outreach. */
export const LOW_TRUST_SKIP_THRESHOLD = 30;
/** Known-good cutoff: these sellers get the firm-opener note. */
export const KNOWN_GOOD_TRUST_THRESHOLD = 70;
/** Score math for hunt outcomes — kept visible here so the learning loop is auditable. */
export const OUTCOME_SCORE_DELTA = { closed: 10, "walked-away": 0, flaked: -15 } as const;

export function normalizeContactName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface SellerRef {
  readonly profileId?: string;
  readonly name?: string;
}

export interface FoundContact {
  readonly id: string;
  readonly record: ContactRecord;
}

/** Find a contact by FB profile id, falling back to a normalized name match. */
export function findContact(doc: TrackerDocument, ref: SellerRef): FoundContact | undefined {
  if (ref.profileId && doc.contacts[ref.profileId]) {
    return { id: ref.profileId, record: doc.contacts[ref.profileId] };
  }
  const name = ref.name ? normalizeContactName(ref.name) : "";
  if (!name) return undefined;
  for (const [id, record] of Object.entries(doc.contacts)) {
    if (record.name && normalizeContactName(record.name) === name) return { id, record };
  }
  return undefined;
}

export function isKnownGood(record: ContactRecord): boolean {
  return record.reliabilityScore >= KNOWN_GOOD_TRUST_THRESHOLD || record.goodDealCount > 0;
}

export interface OutreachInput {
  readonly huntName: string;
  readonly profileId?: string;
  readonly sellerName?: string;
  /** Thread id for this seller; defaults to seller-<profileId|normalized-name>. */
  readonly threadId?: string;
  /** The discovery message body (the operating agent drafts the copy). */
  readonly message: string;
  /** Override a low-trust skip. */
  readonly force?: boolean;
}

export interface OutreachResult {
  doc: TrackerDocument;
  skipped: boolean;
  /** Contact id + score that drove the decision (undefined for unknown sellers). */
  contactId?: string;
  trustScore?: number;
  threadId?: string;
  /** Thread-record note attached for known-good sellers. */
  note?: string;
  message?: OutboxMessage;
}

/**
 * First outreach to a seller in a hunt, guarded by contact history.
 * Discovery messages stage at `routine` (standing authority, v3 plan §3) —
 * unless the seller is a repeat flake, in which case nothing is staged.
 */
export function outreachToSeller(doc: TrackerDocument, input: OutreachInput, nowIso: string): OutreachResult {
  const campaign = doc.campaigns.find((c) => c.name === input.huntName);
  if (!campaign) throw new Error(`Unknown hunt "${input.huntName}".`);
  if (campaign.status === "cancelled") throw new Error(`Hunt "${input.huntName}" is already cancelled.`);
  if (!input.profileId && !input.sellerName) throw new Error(`outreachToSeller needs a profileId or sellerName.`);

  const display = input.sellerName ?? input.profileId!;
  const found = findContact(doc, { profileId: input.profileId, name: input.sellerName });
  const score = found?.record.reliabilityScore;

  if (found && score !== undefined && score < LOW_TRUST_SKIP_THRESHOLD && !input.force) {
    const next = logActivity(doc, "hunt", `skipped ${display} — trust ${score}, repeat flake`, nowIso);
    return { doc: next, skipped: true, contactId: found.id, trustScore: score };
  }

  const threadId = input.threadId ?? `seller-${input.profileId ?? normalizeContactName(input.sellerName!).replace(/[^a-z0-9]+/g, "-")}`;
  let next = doc;
  if (!campaign.threads.includes(threadId)) {
    next = {
      ...next,
      campaigns: next.campaigns.map((c) =>
        c.id === campaign.id ? { ...c, threads: [...c.threads, threadId], updatedAt: nowIso } : c,
      ),
      updatedAt: nowIso,
    };
  }

  let note: string | undefined;
  if (found && isKnownGood(found.record)) {
    note = "known-good seller, consider firm opener";
    next = {
      ...next,
      campaigns: next.campaigns.map((c) =>
        c.id === campaign.id
          ? { ...c, threadNotes: { ...(c.threadNotes ?? {}), [threadId]: [...((c.threadNotes ?? {})[threadId] ?? []), note!] }, updatedAt: nowIso }
          : c,
      ),
      updatedAt: nowIso,
    };
  }
  if (found && input.force && score !== undefined && score < LOW_TRUST_SKIP_THRESHOLD) {
    next = logActivity(next, "hunt", `outreach forced for ${display} — trust ${score}`, nowIso);
  }

  const { doc: d2, message } = stageMessage(next, {
    kind: "reply",
    channel: "messenger",
    threadId,
    recipient: display,
    body: input.message,
    sendAuthority: "routine",
  }, nowIso);
  return { doc: d2, skipped: false, contactId: found?.id, trustScore: score, threadId, note, message };
}

// ---------------------------------------------------------------------------
// Hunt outcome recording — the single write path for hunt-side contact learning
// ---------------------------------------------------------------------------

export type HuntOutcomeType = "closed" | "walked-away" | "flaked";

export interface HuntOutcome {
  readonly type: HuntOutcomeType;
  readonly huntId?: string;
  readonly finalAmount?: number;
  /** Opener as % of the hunt ceiling — feeds the predictive-opener loop. */
  readonly openerPct?: number;
  /** Seller lowballed during the negotiation — feeds lowballRatio. */
  readonly lowballed?: boolean;
}

function blankContact(name: string | undefined, nowIso: string): ContactRecord {
  return {
    name,
    reliabilityScore: 50,
    interactionCount: 0,
    flakeCount: 0,
    lowballRatio: 0,
    goodDealCount: 0,
    firstSeen: nowIso,
    lastSeen: nowIso,
    notes: [],
  };
}

/**
 * Record how a hunt interaction with a contact resolved and update the
 * contact record accordingly (v3 plan §3, learning loop #2):
 *   - interactionCount++ on every outcome,
 *   - closed: goodDealCount++, score +10 (cap 100),
 *   - flaked: flakeCount++, score −15 (floor 0),
 *   - walked-away: our call, score unchanged,
 *   - lowballRatio recomputed as an incremental mean when `lowballed` is set,
 *   - the outcome also lands in learning.negotiationOutcomes for the
 *     predictive-opener loop.
 * Creates the contact record (neutral 50) when none exists yet.
 */
export function recordHuntOutcome(doc: TrackerDocument, contactId: string, outcome: HuntOutcome, nowIso: string): TrackerDocument {
  const prev = doc.contacts[contactId] ?? blankContact(undefined, nowIso);
  const interactionCount = prev.interactionCount + 1;
  const flakeCount = prev.flakeCount + (outcome.type === "flaked" ? 1 : 0);
  const goodDealCount = prev.goodDealCount + (outcome.type === "closed" ? 1 : 0);
  const prevLowballs = prev.lowballRatio * prev.interactionCount;
  const lowballRatio = Math.round(((prevLowballs + (outcome.lowballed ? 1 : 0)) / interactionCount) * 1000) / 1000;
  const delta = OUTCOME_SCORE_DELTA[outcome.type];
  const reliabilityScore = Math.min(100, Math.max(0, prev.reliabilityScore + delta));

  const record: ContactRecord = {
    ...prev,
    reliabilityScore,
    interactionCount,
    flakeCount,
    lowballRatio,
    goodDealCount,
    lastSeen: nowIso,
  };

  const stored: StoredOutcome = {
    contactId,
    huntId: outcome.huntId,
    outcome: outcome.type,
    finalAmount: outcome.finalAmount,
    openerPct: outcome.openerPct,
    at: nowIso,
  };
  const outcomeKey = `${contactId}:${outcome.huntId ?? randomUUID().slice(0, 8)}`;

  return {
    ...doc,
    contacts: { ...doc.contacts, [contactId]: record },
    learning: {
      ...doc.learning,
      negotiationOutcomes: { ...doc.learning.negotiationOutcomes, [outcomeKey]: stored },
    },
    updatedAt: nowIso,
  };
}
