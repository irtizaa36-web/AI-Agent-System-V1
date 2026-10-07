import type { Listing, ListingStatus, PriceLadderDrop, TrackerDocument } from "../types";
import { logActivity } from "../state";

/**
 * SELLING — price ladders (v3 plan §2, his decision: auto-execute on schedule).
 *
 * At listing time Toozy approves a drop schedule (e.g. day 7 → $35,
 * day 14 → $30, floor $30). From then on the agent reprices itself — no
 * more 7-day-dead-then-ask. `apply-drops` (also wired into `sweep`)
 * executes every due drop, oldest-due-first, never below the floor.
 *
 * Authority note: a ladder executes WITHOUT a per-drop tap because the
 * schedule itself was owner-approved (`set-ladder` records approvedAt).
 * applyDueDrops therefore deliberately bypasses the policy gate — the
 * approval happened once, up front, at set-ladder time.
 */

/** Listing statuses that count as "live" for sweep/health processing. */
export const LIVE_LISTING_STATUSES: readonly ListingStatus[] = ["active", "price-dropped"];

export function isLiveListingStatus(status: ListingStatus): boolean {
  return (LIVE_LISTING_STATUSES as readonly string[]).includes(status);
}

/** Minimum recorded sales before the ladder is recomputed from history (v3 plan §6.1). */
export const LADDER_HISTORY_MIN_SALES = 5;

/** A ladder suggestion: the drop schedule Toozy approves at listing time. */
export interface LadderSuggestion {
  readonly drops: readonly PriceLadderDrop[];
  readonly floor: number;
  /** Why this schedule — static default or recomputed from history. */
  readonly basis: string;
  /** Recorded sales that fed the recomputation (0 when static). */
  readonly salesUsed: number;
}

/** Static default schedule: −$5 at day 7, −$10 at day 14, −$15 at day 21, floor −$20. */
export function defaultLadderSuggestion(listPrice: number): LadderSuggestion {
  const floor = Math.max(1, listPrice - 20);
  const drops = buildDrops(listPrice, [7, 14, 21], [listPrice - 5, listPrice - 10, listPrice - 15], floor);
  return {
    drops,
    floor,
    basis: "static default — fewer than 5 recorded sales (Day 7 → −$5, Day 14 → −$10, Day 21 → −$15, floor −$20)",
    salesUsed: 0,
  };
}

function buildDrops(listPrice: number, offsets: readonly number[], prices: readonly number[], floor: number): PriceLadderDrop[] {
  const drops: PriceLadderDrop[] = [];
  for (let i = 0; i < offsets.length; i++) {
    const price = Math.max(floor, Math.round(prices[i]));
    if (price <= 0 || price >= listPrice) continue;
    if (drops.length > 0 && price >= drops[drops.length - 1].price) continue; // strictly decreasing
    drops.push({ dayOffset: offsets[i], price });
  }
  if (drops.length === 0) drops.push({ dayOffset: offsets[0] ?? 7, price: floor });
  return drops;
}

function strictlyIncreasing(offsets: readonly number[]): number[] {
  const out: number[] = [];
  for (const o of offsets) {
    const prev = out[out.length - 1] ?? 0;
    out.push(Math.max(prev + 1, Math.max(1, Math.round(o))));
  }
  return out;
}

function round5(n: number): number {
  return Math.round(n / 5) * 5;
}

/** One-line rendering of a ladder suggestion for the intake summary. */
export function formatLadderSuggestion(s: LadderSuggestion): string {
  const drops = s.drops.map((d) => `Day ${d.dayOffset} → $${d.price}`).join(", ");
  return `Ladder suggestion (${s.basis}): ${drops}; floor $${s.floor}.`;
}

/**
 * LEARNING loop #1 — suggest a ladder for a new listing (v3 plan §6.1).
 *
 * Pure function over pricing history:
 * - <5 recorded sales → the static default schedule.
 * - ≥5 sales → recompute: average days-to-close sets the drop day offsets
 *   (avg, 2×avg, 3×avg), average final-vs-list ratio sets the drop sizes
 *   (expected total discount split across 3 drops, rounded to $5, floor =
 *   ratio-implied closing price). Drops never go below the floor.
 */
