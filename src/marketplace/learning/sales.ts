import type { PricingOutcome, TrackerDocument } from "../types";
import { logActivity } from "../state";

/**
 * LEARNING loop #1 — pricing (v3 plan §6.1, Phase 4).
 *
 * Every sale outcome is appended to learning.pricingHistory. Every 5
 * recorded sales, suggestLadder (selling/ladder.ts) recomputes the ladder
 * schedule from history: average days-to-close sets the drop day offsets,
 * average final-vs-list ratio sets the drop sizes. With fewer than 5 sales
 * it returns the static default schedule.
 */

export interface SaleOutcomeInput {
  readonly itemId: string;
  readonly listPrice?: number;
  readonly finalPrice: number;
  readonly soldAt: string;
}

/**
 * Record a sale outcome. daysToClose is derived from the listing's
 * createdAt when the listing still exists; listPrice falls back to the
 * listing price when not given. Pure state transition — returns the next
 * document and the recorded outcome.
 */
export function recordSaleOutcome(
  doc: TrackerDocument,
  input: SaleOutcomeInput,
): { doc: TrackerDocument; outcome: PricingOutcome } {
  const listing = doc.listings.find((l) => l.id === input.itemId);
  const listPrice = input.listPrice ?? listing?.price;
  const createdAt = listing?.createdAt;
  const daysToClose =
    createdAt !== undefined
      ? Math.max(0, Math.round(((new Date(input.soldAt).getTime() - new Date(createdAt).getTime()) / 86_400_000) * 10) / 10)
      : 0;
  const outcome: PricingOutcome = {
    itemId: input.itemId,
    listPrice,
    finalPrice: input.finalPrice,
    soldAt: input.soldAt,
    daysToClose,
  };
  const next: TrackerDocument = {
    ...doc,
    learning: {
      ...doc.learning,
      pricingHistory: [...doc.learning.pricingHistory, outcome],
    },
    updatedAt: input.soldAt,
  };
  const logged = logActivity(
    next,
    "listing",
    `Sale recorded for learning: "${listing?.title ?? input.itemId}" $${listPrice ?? "?"} → $${input.finalPrice} in ${daysToClose}d (${next.learning.pricingHistory.length} sale(s) in history).`,
    input.soldAt,
  );
  return { doc: logged, outcome };
}

/** Pricing history shared by the ladder suggestor and the analytics summary. */
export function pricingStats(history: readonly PricingOutcome[]): {
  readonly sales: number;
  readonly avgDaysToClose: number;
  readonly avgFinalVsList: number;
} {
  if (history.length === 0) return { sales: 0, avgDaysToClose: 0, avgFinalVsList: 0 };
  const avgDaysToClose = history.reduce((s, o) => s + o.daysToClose, 0) / history.length;
  const ratios = history.filter((o) => o.listPrice !== undefined && o.listPrice > 0);
  const avgFinalVsList =
    ratios.length > 0 ? ratios.reduce((s, o) => s + o.finalPrice / (o.listPrice as number), 0) / ratios.length : 0;
  return { sales: history.length, avgDaysToClose, avgFinalVsList };
}
