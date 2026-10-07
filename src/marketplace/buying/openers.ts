import type { NegotiationOutcome } from "../types";

/**
 * BUYING — predictive openers (v3 plan §3, learning loop #2).
 *
 * Learns from past hunts: computes close-rate by opener-percentage bucket
 * from learning.negotiationOutcomes, prefers the bucket with the best close
 * rate, then adjusts for seller signals:
 *   - relistCount >= 3 (urgency signal): −5pp
 *   - daysOnMarket > 21: −5pp
 *   - contactScore >= 70 (known-good): +5pp
 * With no usable history it defaults to 80% of ceiling and says so.
 *
 * Pure function, no network. The returned pctOfCeiling is a percentage —
 * the opener dollar amount is `pct/100 * hunt.maxPrice`.
 */

export interface HuntSpec {
  readonly maxPrice?: number;
  readonly criteria: string;
}

export interface SellerSignals {
  /** Times the listing has been relisted (urgency signal). */
  readonly relistCount?: number;
  /** Days the listing has been live. */
  readonly daysOnMarket?: number;
  /** Contact reliabilityScore from the contacts store, when known. */
  readonly contactScore?: number;
}

export interface OpenerSuggestion {
  /** Opener as a whole percentage of the hunt ceiling. */
  readonly pctOfCeiling: number;
  readonly rationale: string;
}

export interface Bucket {
  readonly label: string;
  readonly min: number; // inclusive
  readonly max: number; // exclusive
  readonly midpoint: number;
}

/** Opener-percentage buckets (shared with the learning analytics summary). */
export const BUCKETS: readonly Bucket[] = [
  { label: "<70%", min: 0, max: 70, midpoint: 65 },
  { label: "70–79%", min: 70, max: 80, midpoint: 75 },
  { label: "80–89%", min: 80, max: 90, midpoint: 85 },
  { label: "90–99%", min: 90, max: 100, midpoint: 95 },
  { label: "100%+", min: 100, max: Infinity, midpoint: 100 },
];

/** A bucket needs at least this many samples before its close rate is trusted. */
const MIN_BUCKET_SAMPLES = 2;

const DEFAULT_PCT = 80;
const RELIST_URGENCY_COUNT = 3;
const STALE_DAYS = 21;
const KNOWN_GOOD_SCORE = 70;
const ADJUST_PP = 5;

function adjustments(signals: SellerSignals): { pct: number; reasons: readonly string[] } {
  let pct = 0;
  const reasons: string[] = [];
  if ((signals.relistCount ?? 0) >= RELIST_URGENCY_COUNT) {
    pct -= ADJUST_PP;
    reasons.push(`−${ADJUST_PP} relist urgency (${signals.relistCount} relists)`);
  }
  if ((signals.daysOnMarket ?? 0) > STALE_DAYS) {
    pct -= ADJUST_PP;
    reasons.push(`−${ADJUST_PP} stale listing (${signals.daysOnMarket} days on market)`);
  }
  if ((signals.contactScore ?? 0) >= KNOWN_GOOD_SCORE) {
    pct += ADJUST_PP;
    reasons.push(`+${ADJUST_PP} known-good seller (trust ${signals.contactScore})`);
  }
  return { pct, reasons };
}

export function suggestOpener(
  hunt: HuntSpec,
  sellerSignals: SellerSignals = {},
  outcomes: readonly NegotiationOutcome[] = [],
): OpenerSuggestion {
  const adj = adjustments(sellerSignals);
  const adjText = adj.reasons.length > 0 ? ` Adjustments: ${adj.reasons.join(", ")}.` : "";

  const usable = outcomes.filter((o) => typeof o.openerPct === "number");
  if (usable.length === 0) {
    const pct = clamp(DEFAULT_PCT + adj.pct);
    return {
      pctOfCeiling: pct,
      rationale: `No opener history yet — defaulting to ${DEFAULT_PCT}% of the $${hunt.maxPrice ?? "?"} ceiling.${adjText}`,
    };
  }

  let best: { bucket: Bucket; closed: number; total: number } | undefined;
  for (const bucket of BUCKETS) {
    const inBucket = usable.filter((o) => o.openerPct! >= bucket.min && o.openerPct! < bucket.max);
    if (inBucket.length < MIN_BUCKET_SAMPLES) continue;
    const closed = inBucket.filter((o) => o.outcome === "closed").length;
    const rate = closed / inBucket.length;
    const bestRate = best ? best.closed / best.total : -1;
    // Ties (and the first eligible bucket) keep the earlier — i.e. lower —
    // bucket: when close rates match, prefer the cheaper opener.
    if (best === undefined || rate > bestRate) best = { bucket, closed, total: inBucket.length };
  }

  if (!best) {
    const pct = clamp(DEFAULT_PCT + adj.pct);
    return {
      pctOfCeiling: pct,
      rationale: `Only ${usable.length} opener sample(s) in history — not enough for a bucket (need ${MIN_BUCKET_SAMPLES}). Defaulting to ${DEFAULT_PCT}% of the ceiling.${adjText}`,
    };
  }

  const pct = clamp(best.bucket.midpoint + adj.pct);
  const ratePct = Math.round((best.closed / best.total) * 100);
  return {
    pctOfCeiling: pct,
    rationale: `Best close rate in history: ${ratePct}% (${best.closed}/${best.total}) in the ${best.bucket.label} bucket. Opening at ${pct}% of the $${hunt.maxPrice ?? "?"} ceiling.${adjText}`,
  };
}

function clamp(pct: number): number {
  return Math.min(100, Math.max(50, Math.round(pct)));
}