export function suggestLadder(doc: TrackerDocument, listPrice: number): LadderSuggestion {
  const history = doc.learning.pricingHistory;
  if (history.length < LADDER_HISTORY_MIN_SALES) return defaultLadderSuggestion(listPrice);
  const avgDays = history.reduce((s, o) => s + o.daysToClose, 0) / history.length;
  const ratios = history.filter((o) => o.listPrice !== undefined && o.listPrice > 0);
  if (ratios.length === 0) return defaultLadderSuggestion(listPrice);
  const avgRatio = ratios.reduce((s, o) => s + o.finalPrice / (o.listPrice as number), 0) / ratios.length;
  const totalDiscount = Math.max(0, listPrice * (1 - avgRatio));
  const step = Math.max(5, round5(totalDiscount / 3));
  const floor = Math.max(1, round5(listPrice - totalDiscount));
  const drops = buildDrops(listPrice, strictlyIncreasing([avgDays, avgDays * 2, avgDays * 3]), [listPrice - step, listPrice - 2 * step, listPrice - 3 * step], floor);
  return {
    drops,
    floor,
    basis: `recomputed from ${history.length} sales (avg ${avgDays.toFixed(1)}d to close, avg final-vs-list ${(avgRatio * 100).toFixed(0)}%)`,
    salesUsed: history.length,
  };
}

export interface DueDrop {
  readonly listing: Listing;
  /** Drops due right now, oldest-due-first, prices already clamped to the ladder floor. */
  readonly drops: readonly { readonly dayOffset: number; readonly price: number }[];
}

function daysSince(createdAt: string, nowIso: string): number {
  return (new Date(nowIso).getTime() - new Date(createdAt).getTime()) / 86_400_000;
}

/**
 * Pure read: which listings have a drop due right now.
 *
 * A drop is due when:
 * - the listing has an owner-approved ladder (approvedAt set),
 * - the listing is live (active or already price-dropped),
 * - the drop's dayOffset has elapsed since listing creation,
 * - the drop is not in the ladder's appliedDrops record (idempotency),
 * - the resulting price is at/above the floor (enforced by clamping).
 */
export function evaluateLadders(doc: TrackerDocument, nowIso: string): DueDrop[] {
  const due: DueDrop[] = [];
  for (const listing of doc.listings) {
    const ladder = listing.priceLadder;
    if (!ladder || ladder.approvedAt === undefined) continue;
    if (!isLiveListingStatus(listing.status)) continue;
    const elapsedDays = daysSince(listing.createdAt, nowIso);
    const applied = new Set(ladder.appliedDrops ?? []);
    const drops = [...ladder.drops]
      .filter((d) => !applied.has(d.dayOffset) && d.dayOffset <= elapsedDays)
      .sort((a, b) => a.dayOffset - b.dayOffset)
      .map((d) => ({ dayOffset: d.dayOffset, price: Math.max(d.price, ladder.floor) }));
    if (drops.length > 0) due.push({ listing, drops });
  }
  return due;
}

export interface AppliedDrop {
  readonly listingId: string;
  readonly title: string;
  readonly from: number;
  readonly to: number;
  /** The newest drop executed in this pass (oldest-due-first ordering). */
  readonly dayOffset: number;
}

/**
 * Execute every due drop, oldest-due-first. Sets the listing price, flips
 * the status to "price-dropped", logs an activity line, and mirrors the new
 * price + ladder state onto the linked running-inventory item (plan §10).
 * Never below the floor (clamped in evaluateLadders).
 */
export function applyDueDrops(doc: TrackerDocument, nowIso: string): { doc: TrackerDocument; applied: AppliedDrop[] } {
  const due = evaluateLadders(doc, nowIso);
  let next = doc;
  const applied: AppliedDrop[] = [];
  for (const { listing, drops } of due) {
    const final = drops[drops.length - 1];
    const from = listing.price;
    const ladder = listing.priceLadder!;
    const updatedLadder = {
      ...ladder,
      appliedDrops: [...(ladder.appliedDrops ?? []), ...drops.map((d) => d.dayOffset)],
    };
    const updated: Listing = {
      ...listing,
      price: final.price,
      priceLadder: updatedLadder,
      status: "price-dropped",
      updatedAt: nowIso,
    };
    next = {
      ...next,
      listings: next.listings.map((l) => (l.id === listing.id ? updated : l)),
      updatedAt: nowIso,
    };
    next = {
      ...next,
      inventory: {
        ...next.inventory,
        items: next.inventory.items.map((i) =>
          i.listingId === listing.id
            ? { ...i, listPrice: final.price, priceLadder: updatedLadder, status: "price-dropped" as const, updatedAt: nowIso }
            : i,
        ),
      },
      updatedAt: nowIso,
    };
    next = logActivity(
      next,
      "listing",
      `Price ladder: "${listing.title}" $${from} → $${final.price} (drop day ${final.dayOffset}, floor $${ladder.floor}).`,
      nowIso,
    );
    applied.push({ listingId: listing.id, title: listing.title, from, to: final.price, dayOffset: final.dayOffset });
  }
  return { doc: next, applied };
}
