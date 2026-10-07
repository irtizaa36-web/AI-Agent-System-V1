import { execFile } from "node:child_process";
import type { ObservedPrice, TrackerDocument } from "../types";
import {
  scoreContact,
  type TrustSignals,
  type TrustSignalProvider,
  type TrustScore,
} from "./prefilter";

/**
 * SELLING/SERVICES — live trust-signal resolution (v3, wired).
 *
 * prefilter.ts stays pure: scoreContact() is the tested scoring engine.
 * This module is the ONLY place that performs live trust lookups, behind
 * the TrustSignalProvider seam:
 *
 * - account age: `facebook-cli marketplace seller-info --listing-id`
 *   (trust_signals.account_age_in_years → days)
 * - cross-post duplicates: repeated `marketplace search` passes, grouped
 *   by seller_id (same seller, many distinct listings = spam pattern)
 * - price anomaly: (a) within-batch deviation below the batch median, and
 *   (b) our own observed-price ledger — the FB API exposes no price
 *   history, so v3 records every price it sees per listing_id and flags
 *   a re-sighting at a materially different price
 * - stock-photo / reverse image search: NOT wired — no free, credential-
 *   free reverse-image tooling exists on this machine (TinEye/Bing Visual
 *   Search need paid API keys; Google Lens has no API). The signal stays
 *   stubbed (undefined) and the scorer treats unknown as neutral.
 *
 * All lookups are read-only. Runners are injectable so tests never touch
 * the network.
 */

/** Runs `facebook-cli ...`. Injected so tests never hit the network. */
export type TrustRunner = (args: readonly string[]) => Promise<string>;

export function realTrustRunner(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "facebook-cli",
      [...args],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`facebook-cli lookup failed: ${stderr || error.message}`));
        else resolve(stdout);
      },
    );
  });
}

export interface SellerReputation {
  readonly sellerId: string;
  readonly sellerName?: string;
  readonly accountAgeYears?: number;
  readonly ratingAverage?: number;
  readonly ratingCount?: number;
}

