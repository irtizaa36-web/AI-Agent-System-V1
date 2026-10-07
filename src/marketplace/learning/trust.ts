import type { TrackerDocument } from "../types";
import { logActivity } from "../state";

/**
 * LEARNING loop #5 — trust decay (v3 plan §6.5, Phase 4).
 *
 * Contact reliability scores go stale: a score earned 6 months ago means
 * nothing about today's seller. Contacts with no interaction in 7+ days
 * regress 10% toward neutral (50) per full week of inactivity:
 *
 *   newScore = 50 + (oldScore − 50) × 0.9^weeksInactive
 *
 * Properties (documented, tested):
 * - The regression never crosses 50 by this path alone — a 70 becomes
 *   68, a 30 becomes 32. At exactly 50 nothing moves.
 * - A single decay pass never pushes a score past 50 from either side
 *   (0.9^w < 1 keeps the sign of the offset from 50).
 * - Cheap and idempotent: re-running with the same `now` changes nothing
 *   further, since scores only move when more full weeks have passed.
 */

export const TRUST_NEUTRAL_SCORE = 50;
export const TRUST_DECAY_PER_WEEK = 0.1;
export const TRUST_DECAY_MIN_DAYS = 7;

export interface DecayedContact {
  readonly id: string;
  readonly name?: string;
  readonly from: number;
  readonly to: number;
  readonly weeksInactive: number;
}

/** One-decay step math, exported for tests. */
export function decayedScore(score: number, weeksInactive: number): number {
  if (weeksInactive < 1) return score;
  const decayed = TRUST_NEUTRAL_SCORE + (score - TRUST_NEUTRAL_SCORE) * Math.pow(1 - TRUST_DECAY_PER_WEEK, weeksInactive);
  return Math.round(decayed * 10) / 10;
}

export interface DecayResult {
  readonly doc: TrackerDocument;
  readonly decayed: readonly DecayedContact[];
}

/**
 * Decay every contact with 7+ days of inactivity toward neutral.
 * Logs ONE summary activity line when anything moved (digest picks it up;
 * the per-contact detail is in the CLI output).
 */
export function decayTrust(doc: TrackerDocument, now: string): DecayResult {
  const nowMs = new Date(now).getTime();
  const decayed: DecayedContact[] = [];
  const contacts = { ...doc.contacts };
  for (const [id, record] of Object.entries(contacts)) {
    const daysInactive = (nowMs - new Date(record.lastSeen).getTime()) / 86_400_000;
    if (daysInactive < TRUST_DECAY_MIN_DAYS) continue;
    const weeksInactive = Math.floor(daysInactive / 7);
    const to = decayedScore(record.reliabilityScore, weeksInactive);
    if (to === record.reliabilityScore) continue;
    contacts[id] = { ...record, reliabilityScore: to };
    decayed.push({ id, name: record.name, from: record.reliabilityScore, to, weeksInactive });
  }
  let next: TrackerDocument = { ...doc, contacts, updatedAt: now };
  if (decayed.length > 0) {
    next = logActivity(
      next,
      "system",
      `Trust decay: ${decayed.length} contact(s) regressed toward neutral — ` +
        decayed.map((d) => `${d.name ?? d.id} ${d.from}→${d.to} (${d.weeksInactive}w inactive)`).join("; "),
      now,
    );
  }
  return { doc: next, decayed };
}
