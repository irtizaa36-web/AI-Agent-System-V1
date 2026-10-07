import type { Listing, TrackerDocument } from "../types";
import { isLiveListingStatus } from "./ladder";

/**
 * SELLING — self-healing listings (ADR 0024).
 *
 * - A listing with zero inquiries in STALE_AFTER_DAYS triggers a one-tap
 *   suggestion: price-drop, refresh (repost), or retire.
 * - A listing whose facebook-cli id no longer appears in `my-listings`
 *   (delisted or sold elsewhere) is retired automatically.
 */

export const STALE_AFTER_DAYS = 7;

export type HealingAction = "price-drop" | "refresh" | "retire";

export interface HealingSuggestion {
  readonly listingId: string;
  readonly title: string;
  readonly reason: string;
  readonly action: HealingAction;
  /** For price-drop: suggested new price (10% under current, rounded to $5). */
  readonly suggestedPrice?: number;
}

/** Listings with no lead activity in STALE_AFTER_DAYS. */
export function detectStaleListings(doc: TrackerDocument, nowIso: string, staleAfterDays = STALE_AFTER_DAYS): HealingSuggestion[] {
  const now = new Date(nowIso).getTime();
  const out: HealingSuggestion[] = [];
  for (const listing of doc.listings) {
    if (!isLiveListingStatus(listing.status) || !listing.monitoring) continue;
    const leads = doc.leads.filter((l) => l.listingId === listing.id);
    const latest = leads.reduce((max, l) => Math.max(max, new Date(l.lastContactAt).getTime()), new Date(listing.createdAt).getTime());
    const daysQuiet = (now - latest) / (24 * 3600_000);
    if (daysQuiet >= staleAfterDays) {
      const suggestedPrice = Math.round((listing.price * 0.9) / 5) * 5;
      out.push({
        listingId: listing.id,
        title: listing.title,
        reason: `No inquiries in ${Math.floor(daysQuiet)} days.`,
        action: "price-drop",
        suggestedPrice,
      });
    }
  }
  return out;
}

/** Runner for `facebook-cli marketplace my-listings`. Injected for tests. */
export type MyListingsRunner = (args: readonly string[]) => Promise<string>;

export function parseMyListingIds(stdout: string): string[] {
  try {
    const parsed = JSON.parse(stdout);
    const items = Array.isArray(parsed) ? parsed : parsed?.data ?? [];
    if (!Array.isArray(items)) return [];
    return items.map((i) => String(i?.listing_id ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Retire listings whose FB id vanished from my-listings (delisted or sold
 * elsewhere). Returns the retired listing ids.
 */
export async function retireMissingListings(
  doc: TrackerDocument,
  runner: MyListingsRunner,
  nowIso: string,
): Promise<{ doc: TrackerDocument; retired: Listing[] }> {
  let stdout: string;
  try {
    stdout = await runner(["marketplace", "my-listings", "--limit", "20"]);
  } catch {
    return { doc, retired: [] };
  }
  const live = new Set(parseMyListingIds(stdout));
  const retired: Listing[] = [];
  const listings = doc.listings.map((l) => {
    if (isLiveListingStatus(l.status) && l.fbListingId && !live.has(l.fbListingId)) {
      retired.push(l);
      return { ...l, status: "sold" as const, monitoring: false, updatedAt: nowIso };
    }
    return l;
  });
  if (retired.length === 0) return { doc, retired };
  return { doc: { ...doc, listings, updatedAt: nowIso }, retired };
}