function num(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/**
 * Live account-age (+ reputation for display) via seller-info.
 * Throws on lookup failure — callers degrade to unknown signals.
 */
export async function fetchSellerInfoSignals(
  listingId: string,
  runner: TrustRunner = realTrustRunner,
): Promise<{ signals: TrustSignals; reputation: SellerReputation }> {
  const stdout = await runner(["marketplace", "seller-info", "--listing-id", listingId]);
  const parsed = JSON.parse(stdout);
  const sellers = Array.isArray(parsed?.sellers) ? parsed.sellers : [];
  const first = sellers[0] ?? {};
  const trust = first.trust_signals ?? {};
  const ageYears = num(trust.account_age_in_years);
  const signals: TrustSignals = {};
  if (ageYears !== undefined) {
    return {
      signals: { ...signals, accountAgeDays: Math.round(ageYears * 365) },
      reputation: {
        sellerId: typeof first.seller_id === "string" ? first.seller_id : "",
        sellerName: typeof first.seller_name === "string" ? first.seller_name : undefined,
        accountAgeYears: ageYears,
        ratingAverage: num(trust.rating_average),
        ratingCount: num(trust.rating_count),
      },
    };
  }
  return {
    signals,
    reputation: {
      sellerId: typeof first.seller_id === "string" ? first.seller_id : "",
      sellerName: typeof first.seller_name === "string" ? first.seller_name : undefined,
      ratingAverage: num(trust.rating_average),
      ratingCount: num(trust.rating_count),
    },
  };
}

/**
 * Cross-post spam signal: how many DISTINCT listings share this seller_id
 * across the repeated discovery searches. Pure over already-fetched
 * results — zero extra network.
 */
export function countSellerCrossPosts(
  sellerId: string,
  perQueryResults: ReadonlyArray<ReadonlyArray<{ readonly listingId: string; readonly sellerId: string }>>,
): number {
  const ids = new Set<string>();
  for (const results of perQueryResults) {
    for (const r of results) {
      if (r.sellerId === sellerId && r.listingId) ids.add(r.listingId);
    }
  }
  return ids.size;
}

/**
 * Within-batch price anomaly (pure): how far below the batch median this
 * price sits, 0..1. Suspiciously cheap vs peers ⇒ possible scam/bait.
 * At/above median ⇒ 0 (no anomaly signal either way).
 */
export function batchPriceAnomaly(price: number | undefined, batchPrices: readonly number[]): number {
  if (price === undefined || batchPrices.length === 0) return 0;
  const sorted = [...batchPrices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  if (median <= 0 || price >= median) return 0;
  return Math.min(1, (median - price) / median);
}

/** Re-sighting at a ≥20% different price ⇒ anomaly; severity = relative change, capped at 1. */
export const RELIST_PRICE_CHANGE_THRESHOLD = 0.2;

/**
 * Single write path for the price-history ledger: records this sighting
 * and returns the anomaly vs the PREVIOUS sighting (undefined on first
 * sighting or when the change is immaterial).
 */
export function observePrice(
  doc: TrackerDocument,
  listingId: string,
  price: number,
  nowIso: string,
): { doc: TrackerDocument; anomaly?: number } {
  const prev: ObservedPrice | undefined = doc.learning.observedPrices?.[listingId];
  let anomaly: number | undefined;
  if (prev && prev.price > 0 && price > 0) {
    const change = Math.abs(price - prev.price) / prev.price;
    if (change >= RELIST_PRICE_CHANGE_THRESHOLD) anomaly = Math.min(1, change);
  }
  return {
    doc: {
      ...doc,
      learning: {
        ...doc.learning,
        observedPrices: {
          ...(doc.learning.observedPrices ?? {}),
          [listingId]: { price, at: nowIso },
        },
      },
      updatedAt: nowIso,
    },
    anomaly,
  };
}

export interface LiveTrustInput {
  readonly listingId: string;
  readonly sellerId?: string;
  readonly price?: number;
  /** Prices of the peer batch (e.g. same discovery pass) for the within-batch anomaly. */
  readonly batchPrices?: readonly number[];
  /**
   * Already-fetched per-query results for the cross-post count (zero extra
   * network). Omit when unavailable — the count stays unknown.
   */
  readonly perQueryResults?: ReadonlyArray<ReadonlyArray<{ readonly listingId: string; readonly sellerId: string }>>;
}

export interface LiveTrustResult {
  readonly signals: TrustSignals;
  readonly reputation: SellerReputation | undefined;
  readonly score: TrustScore;
}

/**
 * Resolve every live signal we can for one listing and score it.
 * Any single lookup may fail — failures degrade that signal to unknown,
 * never the whole resolution.
 */
export async function resolveLiveTrustSignals(
  input: LiveTrustInput,
  runner: TrustRunner = realTrustRunner,
): Promise<LiveTrustResult> {
  let signals: TrustSignals = {};
  let reputation: SellerReputation | undefined;
  try {
    const info = await fetchSellerInfoSignals(input.listingId, runner);
    signals = { ...signals, ...info.signals };
    reputation = info.reputation;
  } catch {
    // unknown — scorer treats absence as neutral
  }
  const sellerId = input.sellerId ?? reputation?.sellerId;
  if (sellerId && input.perQueryResults) {
    const cross = countSellerCrossPosts(sellerId, input.perQueryResults);
    if (cross > 0) signals = { ...signals, crossPostCount: cross };
  }
  const batchAnomaly = batchPriceAnomaly(input.price, input.batchPrices ?? []);
  if (batchAnomaly > 0) signals = { ...signals, priceAnomaly: batchAnomaly };
  // stockPhotoSuspect: intentionally left undefined — no feasible
  // credential-free reverse-image tooling (see module header).
  return { signals, reputation, score: scoreContact(signals) };
}

/**
 * Drop-in TrustSignalProvider: contactId is treated as a listing_id
 * (documented — the FB API keys seller lookups off listings, not bare
 * profile ids). threadId is unused by the live lookups.
 */
export function liveTrustSignalProvider(runner: TrustRunner = realTrustRunner): TrustSignalProvider {
  return {
    async getSignals(contactId: string, _threadId: string): Promise<TrustSignals> {
      const result = await resolveLiveTrustSignals({ listingId: contactId }, runner);
      return result.signals;
    },
  };
}
