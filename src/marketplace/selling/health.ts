import type { Listing, TrackerDocument } from "../types";
import { DEFAULT_CONFIG, type StaleDropConfig } from "../config";
import { ACTIONS, canAutonomous, sellingScope } from "../policy";
import { logParseFailure, parseJsonLenient } from "../parse";
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
  return readMyListingIds(stdout) ?? [];
}

/** Listing ids, or undefined when the payload can't be read (logged). */
function readMyListingIds(stdout: string): string[] | undefined {
  const parsed = parseJsonLenient(stdout, "health.my-listings");
  if (!parsed.ok) return undefined;
  const value = parsed.value;
  const items = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data) ? (value as { data: unknown[] }).data : undefined;
  if (!items) {
    logParseFailure("health.my-listings", "payload has no item array", stdout);
    return undefined;
  }
  return (items as any[]).map((i) => String(i?.listing_id ?? "")).filter(Boolean);
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
  // An unreadable payload must never read as "nothing is live" — that would retire every listing.
  const ids = readMyListingIds(stdout);
  if (ids === undefined) return { doc, retired: [] };
  const live = new Set(ids);
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

/**
 * STALE-LISTING AUTO-DROP (Karen upgrade 6). DISABLED BY DEFAULT
 * (config staleDrop.enabled = false): the mechanism exists, the owner
 * turns it on.
 *
 * A listing is stale after daysStale with no inquiry and no earlier drop.
 * Each drop cuts dropPercent off the current price (rounded to $5), never
 * below the floor — the listing's floorPrice, else floorFraction of its
 * original price. A listing already at its floor is left alone. Price
 * changes stay gated by the authority ledger: where "price-change" is not
 * autonomous, the drop is returned as needing the owner's approval
 * instead of being applied.
 */

export interface PriceDrop {
  readonly listingId: string;
  readonly title: string;
  readonly from: number;
  readonly to: number;
  readonly floor: number;
  readonly daysQuiet: number;
}

function dropFloor(listing: Listing, config: StaleDropConfig): number {
  const original = listing.originalPrice ?? listing.price;
  const byFraction = Math.ceil(original * config.floorFraction);
  return listing.floorPrice !== undefined && listing.floorPrice > 0 ? Math.max(listing.floorPrice, 1) : Math.max(byFraction, 1);
}

/** Drops that would happen now. Pure; ignores `enabled` so the digest can preview them. */
export function planStaleDrops(doc: TrackerDocument, nowIso: string, config: StaleDropConfig = DEFAULT_CONFIG.staleDrop): PriceDrop[] {
  const now = new Date(nowIso).getTime();
  const out: PriceDrop[] = [];
  for (const listing of doc.listings) {
    if (listing.status !== "active" || !listing.monitoring) continue;
    const leads = doc.leads.filter((l) => l.listingId === listing.id);
    const since = Math.max(
      new Date(listing.createdAt).getTime(),
      listing.lastPriceDropAt ? new Date(listing.lastPriceDropAt).getTime() : 0,
      ...leads.map((l) => new Date(l.firstSeenAt).getTime()),
    );
    const daysQuiet = (now - since) / (24 * 3600_000);
    if (!(daysQuiet >= config.daysStale)) continue;
    const floor = dropFloor(listing, config);
    if (listing.price <= floor) continue;
    const cut = Math.round((listing.price * (1 - config.dropPercent / 100)) / 5) * 5;
    const to = Math.max(floor, Math.min(cut, listing.price - 1));
    if (to >= listing.price) continue;
    out.push({ listingId: listing.id, title: listing.title, from: listing.price, to, floor, daysQuiet: Math.floor(daysQuiet) });
  }
  return out;
}

/**
 * Apply due drops. With the feature disabled (the default) nothing changes
 * and `disabled` is true. Drops without price-change authority come back
 * in `needsApproval`, unapplied.
 */
export function applyStaleDrops(
  doc: TrackerDocument,
  nowIso: string,
  config: StaleDropConfig = DEFAULT_CONFIG.staleDrop,
): { doc: TrackerDocument; applied: PriceDrop[]; needsApproval: PriceDrop[]; disabled: boolean } {
  if (!config.enabled) return { doc, applied: [], needsApproval: [], disabled: true };
  const planned = planStaleDrops(doc, nowIso, config);
  const applied: PriceDrop[] = [];
  const needsApproval: PriceDrop[] = [];
  let listings = doc.listings;
  for (const drop of planned) {
    if (!canAutonomous(doc, sellingScope(drop.listingId), ACTIONS.PRICE_CHANGE)) {
      needsApproval.push(drop);
      continue;
    }
    listings = listings.map((l) =>
      l.id === drop.listingId ? { ...l, originalPrice: l.originalPrice ?? l.price, price: drop.to, lastPriceDropAt: nowIso, updatedAt: nowIso } : l,
    );
    applied.push(drop);
  }
  if (applied.length === 0) return { doc, applied, needsApproval, disabled: false };
  return { doc: { ...doc, listings, updatedAt: nowIso }, applied, needsApproval, disabled: false };
}
