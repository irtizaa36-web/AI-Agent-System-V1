import type { Lead, TrackerDocument } from "../types";
import { stageMessage } from "../outbox";
import { logActivity } from "../state";

/**
 * SELLING — first-inbound seller pre-filter (v3 plan §2).
 *
 * Before the normal flow touches a new lead, score the contact's trust
 * 0–100 from whatever signals we have. Below 40 the lead is auto-declined
 * with a polite close-out (logged in the digest); at/above 40 the score is
 * recorded on the lead and the normal flow continues.
 *
 * Live signal resolution lives in ./trust-live.ts (seller-info account
 * age, cross-post counting over repeated searches, price-history ledger).
 * The TrustSignalProvider seam below is the only place that performs
 * live lookups; the stub returns all-unknown signals and performs zero
 * network calls. Reverse image search stays stubbed — no feasible
 * credential-free tooling (see trust-live.ts header).
 */

export interface TrustSignals {
  /** FB account age in days. Undefined = unknown (no live lookup yet). */
  readonly accountAgeDays?: number;
  /** How many other listings reuse this contact's text/photos. */
  readonly crossPostCount?: number;
  /** 0..1 severity: their offer is wildly off the ask, or the listing price history looks manipulated. */
  readonly priceAnomaly?: number;
  /** Listing photos look like stock/catalog images. */
  readonly stockPhotoSuspect?: boolean;
  /** FB verified badge present. */
  readonly verifiedBadge?: boolean;
}

/**
 * Phase 4 seam: resolves live trust signals for a contact.
 * The stub implementation returns all-unknown signals and must stay
 * network-free; Phase 4 replaces it with the account-age + reverse-image
 * lookups.
 */
export interface TrustSignalProvider {
  getSignals(contactId: string, threadId: string): TrustSignals | Promise<TrustSignals>;
}

/** Stub: everything unknown. Zero network, zero side effects. */
export const StubTrustSignalProvider: TrustSignalProvider = {
  getSignals: () => ({}),
};

/** Score below this → auto-decline (v3 plan §2). */
export const PREFILTER_DECLINE_THRESHOLD = 40;

export interface TrustScore {
  readonly score: number;
  readonly reasons: readonly string[];
}

/**
 * Pure trust scorer.
 *
 * Weights (starting at a neutral 50, clamped 0–100):
 *   account age:  ≥2y +20 · ≥1y +15 · ≥180d +10 · ≥30d +5 · <7d −25
 *   cross-posts:  >5 −25 (spam pattern) · ≥3 −10
 *   price anomaly: −30 × severity (0..1)
 *   stock-photo suspect: −15
 *   verified badge: +10
 * Unknown signals score 0 — absence of data is not evidence either way.
 */
export function scoreContact(signals: TrustSignals): TrustScore {
  let score = 50;
  const reasons: string[] = [];

  const age = signals.accountAgeDays;
  if (age !== undefined) {
    if (age >= 730) { score += 20; reasons.push("account age ≥ 2y (+20)"); }
    else if (age >= 365) { score += 15; reasons.push("account age ≥ 1y (+15)"); }
    else if (age >= 180) { score += 10; reasons.push("account age ≥ 180d (+10)"); }
    else if (age >= 30) { score += 5; reasons.push("account age ≥ 30d (+5)"); }
    else if (age < 7) { score -= 25; reasons.push("brand-new account < 7d (−25)"); }
  }

  const cross = signals.crossPostCount;
  if (cross !== undefined) {
    if (cross > 5) { score -= 25; reasons.push(`${cross} cross-posts — spam pattern (−25)`); }
    else if (cross >= 3) { score -= 10; reasons.push(`${cross} cross-posts (−10)`); }
  }

  const anomaly = signals.priceAnomaly;
  if (anomaly !== undefined && anomaly > 0) {
    const hit = Math.round(30 * Math.min(1, anomaly));
    score -= hit;
    reasons.push(`price anomaly ${Math.round(Math.min(1, anomaly) * 100)}% (−${hit})`);
  }

  if (signals.stockPhotoSuspect) { score -= 15; reasons.push("stock-photo suspect (−15)"); }
  if (signals.verifiedBadge) { score += 10; reasons.push("verified badge (+10)"); }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}

export interface PrefilterResult {
  readonly doc: TrackerDocument;
  readonly score: number;
  readonly reasons: readonly string[];
  readonly declined: boolean;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

function recordTrustScore(doc: TrackerDocument, leadName: string, score: number, nowIso: string): TrackerDocument {
  return {
    ...doc,
    learning: {
      ...doc.learning,
      contactTrustScores: { ...doc.learning.contactTrustScores, [normalizeName(leadName)]: score },
    },
    updatedAt: nowIso,
  };
}

/**
 * Run the pre-filter on a lead with already-resolved signals.
 *
 * Score < 40: lead goes "dead" with a note, a digest-worthy activity line
 * is logged, and a polite decline is staged at the `routine` tier
 * (auto-sent on flush under his standing authority).
 * Score ≥ 40: the score + reasons are recorded on the lead and the score
 * is written into learning.contactTrustScores for Phase 2's inbound check;
 * the normal flow continues untouched.
 */
export function prefilterLead(
  doc: TrackerDocument,
  leadId: string,
  signals: TrustSignals,
  nowIso: string = new Date().toISOString(),
): PrefilterResult {
  const lead = doc.leads.find((l) => l.id === leadId);
  if (!lead) throw new Error(`Unknown lead "${leadId}".`);
  const { score, reasons } = scoreContact(signals);
  const reasonText = reasons.length > 0 ? reasons.join("; ") : "no signals";

  if (score < PREFILTER_DECLINE_THRESHOLD) {
    const updated: Lead = {
      ...lead,
      status: "dead",
      trustScore: score,
      trustReasons: reasons,
      notes: [...lead.notes, `Auto-declined at ${nowIso}: trust ${score} < ${PREFILTER_DECLINE_THRESHOLD} (${reasonText}).`],
    };
    let next: TrackerDocument = {
      ...doc,
      leads: doc.leads.map((l) => (l.id === leadId ? updated : l)),
      updatedAt: nowIso,
    };
    const listing = next.listings.find((l) => l.id === lead.listingId);
    const body = `Hey ${lead.name} — thanks for the interest in the ${listing?.title ?? "item"}, we're going to pass for now. Good luck with your search!`;
    next = stageMessage(next, {
      kind: "close-out",
      channel: lead.channel,
      threadId: lead.threadId,
      recipient: lead.name,
      body,
      listingId: lead.listingId,
      leadId: lead.id,
      sendAuthority: "routine",
    }, nowIso).doc;
    next = logActivity(
      next,
      "listing",
      `Auto-declined lead ${lead.name} on "${listing?.title ?? lead.listingId}" (trust ${score}).`,
      nowIso,
    );
    next = recordTrustScore(next, lead.name, score, nowIso);
    return { doc: next, score, reasons, declined: true };
  }

  const updated: Lead = { ...lead, trustScore: score, trustReasons: reasons };
  let next: TrackerDocument = {
    ...doc,
    leads: doc.leads.map((l) => (l.id === leadId ? updated : l)),
    updatedAt: nowIso,
  };
  next = recordTrustScore(next, lead.name, score, nowIso);
  return { doc: next, score, reasons, declined: false };
}
