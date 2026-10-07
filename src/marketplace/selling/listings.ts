import { randomUUID } from "node:crypto";
import type { Listing, ListingKind, PriceReferenceCard, TrackerDocument } from "../types";
import { ACTIONS, assertAutonomous, sellingScope } from "../policy";
import { DEFAULT_CONFIG } from "../config";

/**
 * SELLING — listing management (ADR 0024).
 *
 * Manual listing creation is the FALLBACK. The primary entry point is the
 * photo-first intake (selling/intake.ts): Toozy uploads item photos in chat,
 * the operating agent analyzes them into a JSON sidecar, `selling intake`
 * validates + prints a one-tap approval summary, and publishes on approval.
 */

export interface CreateListingInput {
  readonly kind: ListingKind;
  readonly title: string;
  readonly price: number;
  readonly priceFirm?: boolean;
  readonly payment?: string;
  readonly meetup?: string;
  readonly description?: string;
  readonly fbListingId?: string;
  readonly holdTimeoutHours?: number;
  readonly terms?: Listing["terms"];
  /** Lowest price the agent may ever agree to. Unset → no counter below asking. */
  readonly floorPrice?: number;
  /** v3 Phase 4 (plan §9): the 25-mile price reference card captured at intake. */
  readonly priceCard?: PriceReferenceCard;
}

export function createListing(doc: TrackerDocument, input: CreateListingInput, nowIso: string): { doc: TrackerDocument; listing: Listing } {
  if (!input.title.trim()) throw new Error("Listing title is required.");
  if (!(input.price > 0)) throw new Error("Listing price must be positive.");
  const listing: Listing = {
    id: input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || randomUUID().slice(0, 8),
    kind: input.kind,
    title: input.title,
    price: input.price,
    priceFirm: input.priceFirm ?? true,
    payment: input.payment ?? "cash or Venmo",
    meetup: input.meetup ?? "Highland Village area — public meetup",
    description: input.description,
    fbListingId: input.fbListingId,
    status: "active",
    monitoring: true,
    holdTimeoutHours: input.holdTimeoutHours ?? DEFAULT_CONFIG.queue.holdTimeoutHours,
    floorPrice: input.floorPrice,
    terms: input.terms,
    priceCard: input.priceCard,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  return { doc: { ...doc, listings: [...doc.listings, listing], updatedAt: nowIso }, listing };
}

/** Price changes are approval-gated in every selling scope — never silent. */
export function updatePrice(doc: TrackerDocument, listingId: string, newPrice: number, nowIso: string): { doc: TrackerDocument; listing: Listing } {
  assertAutonomous(doc, sellingScope(listingId), ACTIONS.PRICE_CHANGE);
  if (!(newPrice > 0)) throw new Error("Price must be positive.");
  const listing = doc.listings.find((l) => l.id === listingId);
  if (!listing) throw new Error(`Unknown listing "${listingId}".`);
  const updated: Listing = { ...listing, price: newPrice, updatedAt: nowIso };
  return { doc: { ...doc, listings: doc.listings.map((l) => (l.id === listingId ? updated : l)), updatedAt: nowIso }, listing: updated };
}

export function setListingStatus(doc: TrackerDocument, listingId: string, status: Listing["status"], nowIso: string): TrackerDocument {
  const listing = doc.listings.find((l) => l.id === listingId);
  if (!listing) throw new Error(`Unknown listing "${listingId}".`);
  return {
    ...doc,
    listings: doc.listings.map((l) => (l.id === listingId ? { ...l, status, updatedAt: nowIso } : l)),
    updatedAt: nowIso,
  };
}

/** Attach the facebook-cli listing_id after a successful intake publish. */
export function attachFbListingId(doc: TrackerDocument, listingId: string, fbListingId: string, nowIso: string): TrackerDocument {
  return {
    ...doc,
    listings: doc.listings.map((l) => (l.id === listingId ? { ...l, fbListingId, updatedAt: nowIso } : l)),
    updatedAt: nowIso,
  };
}
