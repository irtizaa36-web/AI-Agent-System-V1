import type { ApprovalWindowStats, TrackerDocument } from "../types";

/**
 * LEARNING loop #4 — approval windows (v3 plan §6.4, Phase 4).
 *
 * recordApprovalTap (outbox.ts) appends every owner tap timestamp to
 * learning.approvalTaps (rolling 14-day window). recomputeApprovalWindows
 * builds the per-hour-of-week tap distribution (168 slots, Mon 00:00 →
 * Sun 23:00, in his local time) and stores it on
 * approvalPatterns["hourly"].hourlyTapProbability. The approval-window
 * queue (plan §5) reads this to hold non-urgent messages for his likely
 * tap hours.
 */

export const APPROVAL_WINDOW_DAYS = 14;
const HOURS_PER_WEEK = 24 * 7;
/** Cap on stored tap timestamps — rolling window, newest-last. */
export const MAX_TAP_TIMESTAMPS = 500;

/** Hour-of-week slot for an ISO timestamp, in the given IANA timezone. */
export function hourOfWeek(iso: string, timeZone: string): number {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const dayIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[weekday] ?? 0;
  return dayIndex * 24 + hour;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Human label for an hour-of-week slot, e.g. "Mon 9am". */
export function hourOfWeekLabel(slot: number): string {
  const day = WEEKDAY_LABELS[Math.floor(slot / 24)];
  const h = slot % 24;
  const suffix = h < 12 ? "am" : "pm";
  const twelve = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${day} ${twelve}${suffix}`;
}

/**
 * Append a tap timestamp (newest-last), pruning to the rolling 14-day
 * window and the timestamp cap. Pure — used by outbox.recordApprovalTap.
 */
export function appendTapTimestamp(taps: readonly string[] | undefined, now: string): readonly string[] {
  const cutoff = new Date(new Date(now).getTime() - APPROVAL_WINDOW_DAYS * 86_400_000).getTime();
  const kept = [...(taps ?? []), now].filter((t) => new Date(t).getTime() >= cutoff);
  return kept.slice(-MAX_TAP_TIMESTAMPS);
}

export interface RecomputedWindows {
  readonly doc: TrackerDocument;
  /** Per-hour-of-week tap share (168 entries, sums to 1; all zero when no taps). */
  readonly hourlyTapProbability: readonly number[];
  /** Tap timestamps inside the window that fed the computation. */
  readonly tapsInWindow: number;
}

/**
 * Recompute the per-hour-of-week tap distribution from the rolling 14-day
 * tap history and store it on approvalPatterns["hourly"]. Pure state
 * transition; the returned doc is written back by the CLI.
 */
export function recomputeApprovalWindows(
  doc: TrackerDocument,
  now: string,
  timeZone: string = "America/Chicago",
): RecomputedWindows {
  const cutoff = new Date(new Date(now).getTime() - APPROVAL_WINDOW_DAYS * 86_400_000).getTime();
  const taps = (doc.learning.approvalTaps ?? []).filter((t) => {
    const ms = new Date(t).getTime();
    return ms >= cutoff && ms <= new Date(now).getTime();
  });
  const counts = new Array<number>(HOURS_PER_WEEK).fill(0);
  for (const t of taps) counts[hourOfWeek(t, timeZone)]++;
  const hourlyTapProbability: readonly number[] =
    taps.length === 0 ? counts : counts.map((c) => c / taps.length);
  const hourly: ApprovalWindowStats = {
    windowDays: APPROVAL_WINDOW_DAYS,
    tapCount: taps.length,
    avgTapDelayMinutes: 0,
    hourlyTapProbability,
    lastTapAt: taps.length > 0 ? taps[taps.length - 1] : undefined,
  };
  const next: TrackerDocument = {
    ...doc,
    learning: {
      ...doc.learning,
      approvalTaps: taps,
      approvalPatterns: { ...doc.learning.approvalPatterns, hourly },
    },
    updatedAt: now,
  };
  return { doc: next, hourlyTapProbability, tapsInWindow: taps.length };
}

/**
 * Top-N hour-of-week windows by tap probability, for the CLI readout.
 * Ties break toward the earlier slot — deterministic for tests.
 */
export function topWindows(hourly: readonly number[], n: number): Array<{ slot: number; label: string; probability: number }> {
  return hourly
    .map((probability, slot) => ({ slot, label: hourOfWeekLabel(slot), probability }))
    .filter((w) => w.probability > 0)
    .sort((a, b) => b.probability - a.probability || a.slot - b.slot)
    .slice(0, n);
}
