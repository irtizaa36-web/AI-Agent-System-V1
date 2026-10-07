/**
 * Marketplace Agent v2 — shared types (ADR 0024).
 *
 * The whole agent is organized around two mechanisms:
 *   SELLING — everything inbound: listings, buyer queues, confirmations, pickups, rentals.
 *   BUYING  — everything outbound: hunts, sweeps, seller outreach, offers, purchases.
 * Everything else in this directory is shared by both.
 */

/** Inbound channel a lead event arrived on. */
export type Channel = "messenger" | "voice-sms" | "agentmail";

export type ListingKind = "sale" | "rental";
/**
 * A listing whose price dropped via its owner-approved ladder reads
 * "price-dropped" instead of "active" — it is still a LIVE listing (still
 * monitored, still in the queue/sweep loops); the distinct status is for
 * the inventory readout and digest. Use LIVE_LISTING_STATUSES (selling/ladder.ts)
 * whenever "live" is what you mean.
 */
export type ListingStatus = "active" | "price-dropped" | "paused" | "sold";

/**
 * An owner-approved price-drop schedule (v3 plan §2). Once Toozy approves the
 * schedule at listing time, drops auto-execute on schedule — no more
 * 7-day-dead-then-ask. `floor` is the hard bottom the ladder never crosses.
 */
export interface PriceLadderDrop {
  readonly dayOffset: number;
  readonly price: number;
}

export interface PriceLadder {
  readonly drops: readonly PriceLadderDrop[];
  readonly floor: number;
  readonly approvedAt?: string;
  /**
   * Day offsets of drops already executed (oldest-due-first). This is the
   * idempotency record — evaluateLadders skips these, so a second
   * apply-drops run never re-applies a drop even if the price was later
   * changed by hand.
   */
  readonly appliedDrops?: readonly number[];
}

export interface RentalTerms {
  readonly dayRate: number;
  readonly deposit: number;
  readonly depositMethods: readonly string[];
  /** When the deposit changes hands. */
  readonly depositPaidAt: "pickup" | "booking";
  readonly solutionIncluded: string;
  readonly extraSolutionPrice: number;
  readonly pickupReturn: string;
}

