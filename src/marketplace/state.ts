import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ActivityEntry, TrackerDocument } from "./types";

const MAX_ACTIVITY = 200;

/**
 * JSON-backed marketplace state (ADR 0024). The runtime file lives under
 * .orchestrator/ (gitignored) — it holds buyer names, thread ids and pickup
 * plans, all personal data that stays on the owner's machine. Written
 * atomically. A file that exists but can't be read is an error, never a
 * silent reset.
 */
export interface MarketplaceStorage {
  /** undefined only when nothing has been saved yet. */
  load(): Promise<TrackerDocument | undefined>;
  save(doc: TrackerDocument): Promise<void>;
}

export class InMemoryMarketplaceStorage implements MarketplaceStorage {
  private json: string | undefined;
  constructor(initial?: TrackerDocument) {
    if (initial) this.json = JSON.stringify(initial);
  }
  async load(): Promise<TrackerDocument | undefined> {
    return this.json === undefined ? undefined : validateDocument(JSON.parse(this.json));
  }
  async save(doc: TrackerDocument): Promise<void> {
    this.json = JSON.stringify(doc);
  }
}

export class JsonFileMarketplaceStorage implements MarketplaceStorage {
  constructor(private readonly path: string) {}
  async load(): Promise<TrackerDocument | undefined> {
    let text: string;
    try {
      text = await readFile(this.path, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Marketplace state ${this.path} is not valid JSON (${(error as Error).message}). Fix or restore it; it was not overwritten.`);
    }
    return validateDocument(parsed);
  }
  async save(doc: TrackerDocument): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, "utf-8");
    await rename(tmp, this.path);
  }
}

function validateDocument(parsed: unknown): TrackerDocument {
  if (typeof parsed !== "object" || parsed === null) throw new Error("Marketplace state is not an object.");
  const doc = parsed as Record<string, unknown>;
  if (doc["version"] !== 1 && doc["version"] !== 3) throw new Error(`Unsupported marketplace state version ${String(doc["version"])}.`);
  for (const key of ["listings", "leads", "campaigns", "constraints", "authority", "outbox", "bookings", "seenEvents", "activity"]) {
    if (!Array.isArray(doc[key])) throw new Error(`Marketplace state field "${key}" must be an array.`);
  }
  // Migrate: offers[] on campaigns was added after the first seed.
  for (const c of doc["campaigns"] as Array<Record<string, unknown>>) {
    if (!Array.isArray(c["offers"])) c["offers"] = [];
  }
  // Migrate: autonomy/token-usage fields added later.
  if (typeof doc["buyers"] !== "object" || doc["buyers"] === null) doc["buyers"] = {};
  if (typeof doc["watermarks"] !== "object" || doc["watermarks"] === null) doc["watermarks"] = {};
  if (typeof doc["summaries"] !== "object" || doc["summaries"] === null) doc["summaries"] = {};
  if (typeof doc["ownerActivity"] !== "object" || doc["ownerActivity"] === null) doc["ownerActivity"] = {};
  if (!Array.isArray(doc["activity"])) doc["activity"] = [];
  for (const l of doc["leads"] as Array<Record<string, unknown>>) {
    if (l["awaiting"] !== "them" && l["awaiting"] !== "us") l["awaiting"] = "them";
    if (typeof l["nudgeLevel"] !== "number") l["nudgeLevel"] = 0;
  }
  // Migrate: v1 → v3 (Phase 0, Marketplace Manager v3 plan §1/§4/§6/§10).
  // New stores: serviceRequests (services lane), contacts (cross-listing
  // contact DB keyed by FB profile id), learning (pricing / approval /
  // negotiation / trust analytics), inventory (running inventory across
  // items, services, hunts). Old v1 files load with empty defaults; the
  // migration never grants MORE send authority than v1 allowed — missing
  // sendAuthority resolves to "per_message" (the most restrictive tier),
  // and Lead.sendAuthority stays optional (absent ⇒ "per_message").
  if (!Array.isArray(doc["serviceRequests"])) doc["serviceRequests"] = [];
  // Migrate: Phase 3 services-lane fields (v3 plan §4) — trust protocol,
  // nudge clock, booking-pending marker, rating, and the provider trust
  // store (v3 plan §6.6). All additive; old request rows pick up defaults.
  for (const r of doc["serviceRequests"] as Array<Record<string, unknown>>) {
    if (!Array.isArray(r["screenedProviders"])) r["screenedProviders"] = [];
    if (!Array.isArray(r["references"])) r["references"] = [];
    if (typeof r["lastQuoteActivityAt"] !== "string") {
      r["lastQuoteActivityAt"] = typeof r["createdAt"] === "string" ? r["createdAt"] : new Date().toISOString();
    }
  }
  if (typeof doc["contacts"] !== "object" || doc["contacts"] === null) doc["contacts"] = {};
  if (typeof doc["learning"] !== "object" || doc["learning"] === null) doc["learning"] = {};
  const learning = doc["learning"] as Record<string, unknown>;
  if (!Array.isArray(learning["pricingHistory"])) learning["pricingHistory"] = [];
  if (typeof learning["approvalPatterns"] !== "object" || learning["approvalPatterns"] === null) learning["approvalPatterns"] = {};
  if (typeof learning["negotiationOutcomes"] !== "object" || learning["negotiationOutcomes"] === null) learning["negotiationOutcomes"] = {};
  if (typeof learning["contactTrustScores"] !== "object" || learning["contactTrustScores"] === null) learning["contactTrustScores"] = {};
  // Migrate: Phase 2 kill-switch learning (v3 plan §3, §6.3).
  if (!Array.isArray(learning["huntKills"])) learning["huntKills"] = [];
  // Migrate: Phase 3 provider trust (v3 plan §6.6) — post-service ratings,
  // keyed by normalized provider id. Empty when he has rated nothing yet.
  if (typeof learning["providerTrust"] !== "object" || learning["providerTrust"] === null) learning["providerTrust"] = {};
  // Migrate: Phase 4 learning loops (v3 plan §6) — approval-tap timestamps
  // (loop #4) and relist sightings (loop #2). Both optional on the type so
  // hand-built fixtures keep working.
  if (!Array.isArray(learning["approvalTaps"])) learning["approvalTaps"] = [];
  if (typeof learning["relistSightings"] !== "object" || learning["relistSightings"] === null) learning["relistSightings"] = {};
  if (typeof doc["inventory"] !== "object" || doc["inventory"] === null) doc["inventory"] = {};
  const inventory = doc["inventory"] as Record<string, unknown>;
  if (!Array.isArray(inventory["items"])) inventory["items"] = [];
  if (!Array.isArray(inventory["services"])) inventory["services"] = [];
  if (!Array.isArray(inventory["hunts"])) inventory["hunts"] = [];
  for (const m of doc["outbox"] as Array<Record<string, unknown>>) {
    if (m["sendAuthority"] !== "auto" && m["sendAuthority"] !== "routine" && m["sendAuthority"] !== "per_message") {
      m["sendAuthority"] = "per_message";
    }
  }
  // Once migrated, the doc is v3-shaped — stamp it so the next save persists v3.
  doc["version"] = 3;
  return parsed as TrackerDocument;
}

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Seed document: tonight's real state (2026-09-26).
 * - Chair: $90 firm, Buyer 1 CONFIRMED for Sat 2:30pm; backups Buyers 2-4; Buyer 5 deferred.
 * - BISSELL rental: $30/day + $30 deposit; Renter 1 awaiting a date; Renters 2-4 warm.
 * Buyer/renter names and thread ids are anonymized placeholders; real ones live only in local state.
 * - Both BUYING hunts (keyboard/mouse, tint) CANCELLED.
 * - Authority: chair replies+confirmations autonomous; BISSELL bookings need his tap;
 *   BUYING purchases always need his approval.
 */
export function seedDocument(now: string = isoNow()): TrackerDocument {
  return {
    version: 3,
    listings: [
      {
        id: "chair",
        kind: "sale",
        title: "White Ergonomic Office/Gaming Chair with Footrest",
        price: 90,
        priceFirm: true,
        payment: "cash or Venmo",
        meetup: "Highland Village area — public meetup",
        description: "White ergonomic office/gaming chair with footrest. $90 firm.",
        status: "active",
        monitoring: true,
        holdTimeoutHours: 24,
        createdAt: "2026-09-24T00:00:00-05:00",
        updatedAt: now,
      },
      {
        id: "bissell",
        kind: "rental",
        title: "BISSELL Little Green carpet cleaner — rental",
        price: 30,
        priceFirm: true,
        payment: "cash, Venmo, or Zelle",
        meetup: "Highland Village area — public meetup",
        description: "BISSELL Little Green rental. $30/day + $30 refundable deposit.",
        status: "active",
        monitoring: true,
        holdTimeoutHours: 48,
        terms: {
          dayRate: 30,
          deposit: 30,
          depositMethods: ["cash", "Venmo", "Zelle"],
          depositPaidAt: "pickup",
          solutionIncluded: "one solution packet included",
          extraSolutionPrice: 5,
          pickupReturn: "pickup and return in the Highland Village area",
        },
        createdAt: "2026-09-24T00:00:00-05:00",
        updatedAt: now,
      },
    ],
    leads: [
      {
        id: "buyer-1",
        listingId: "chair",
        name: "Buyer 1",
        threadId: "buyer-1-chair-thread",
        channel: "messenger",
        status: "confirmed",
        queuePosition: 1,
        firstSeenAt: "2026-09-25T11:31:00-05:00",
        lastContactAt: "2026-09-26T00:09:00-05:00",
        pickupAt: "2026-09-26T14:30:00-05:00",
        ownerRepliedAt: "2026-09-26T00:09:00-05:00",
        needsAgentFollowUp: false,
        awaiting: "them",
        nudgeLevel: 0,
        notes: ["Owner confirmed pickup himself Sat 2026-09-26 2:30pm, $90, cash or Venmo. Carry note sent."],
      },
      {
        id: "buyer-2",
        listingId: "chair",
        name: "Buyer 2",
        threadId: "buyer-2-chair-thread",
        channel: "messenger",
        status: "contacted",
        queuePosition: 2,
        firstSeenAt: "2026-09-24T00:00:00-05:00",
        lastContactAt: "2026-09-25T00:00:00-05:00",
        needsAgentFollowUp: true,
        awaiting: "them",
        nudgeLevel: 0,
        notes: ["Offered Friday 2026-09-25 morning pickup, never confirmed. Backup behind Buyer 1."],
      },
      {
        id: "buyer-3",
        listingId: "chair",
        name: "Buyer 3",
        threadId: "buyer-3-chair-thread",
        channel: "messenger",
        status: "contacted",
        queuePosition: 3,
        firstSeenAt: "2026-09-24T00:00:00-05:00",
        lastContactAt: "2026-09-25T00:00:00-05:00",
        needsAgentFollowUp: true,
        awaiting: "them",
        nudgeLevel: 0,
        notes: ["Answered $90 firm, nudged 2026-09-25. Backup."],
      },
      {
        id: "buyer-4",
        listingId: "chair",
        name: "Buyer 4",
        threadId: "buyer-4-chair-thread",
        channel: "messenger",
        status: "contacted",
        queuePosition: 4,
        firstSeenAt: "2026-09-25T00:00:00-05:00",
        lastContactAt: "2026-09-25T00:00:00-05:00",
        needsAgentFollowUp: true,
        awaiting: "them",
        nudgeLevel: 0,
        notes: ["Newest chair inquirer, nudged 2026-09-25. Backup."],
      },
      {
        id: "buyer-5",
        listingId: "chair",
        name: "Buyer 5",
        threadId: "buyer-5-chair-thread",
        channel: "messenger",
        status: "deferred",
        queuePosition: 5,
        firstSeenAt: "2026-09-24T00:00:00-05:00",
        lastContactAt: "2026-09-25T18:00:00-05:00",
        needsAgentFollowUp: false,
        awaiting: "them",
        nudgeLevel: 0,
        notes: ["Deferred to next week (w/c 2026-09-28). Nudge then if chair unsold."],
      },
      {
        id: "renter-1",
        listingId: "bissell",
        name: "Renter 1",
        threadId: "renter-1-bissell-thread",
        channel: "messenger",
        status: "contacted",
        queuePosition: 1,
        firstSeenAt: "2026-09-25T16:36:00-05:00",
        lastContactAt: "2026-09-25T16:36:00-05:00",
        needsAgentFollowUp: true,
        awaiting: "them",
        nudgeLevel: 0,
        notes: ["Rental terms sent, awaiting which day they need it."],
      },
      {
        id: "renter-2",
        listingId: "bissell",
        name: "Renter 2",
        threadId: "renter-2-bissell-thread",
        channel: "messenger",
        status: "contacted",
        queuePosition: 2,
        firstSeenAt: "2026-09-24T00:00:00-05:00",
        lastContactAt: "2026-09-24T00:00:00-05:00",
        needsAgentFollowUp: true,
        awaiting: "them",
        nudgeLevel: 0,
        notes: ["Terms sent, awaiting their timing."],
      },
      {
        id: "renter-3",
        listingId: "bissell",
        name: "Renter 3",
        threadId: "renter-3-bissell-thread",
        channel: "messenger",
        status: "contacted",
        queuePosition: 3,
        firstSeenAt: "2026-09-24T00:00:00-05:00",
        lastContactAt: "2026-09-24T00:00:00-05:00",
        needsAgentFollowUp: true,
        awaiting: "them",
        nudgeLevel: 0,
        notes: ["Availability and price answered."],
      },
      {
        id: "renter-4",
        listingId: "bissell",
        name: "Renter 4",
        threadId: "renter-4-bissell-thread",
        channel: "messenger",
        status: "contacted",
        queuePosition: 4,
        firstSeenAt: "2026-09-24T00:00:00-05:00",
        lastContactAt: "2026-09-24T00:00:00-05:00",
        needsAgentFollowUp: true,
        awaiting: "them",
        nudgeLevel: 0,
        notes: ["Spanish thread. Dates not confirmed."],
      },
    ],
    campaigns: [
      {
        id: "hunt-keyboard-mouse",
        name: "keyboard-mouse",
        status: "cancelled",
        criteria: "Genuine Apple Magic Keyboard / Magic Mouse only. No third-party or MAC-compatible knockoffs.",
        threads: [],
        offers: [],
        createdAt: "2026-09-25T00:00:00-05:00",
        updatedAt: now,
        cancelledAt: "2026-09-26T00:26:00-05:00",
      },
      {
        id: "hunt-tint",
        name: "tint",
        status: "cancelled",
        criteria: "Tesla Model 3 window tint, ceramic, lifetime warranty, Houston install.",
        threads: [],
        offers: [],
        createdAt: "2026-09-24T00:00:00-05:00",
        updatedAt: now,
        cancelledAt: "2026-09-26T00:32:00-05:00",
      },
    ],
    constraints: [
      {
        id: "carry",
        text: "Just a heads up — I can't help carry or lift heavy items, so please bring a friend to help load it.",
        appliesTo: "pickup",
        active: true,
      },
    ],
    authority: [
      {
        scope: "selling:chair",
        autonomous: ["reply", "confirm", "hold", "advance-queue", "mark-sold", "nudge"],
        approvalRequired: ["price-change"],
      },
      {
        scope: "selling:bissell",
        autonomous: ["reply", "hold", "nudge"],
        approvalRequired: ["book", "price-change"],
      },
      {
        scope: "buying",
        autonomous: ["reply", "outreach", "offer", "close-out", "pause-hunt"],
        approvalRequired: ["purchase", "start-hunt"],
      },
    ],
    outbox: [],
    bookings: [],
    seenEvents: [],
    buyers: {},
    watermarks: {},
    summaries: {},
    ownerActivity: {},
    activity: [
      { at: now, kind: "system", text: "Marketplace Agent v2 seeded: chair ($90) + BISSELL rental live; keyboard/mouse and tint hunts cancelled." },
    ],
    // v3 stores seed empty; existing v2 seed data above is untouched.
    serviceRequests: [],
    contacts: {},
    learning: {
      pricingHistory: [],
      approvalPatterns: {},
      negotiationOutcomes: {},
      contactTrustScores: {},
      huntKills: [],
      providerTrust: {},
      approvalTaps: [],
      relistSightings: {},
    },
    inventory: {
      items: [],
      services: [],
      hunts: [],
    },
    updatedAt: now,
  };
}

export class MarketplaceState {  private constructor(
    private readonly storage: MarketplaceStorage,
    private doc: TrackerDocument,
  ) {}

  static async open(storage: MarketplaceStorage, opts: { seed?: (now: string) => TrackerDocument; now?: () => string } = {}): Promise<MarketplaceState> {
    const existing = await storage.load();
    if (existing) return new MarketplaceState(storage, existing);
    const now = opts.now ? opts.now() : isoNow();
    const doc = (opts.seed ?? seedDocument)(now);
    const state = new MarketplaceState(storage, doc);
    await state.save();
    return state;
  }

  get document(): TrackerDocument {
    return this.doc;
  }

  async update(fn: (doc: TrackerDocument) => TrackerDocument): Promise<TrackerDocument> {
    this.doc = fn(this.doc);
    await this.save();
    return this.doc;
  }

  async save(): Promise<void> {
    await this.storage.save(this.doc);
  }
}

/**
 * Append one line to the activity log (capped at 200, oldest dropped).
 * Feeds the daily digest; stores one-liners only, never message bodies.
 */
export function logActivity(doc: TrackerDocument, kind: ActivityEntry["kind"], text: string, now: string = new Date().toISOString()): TrackerDocument {
  const activity = [...doc.activity, { at: now, kind, text }].slice(-MAX_ACTIVITY);
  return { ...doc, activity, updatedAt: now };
}
