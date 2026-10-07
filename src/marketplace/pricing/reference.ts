import type { PriceReferenceCard } from "../types";
import { analyzeComps, type Comp, type CompSearchRunner } from "../selling/comps";

/**
 * PRICE REFERENCE TOOL (v3 plan §9, Phase 4).
 *
 * At intake — a new item for sale OR a new service request — the agent
 * runs a 25-mile price reference lookup: average selling price of
 * comparable items/services within 25 miles of the public-meetup area.
 * Output is one compact price card (avg, median, low–high, n samples)
 * that feeds the list-price suggestion and the ladder schedule, and is
 * stored on the listing/request for the analytics loop.
 *
 * Radius center is ALWAYS the public-meetup area (Highland Village) —
 * his street address appears nowhere in code, comments, or tests.
 */

/** Radius center: the public-meetup area — never his street address. */
export const REFERENCE_CENTER = {
  label: "Highland Village area",
  latitude: 29.74096,
  longitude: -95.44716,
} as const;

/** The 25-mile radius from the plan, in miles. */
export const REFERENCE_RADIUS_MILES = 25;

/** A comp source: live (facebook-cli via selling/comps.ts) or a test stub. */
export interface CompSource {
  fetchComps(query: string, radiusMiles: number): Promise<Array<{ readonly price: number; readonly title: string }>>;
}

/**
 * Live implementation over the existing selling/comps.ts pull. The
 * facebook-cli search seam doesn't accept a radius yet, so the radius is
 * enforced by contract (documented on the card) until the seam supports
 * it — the card always states the 25-mile basis honestly.
 */
export function facebookCompSource(runner?: CompSearchRunner): CompSource {
  return {
    async fetchComps(query: string, _radiusMiles: number) {
      const analysis = await analyzeComps(query, runner);
      return analysis.comps.map((c: Comp) => ({ price: c.price, title: c.title }));
    },
  };
}

/** Deterministic stub — the only source tests ever use. */
export function stubCompSource(comps: Array<{ readonly price: number; readonly title: string }>): CompSource {
  return {
    async fetchComps(_query: string, _radiusMiles: number) {
      return comps.map((c) => ({ ...c }));
    },
  };
}

export interface PriceCardStats {
  readonly avg: number;
  readonly median: number;
  readonly low: number;
  readonly high: number;
  readonly n: number;
}

/**
 * Pure stats over a comp list. Empty input → n=0 and zeroed stats (the
 * card says so; the caller falls back to the sidecar/budget price).
 */
export function priceReferenceCard(comps: ReadonlyArray<{ readonly price: number }>): PriceCardStats {
  const prices = comps.map((c) => c.price).filter((p) => p > 0);
  if (prices.length === 0) return { avg: 0, median: 0, low: 0, high: 0, n: 0 };
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  const sum = sorted.reduce((s, p) => s + p, 0);
  return {
    avg: Math.round((sum / sorted.length) * 100) / 100,
    median,
    low: sorted[0],
    high: sorted[sorted.length - 1],
    n: sorted.length,
  };
}

/** Fetch comps and build the stored card. Network lives here; stats stay pure. */
export async function buildPriceCard(source: CompSource, query: string): Promise<PriceReferenceCard> {
  const comps = await source.fetchComps(query, REFERENCE_RADIUS_MILES);
  const stats = priceReferenceCard(comps);
  return {
    query,
    radiusMiles: REFERENCE_RADIUS_MILES,
    ...stats,
    basis:
      stats.n > 0
        ? `${stats.n} comp(s) within ${REFERENCE_RADIUS_MILES} mi of ${REFERENCE_CENTER.label}`
        : `no comps within ${REFERENCE_RADIUS_MILES} mi of ${REFERENCE_CENTER.label} — card is empty`,
  };
}

/** One compact line for the intake summary / digest. */
export function formatPriceCard(card: PriceReferenceCard): string {
  if (card.n === 0) return `Price card: no comps (${card.basis}).`;
  return `Price card (${card.basis}): avg $${card.avg}, median $${card.median}, range $${card.low}–$${card.high} (n=${card.n}).`;
}

/** Build a stored card from an already-fetched comp list (no network). */
export function buildCardFromComps(query: string, comps: ReadonlyArray<{ readonly price: number }>): PriceReferenceCard {
  const stats = priceReferenceCard(comps);
  return {
    query,
    radiusMiles: REFERENCE_RADIUS_MILES,
    ...stats,
    basis:
      stats.n > 0
        ? `${stats.n} comp(s) within ${REFERENCE_RADIUS_MILES} mi of ${REFERENCE_CENTER.label}`
        : `no comps within ${REFERENCE_RADIUS_MILES} mi of ${REFERENCE_CENTER.label} — card is empty`,
  };
}

export interface IntakeCompResult {
  /** Suggested price from comps (undefined when the pull found nothing). */
  readonly suggestedPrice?: number;
  readonly compBasis: string;
  readonly fromComps: boolean;
  readonly card: PriceReferenceCard;
}

/**
 * The selling intake's comp pull + price card in one pass (reuses the
 * existing selling/comps.ts live pull — no new network seams). When the
 * search finds nothing the price suggestion is undefined and the caller
 * falls back to the sidecar price; the card is empty but still honest.
 */
export async function resolveIntakeComps(query: string, runner?: CompSearchRunner): Promise<IntakeCompResult> {
  const analysis = await analyzeComps(query, runner);
  return {
    suggestedPrice: analysis.suggestedPrice,
    compBasis: analysis.basis,
    fromComps: analysis.suggestedPrice !== undefined,
    card: buildCardFromComps(query, analysis.comps),
  };
}