export interface Listing {
  readonly id: string;
  readonly kind: ListingKind;
  readonly title: string;
  /** Sale price, or $/day for rentals. */
  readonly price: number;
  readonly priceFirm: boolean;
  readonly payment: string;
  /** Public-meetup language only — never a street address. */
  readonly meetup: string;
  readonly description?: string;
  /** facebook-cli listing_id once published. */
  readonly fbListingId?: string;
  readonly status: ListingStatus;
  /** Inquiry monitoring enabled (cron watches this listing's threads). */
  readonly monitoring: boolean;
  /** Hours an unconfirmed hold lives before the queue auto-advances. */
  readonly holdTimeoutHours: number;
  readonly terms?: RentalTerms;
  /** v3: owner-approved drop schedule; auto-executes once approved (plan §2). */
  readonly priceLadder?: PriceLadder;
  /**
   * v3 Phase 4 (plan §9): the 25-mile price reference card captured at
   * intake. Stored on the listing so the analytics loop can compare
   * list/sale prices against the card later.
   */
  readonly priceCard?: PriceReferenceCard;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type LeadStatus =
  | "new"
  | "contacted"
  | "hold"
  | "confirmed"
  | "deferred"
  | "dead";

/**
 * Per-thread (or per-message) send authority tier (v3 plan §5).
 * - "auto": routine negotiation, nudges, scheduled drops — send freely.
 * - "routine": staged under standing authority, no per-message tap needed.
 * - "per_message": held for his tap; the approval card is the gate.
 */
export type SendAuthority = "auto" | "routine" | "per_message";

/** Per-thread send authority; defaults to "per_message" when the lead doesn't set one. */
export function leadSendAuthority(lead: Lead): SendAuthority {
  return lead.sendAuthority ?? "per_message";
}

export interface Lead {
  readonly id: string;
  readonly listingId: string;
  readonly name: string;
  readonly threadId: string;
  readonly channel: Channel;
  readonly status: LeadStatus;
  readonly queuePosition: number;
  readonly firstSeenAt: string;
  readonly lastContactAt: string;
  readonly holdExpiresAt?: string;
  readonly pickupAt?: string;
  readonly ownerRepliedAt?: string;
  /** False once the owner has handled the thread himself — agent stands down. */
  readonly needsAgentFollowUp: boolean;
  /** Thread turn-state for the nudge cadence: who are we waiting on? */
  readonly awaiting: "them" | "us";
  /** Escalating nudge level already sent: 0 = none, 1 = gentle, 2 = firm, 3 = final-call. */
  readonly nudgeLevel: number;
  readonly lastNudgeAt?: string;
  /** v3: per-thread send authority. Absent ⇒ "per_message" (see leadSendAuthority). */
  readonly sendAuthority?: SendAuthority;
  /** v3: pre-filter trust score from the first-inbound screen (plan §2). Absent ⇒ not yet screened. */
  readonly trustScore?: number;
  /** Why the trust score landed where it did (one short reason per signal). */
  readonly trustReasons?: readonly string[];
  readonly notes: readonly string[];
}

export type CampaignStatus = "active" | "paused" | "cancelled";

/** A BUYING hunt: outbound deal search with criteria and a walk-away point. */
export interface Offer {
  readonly threadId: string;
  readonly amount: number;
  /** "ours" = agent's offer, "theirs" = seller's ask/counter. */
  readonly kind: "ours" | "theirs";
  readonly at: string;
}

export interface Campaign {
  readonly id: string;
  readonly name: string;
  readonly status: CampaignStatus;
  readonly criteria: string;
  readonly maxPrice?: number;
  /** Messenger thread ids under management for this hunt. */
  readonly threads: readonly string[];
  /** Offer history per thread (both sides). Walk-away decisions read this. */
  readonly offers: readonly Offer[];
  /**
   * Per-thread notes (v3 plan §3, Phase 2): e.g. "known-good seller,
   * consider firm opener" attached by the contact check before outreach.
   */
  readonly threadNotes?: Record<string, readonly string[]>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly cancelledAt?: string;
}

export interface SellerConstraint {
  readonly id: string;
  readonly text: string;
  readonly appliesTo: "pickup" | "all";
  readonly active: boolean;
}

export type OutboxKind =
  | "reply"
  | "confirmation"
  | "close-out"
  | "booking"
  | "sms-draft"
  | "nudge"
  | "sold-notice"
  /** v3 services lane: provider screening questions staged before price talk (plan §4). */
  | "screening";

export type OutboxStatus = "pending" | "awaiting-tap" | "sent";

export interface OutboxMessage {
  readonly id: string;
  readonly kind: OutboxKind;
  readonly channel: Channel;
  readonly threadId: string;
  readonly recipient: string;
  readonly body: string;
  readonly stagedAt: string;
  readonly status: OutboxStatus;
  /** v3: approval tier for this message. "per_message" is the safe default. */
  readonly sendAuthority: SendAuthority;
  /** Set when the message leaves the outbox under standing authority (auto/routine flush) or his tap. Body is kept for audit. */
  readonly sentAt?: string;
  readonly listingId?: string;
  readonly leadId?: string;
}

export type BookingStatus =
  | "pending-approval"
  | "booked"
  | "picked-up"
  | "returned"
  | "cancelled";

export interface RentalBooking {
  readonly id: string;
  readonly listingId: string;
  readonly leadId: string;
  readonly pickupDate: string;
  readonly returnDate: string;
  readonly status: BookingStatus;
  readonly deposit: {
    readonly amount: number;
    readonly paid: boolean;
    readonly paidAt?: string;
    readonly method?: string;
    readonly returned?: boolean;
    readonly returnedAt?: string;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One row of the authority ledger: what the agent may do alone vs what needs Toozy. */
export interface AuthorityGrant {
  readonly scope: string;
  readonly autonomous: readonly string[];
  readonly approvalRequired: readonly string[];
}

/** Per-buyer reliability record, keyed by normalized name. */
export interface BuyerStats {
  readonly name: string;
  /** Threads seen for this buyer. */
  readonly threads: readonly string[];
  readonly contacts: number;
  /** Went silent after we replied (ghost). */
  readonly ghosts: number;
  /** Holds that expired unconfirmed (flaky). */
  readonly holdsExpired: number;
  /** Times they pushed below a firm price (lowball pattern). */
  readonly lowballs: number;
  /** Completed purchases/pickups. */
  readonly completed: number;
  /** 0..100. Starts at 70; ghosts/flakes/lowballs drag it down, completions lift it. */
  readonly score: number;
  readonly updatedAt: string;
}

/** Rolling thread summary — raw messages are summarized once, then dropped. */
export interface ThreadSummary {
  readonly threadId: string;
  /** Living summary text, updated incrementally. */
  readonly summary: string;
  readonly updatedAt: string;
  /** Count of messages folded into the summary. */
  readonly messageCount: number;
}

export interface ActivityEntry {
  readonly at: string;
  readonly kind: "confirmation" | "booking" | "escalation" | "nudge" | "hunt" | "listing" | "system";
  /** One line, no message bodies. */
  readonly text: string;
}

// ---------------------------------------------------------------------------
// Marketplace Manager v3 — Phase 0: state schema extension (plan §1, §4, §6, §10)
// ---------------------------------------------------------------------------

export type ServiceType = "home" | "cleaning";

export type ServiceRequestStatus =
  | "requested"
  | "quoted"
  | "booked"
  | "done"
  | "cancelled";

/** One provider quote against a service request (v3 plan §4). */
export interface ServiceQuote {
  readonly providerId: string;
  readonly providerName: string;
  readonly amount: number;
  readonly notes: string;
  /** Provider's stated availability (free text, compared heuristically against the request window). */
  readonly available?: string;
  /** Messenger thread the quote came in on — the 48h follow-up nudge replies here. */
  readonly threadId?: string;
  readonly at: string;
}

/**
 * A reference check on a provider (v3 plan §4 two-phase trust protocol).
 * Recorded from texts/calls with the provider's past clients; the agent
 * surfaces red flags (low scores, flag words) at compare time.
 */
export interface ServiceReference {
  readonly providerId: string;
  readonly providerName: string;
  /** 1–5, Toozy's or the past client's rating of this provider. */
  readonly score: number;
  readonly notes: string;
  readonly at: string;
}

/** A services-lane request: mounting, repairs, cleaning, etc. (v3 plan §4). */
export interface ServiceRequest {
  readonly id: string;
  readonly serviceType: ServiceType;
  readonly specs: string;
  readonly budgetCeiling: number;
  readonly timingWindow: string;
  readonly status: ServiceRequestStatus;
  readonly quotes: readonly ServiceQuote[];
  readonly providerId?: string;
  /** Provider names that already received the screening questions (trust protocol phase a). */
  readonly screenedProviders: readonly string[];
  /** Reference checks recorded per provider (trust protocol phase b). */
  readonly references: readonly ServiceReference[];
  /**
   * Last time quote-request activity happened (request opened or a quote
   * added). The single 48h follow-up nudge is measured from this.
   */
  readonly lastQuoteActivityAt: string;
  /** Set when the one-shot 48h nudge was staged — a request is nudged at most once. */
  readonly quoteNudgeSentAt?: string;
  /**
   * Provider name awaiting Toozy's tap on a staged booking confirmation.
   * Set by `services book`, cleared by `services approve-booking`. The
   * booking is inviolable: nothing books without this explicit approval.
   */
  readonly bookingPendingFor?: string;
  /** His post-service 1–5 rating (learning loop #6). */
  readonly rating?: number;
  /**
   * v3 Phase 4 (plan §9): the 25-mile service price card captured at
   * request time (typical range from service comps).
   */
  readonly priceCard?: PriceReferenceCard;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * A 25-mile price reference card (v3 plan §9, Phase 4). Pure data — the
 * live implementation pulls comps via selling/comps.ts; the stub feeds
 * fixtures. Radius center is always the public-meetup area (Highland
 * Village), never his street address.
 */
export interface PriceReferenceCard {
  readonly query: string;
  readonly radiusMiles: number;
  readonly avg: number;
  readonly median: number;
  readonly low: number;
  readonly high: number;
  /** Comp sample size. */
  readonly n: number;
  readonly basis: string;
}

/** One relist sighting: a seller seen again with a similar item (v3 plan §6.2, Phase 4). */
export interface RelistSighting {
  /** Normalized keyword signature (sorted, stopwords dropped) — see buying/relist.ts. */
  readonly signature: string;
  /** Human-readable item description at sighting time. */
  readonly itemName: string;
  readonly at: string;
}

/**
 * One observed listing price: our own price-history ledger for the
 * price-anomaly signal. The FB API exposes no price history, so v3 records
 * every price it sees per listing_id; a later sighting at a materially
 * different price is the anomaly (see selling/trust-live.ts).
 */
export interface ObservedPrice {
  readonly price: number;
  readonly at: string;
}

/**
 * Cross-listing contact record, keyed by FB profile id (v3 plan §1).
 * Survives listing deletion; auto-flags repeat flakes on new inbound.
 * reliabilityScore is 0–100 and starts at 50 (neutral).
 */
export interface ContactRecord {
  /** Seller display name (optional) — used for the normalized-name lookup
   * fallback when a profile id isn't available (v3 plan §3, buying). */
  readonly name?: string;
  readonly reliabilityScore: number;
  readonly interactionCount: number;
  readonly flakeCount: number;
  readonly lowballRatio: number;
  readonly goodDealCount: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly notes: readonly string[];
}

/** One pricing outcome feeding the pricing recalibration loop (v3 plan §6.1). */
export interface PricingOutcome {
  readonly itemId: string;
  readonly huntId?: string;
  readonly listPrice?: number;
  readonly finalPrice: number;
  readonly soldAt: string;
  readonly daysToClose: number;
}

/** Negotiation outcome per contact, for the predictive-opener loop (v3 plan §6.2). */
export interface NegotiationOutcome {
  readonly contactId: string;
  readonly huntId?: string;
  readonly outcome: "closed" | "walked-away" | "flaked" | "declined";
  readonly finalAmount?: number;
  /**
   * Opener expressed as a percentage of the hunt ceiling (v3 plan §3,
   * Phase 2 predictive openers). Feeds suggestOpener's close-rate buckets.
   */
  readonly openerPct?: number;
  readonly at: string;
}

/** Why a hunt was killed — feeds the kill-switch learning loop (v3 plan §3, §6.3). */
export type HuntKillReason = "flakes" | "scams" | "overpriced" | "wrong-item" | "other";
/** One kill-switch event: what was killed and why. */
export interface HuntKill {
  readonly huntName: string;
  readonly criteria: string;
  readonly reason: HuntKillReason;
  readonly note?: string;
  readonly at: string;
}

/**
 * Provider trust record for the services lane (v3 plan §6, learning loop
 * #6). Separate from buyer/seller contact scores: keyed by normalized
 * provider id, updated only by Toozy's post-service 1–5 rating
 * (`services rate`). `score` is the running mean of his ratings.
 */
export interface ProviderTrust {
  readonly score: number;
  readonly jobs: number;
  readonly lastRating?: number;
}

/** Learning stores: analytics + models backing the v3 loops (v3 plan §6). */
export interface LearningStore {
  readonly pricingHistory: readonly PricingOutcome[];
  readonly approvalPatterns: Record<string, ApprovalWindowStats>;
  readonly negotiationOutcomes: Record<string, NegotiationOutcome>;
  readonly contactTrustScores: Record<string, number>;
  /** Kill-switch learning (v3 plan §3, §6.3): past cancellations tighten future hunt criteria. */
  readonly huntKills: readonly HuntKill[];
  /** Provider trust (v3 plan §6.6): post-service ratings, keyed by normalized provider id. */
  readonly providerTrust: Record<string, ProviderTrust>;
  /**
   * v3 Phase 4 (loop #4): owner approval-tap timestamps, rolling 14-day
   * window, newest-last. recomputeApprovalWindows reads this to build the
   * per-hour-of-week tap distribution.
   */
  readonly approvalTaps?: readonly string[];
  /**
   * v3 Phase 4 (loop #2): relist sightings per contact (keyed by contact id,
   * or "name:<normalized>" when the seller isn't in the contacts store).
   */
  readonly relistSightings?: Record<string, readonly RelistSighting[]>;
  /**
   * Price-history ledger for the trust price-anomaly signal, keyed by
   * listing_id. The FB API exposes no price history, so v3 records every
   * price it observes; a re-sighting at a materially different price
   * yields the anomaly severity (see selling/trust-live.ts).
   */
  readonly observedPrices?: Record<string, ObservedPrice>;
}

/**
 * v3 Phase 4 (loop #4): the recomputed per-hour-of-week tap distribution
 * lives on approvalPatterns["hourly"] as hourlyTapProbability — 168 entries
 * (Mon 00:00 … Sun 23:00), each the share of taps in that slot over the
 * rolling 14-day window. The "global" key keeps the aggregate stats.
 */
export interface ApprovalWindowStats {
  readonly windowDays: number;
  readonly tapCount: number;
  /** Average minutes from card-staged to his tap. */
  readonly avgTapDelayMinutes: number;
  readonly lastTapAt?: string;
  /** Phase 4: tap share per hour-of-week (168 entries summing to 1). */
  readonly hourlyTapProbability?: readonly number[];
}

export type InventoryItemStatus = "draft" | "active" | "price-dropped" | "sold" | "delisted";
export type InventoryServiceStatus = "requested" | "quoted" | "booked" | "done";
export type InventoryHuntStatus = "active" | "killed" | "fulfilled";

/** Running inventory: one item for sale (v3 plan §10). */
export interface InventoryItem {
  readonly id: string;
  readonly name: string;
  readonly status: InventoryItemStatus;
  readonly listPrice?: number;
  readonly soldPrice?: number;
  readonly priceLadder?: PriceLadder;
  readonly photos?: readonly string[];
  readonly conditionNotes?: string;
  /** Back-reference to the live listing once published. */
  readonly listingId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Running inventory: one requested service (v3 plan §10). */
export interface InventoryService {
  readonly id: string;
  readonly name: string;
  readonly status: InventoryServiceStatus;
  readonly serviceType: ServiceType;
  readonly quotesReceived: number;
  readonly chosenProviderId?: string;
  readonly cost?: number;
  /** Back-reference to the service request. */
  readonly serviceRequestId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Running inventory: one wanted item in the buying lane (v3 plan §10). */
export interface InventoryHunt {
  readonly id: string;
  readonly name: string;
  readonly status: InventoryHuntStatus;
  readonly criteria: string;
  readonly ceiling?: number;
  /** Back-reference to the campaign once started. */
  readonly campaignId?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Running inventory across all three lanes; survives listing deletion (v3 plan §10). */
export interface InventoryStore {
  readonly items: readonly InventoryItem[];
  readonly services: readonly InventoryService[];
  readonly hunts: readonly InventoryHunt[];
}

export interface TrackerDocument {
  readonly version: 1 | 3;
  readonly listings: readonly Listing[];
  readonly leads: readonly Lead[];
  readonly campaigns: readonly Campaign[];
  readonly constraints: readonly SellerConstraint[];
  readonly authority: readonly AuthorityGrant[];
  readonly outbox: readonly OutboxMessage[];
  readonly bookings: readonly RentalBooking[];
  /** Dedupe keys for channel events already processed. */
  readonly seenEvents: readonly string[];
  /** Buyer reliability scores, keyed by normalized buyer name. */
  readonly buyers: Record<string, BuyerStats>;
  /** Watermark: last-read event id per thread — polls fetch deltas only. */
  readonly watermarks: Record<string, string>;
  /** Rolling summaries per thread — never full message bodies. */
  readonly summaries: Record<string, ThreadSummary>;
  /** Capped activity log (latest 200) feeding the daily digest. */
  readonly activity: readonly ActivityEntry[];
  /** v3: services-lane requests (mounting, repairs, cleaning). */
  readonly serviceRequests: readonly ServiceRequest[];
  /** v3: cross-listing contact database, keyed by FB profile id. */
  readonly contacts: Record<string, ContactRecord>;
  /** v3: analytics + models backing the learning loops. */
  readonly learning: LearningStore;
  /** v3: running inventory across items, services, and hunts. */
  readonly inventory: InventoryStore;
  readonly updatedAt: string;
}
