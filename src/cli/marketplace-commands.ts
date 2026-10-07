import { parseArgs, type ParseArgsConfig } from "node:util";
import type { CliDeps } from "./index";
import { createMarketplaceDeps, type MarketplaceDeps } from "../marketplace/deps";
import { InMemoryMarketplaceStorage } from "../marketplace/state";
import { formatLeads, formatListing, formatOutbox, formatStatus } from "../marketplace/format";
import { renderTemplate, templateNames } from "../marketplace/templates";
import { outreachToSeller } from "../marketplace/buying/contact-check";
import { cancelHunt, detectSellerAcceptance, pauseHunt, stageOffer, startHunt } from "../marketplace/buying/hunts";
import { suggestOpener } from "../marketplace/buying/openers";
import { detectRelist } from "../marketplace/buying/relist";
import { createChannelPollers, dedupe, filterByWatermark, matchLead, pollAll, type LeadEvent, updateWatermarks } from "../marketplace/channels";
import { changedInventoryRows, formatInventory } from "../marketplace/inventory";
import { recomputeApprovalWindows, topWindows } from "../marketplace/learning/approval";
import { recordSaleOutcome } from "../marketplace/learning/sales";
import { formatLearningSummary } from "../marketplace/learning/summary";
import { decayTrust } from "../marketplace/learning/trust";
import { awaitingTap, flushOutbox, pendingMessages, recordSent, stageMessage } from "../marketplace/outbox";
import { OWNER_FB_ID, classifySender, isWatchOnly, reconcileOwnerActivity, recordOwnerActivity, watchOnlyThreads } from "../marketplace/owner_activity";
import { buildPriceCard, facebookCompSource, formatPriceCard, resolveIntakeComps } from "../marketplace/pricing/reference";
import { approvalSummary, buildIntakeDraft, intakeReadiness, loadSidecar, messengerCheckRunner, publishApproved, resolveIntakePrice, validateIntake } from "../marketplace/selling/intake";
import { applyDueDrops, formatLadderSuggestion, isLiveListingStatus, suggestLadder } from "../marketplace/selling/ladder";
import { attachFbListingId, createListing, setListingStatus } from "../marketplace/selling/listings";
import { advanceExpiredHolds, confirmLead, holdLead, markSold, queueFor, stageAdvanceMessages } from "../marketplace/selling/queue";
import { approveBooking, bookingsFor, requestBooking } from "../marketplace/selling/rentals";
import type { HuntKillReason, PriceReferenceCard } from "../marketplace/types";
import { screenInbound } from "../marketplace/scam";
import { isLogisticsHandoff, escalate, AuthorityError, canAutonomous, sellingScope, ACTIONS } from "../marketplace/policy";
import { dueNudges, sendDueNudges } from "../marketplace/selling/nudge";
import { detectStaleListings, retireMissingListings, applyStaleDrops } from "../marketplace/selling/health";
import { recordReliability, detectLowballOffer, buyerScore } from "../marketplace/selling/reliability";
import { rollSummaries } from "../marketplace/summarize";
import { logActivity } from "../marketplace/state";
import { respondToOffer, stageNegotiationReply, extractOffer, setFloorPrice } from "../marketplace/selling/negotiation";
import { evaluateRentalMessage, stageRentalReply } from "../marketplace/selling/rental_tree";
import { buildDigest, formatDigest } from "../marketplace/digest";
import { setParseFailureSink, logParseFailure, type ParseFailure } from "../marketplace/parse";
import type { TrackerDocument } from "../marketplace/types";
import {
  addQuote,
  approveServiceBooking,
  createServiceRequest,
  rateService,
  recordReference,
  requestServiceBooking,
  servicesNudgeDue,
  stageScreening,
  stageServiceNudge,
} from "../marketplace/services/requests";
import { formatComparison } from "../marketplace/services/format";
import { checkReferences } from "../marketplace/services/screening";

/**
 * `orchestrator marketplace selling|buying|services|channels ...` (ADR 0024).
 *
 * Three mechanisms: SELLING (inbound: listings, queues, confirmations,
 * rentals), BUYING (outbound: hunts, outreach, offers), and SERVICES
 * (local services: requests, screening, quotes, references, bookings).
 * Read-only commands never send. Anything outbound is staged in the outbox
 * and flushed in spurts for his approval-card taps — the CLI itself never
 * sends a Messenger message.
 */

class UsageError extends Error {}

interface Command {
  readonly name: string;
  readonly usage: string;
  readonly summary: string;
  run(args: readonly string[], m: MarketplaceDeps, deps: CliDeps): Promise<void>;
}

function parse<T extends ParseArgsConfig["options"]>(args: readonly string[], options: T) {
  try {
    return parseArgs({ args: [...args], options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

function req(value: string | undefined, flag: string): string {
  if (!value) throw new UsageError(`${flag} is required.`);
  return value;
}

function kvPairs(values: readonly string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of values ?? []) {
    const eq = pair.indexOf("=");
    if (eq < 0) throw new UsageError(`--set expects key=value, got "${pair}".`);
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

async function withState<T>(m: MarketplaceDeps, fn: (doc: import("../marketplace/types").TrackerDocument) => Promise<{ doc: import("../marketplace/types").TrackerDocument; value: T }>): Promise<T> {
  const state = await m.openState();
  const { doc, value } = await fn(state.document);
  await state.update(() => doc);
  return value;
}

/** Threads where the owner wrote inside the watch window — the agent may not message them now. */
function watchOnlySet(doc: TrackerDocument, m: MarketplaceDeps, nowIso: string = m.now()): ReadonlySet<string> {
  return new Set(watchOnlyThreads(doc, nowIso, m.config().ownerActivity.watchOnlyMinutes));
}

const SELLING: readonly Command[] = [
  {
    name: "status",
    usage: "marketplace selling status",
    summary: "Listings, queues, hunts, outbox counts (read-only).",
    async run(_args, m, deps) {
      const state = await m.openState();
      deps.stdout(formatStatus(state.document));
    },
  },
  {
    name: "leads",
    usage: "marketplace selling leads --listing <id>",
    summary: "Show the buyer queue for a listing (read-only).",
    async run(args, m, deps) {
      const { values } = parse(args, { listing: { type: "string" } });
      const state = await m.openState();
      const doc = state.document;
      const listingId = req(values.listing, "--listing");
      deps.stdout(formatLeads(queueFor(doc, listingId), doc.listings));
    },
  },
  {
    name: "check-trust",
    usage: "marketplace selling check-trust --listing-id <id>",
    summary: "Resolve LIVE trust signals for a listing's seller (account age via seller-info, cross-post count, price anomaly) and print the 0–100 trust score. Read-only.",
    async run(args, m, deps) {
      const { values } = parse(args, { "listing-id": { type: "string" } });
      const listingId = req(values["listing-id"], "--listing-id");
      const { resolveLiveTrustSignals } = await import("../marketplace/selling/trust-live.js");
      const result = await resolveLiveTrustSignals({ listingId });
      const r = result.reputation;
      deps.stdout(`TRUST CHECK — listing ${listingId}${r?.sellerName ? ` (seller: ${r.sellerName})` : ""}`);
      if (r?.accountAgeYears !== undefined) deps.stdout(`  account age: ~${r.accountAgeYears} year(s)`);
      else deps.stdout("  account age: unknown");
      if (r?.ratingAverage !== undefined) deps.stdout(`  rating: ★${r.ratingAverage} (${r.ratingCount ?? 0} ratings)`);
      else deps.stdout("  rating: none listed");
      const s = result.signals;
      if (s.crossPostCount !== undefined) deps.stdout(`  cross-posts: ${s.crossPostCount} distinct listing(s) by this seller`);
      if (s.priceAnomaly !== undefined && s.priceAnomaly > 0) deps.stdout(`  price anomaly: ${Math.round(s.priceAnomaly * 100)}% below batch median`);
      deps.stdout(`  stock-photo check: not available (no credential-free reverse-image tooling)`);
      deps.stdout(`SCORE: ${result.score.score}/100${result.score.reasons.length > 0 ? ` — ${result.score.reasons.join("; ")}` : " (no signals — neutral)"}`);
      if (result.score.score < 40) deps.stdout("Below the 40 auto-decline threshold — do not engage without his explicit override.");
    },
  },
  {
    name: "confirm",
    usage: "marketplace selling confirm <lead-id> --pickup <iso-datetime> [--listing <id>]",
    summary: "Confirm a sale at the listed price (autonomous); stages the pickup message.",
    async run(args, m, deps) {
      const { values, positionals } = parse(args, { listing: { type: "string" }, pickup: { type: "string" } });
      const leadId = req(positionals[0], "<lead-id>");
      const pickupAt = req(values.pickup, "--pickup");
      await withState(m, async (doc) => {
        const found = doc.leads.find((l) => l.id === leadId);
        if (!found) throw new UsageError(`Unknown lead "${leadId}".`);
        const listingId = values.listing ?? found.listingId;
        const listing = doc.listings.find((l) => l.id === listingId);
        if (!listing) throw new UsageError(`Unknown listing "${listingId}".`);
        const { doc: d1, lead } = confirmLead(doc, listingId, leadId, { pickupAt }, m.now());
        const body = renderTemplate(d1, "pickup-confirm", {
          name: lead.name,
          pickupTime: pickupAt,
          price: listing.price,
          payment: listing.payment,
          meetup: listing.meetup,
        });
        const { doc: d2, message } = stageMessage(d1, {
          kind: "confirmation",
          channel: lead.channel,
          threadId: lead.threadId,
          recipient: lead.name,
          body,
          listingId,
          leadId,
          // Price commitment + post-acceptance pickup details are a hard
          // stop — always his tap (HARD_STOP_KINDS also enforces this).
          sendAuthority: "per_message",
        }, m.now());
        deps.stdout(`Confirmed ${lead.name} at $${listing.price}${listing.priceFirm ? " firm" : ""}, pickup ${pickupAt}. Confirmation staged in outbox (id ${message.id}).`);
        const d3 = recordReliability(d2, lead.name, lead.threadId, "completed", m.now());
        const d4 = logActivity(d3, "confirmation", `Confirmed ${lead.name} at $${listing.price} for "${listing.title}" (pickup ${pickupAt}).`, m.now());
        return { doc: d4, value: undefined };
      });
    },
  },
  {
    name: "reply",
    usage: "marketplace selling reply <lead-id> --template <name> [--set k=v ...] [--tier auto|routine|per_message]",
    summary: "Render a template for a lead and stage it in the outbox (never sends). First replies and counters within 15% of ask stage at routine (standing auto-send); counters beyond that band or with any commitment use --tier per_message.",
    async run(args, m, deps) {
      const { values, positionals } = parse(args, { template: { type: "string" }, set: { type: "string", multiple: true }, tier: { type: "string" } });
      const leadId = req(positionals[0], "<lead-id>");
      const template = req(values.template, "--template");
      const tier = values.tier as "auto" | "routine" | "per_message" | undefined;
      if (tier && !["auto", "routine", "per_message"].includes(tier)) throw new UsageError(`--tier must be auto|routine|per_message.`);
      await withState(m, async (doc) => {
        const lead = doc.leads.find((l) => l.id === leadId);
        if (!lead) throw new UsageError(`Unknown lead "${leadId}".`);
        const listing = doc.listings.find((l) => l.id === lead.listingId)!;
        const ctx = {
          name: lead.name,
          item: listing.title,
          price: listing.price,
          payment: listing.payment,
          meetup: listing.meetup,
          ...kvPairs(values.set),
        };
        const body = renderTemplate(doc, template, ctx);
        const { doc: d2, message } = stageMessage(doc, {
          kind: "reply",
          channel: lead.channel,
          threadId: lead.threadId,
          recipient: lead.name,
          body,
          listingId: lead.listingId,
          leadId,
          // v3 plan §2: first replies + counters within 15% of ask ride on
          // standing authority; override with --tier when the counter
          // leaves the band or commits him to something.
          sendAuthority: tier ?? "routine",
        }, m.now());
        deps.stdout(`Staged reply to ${lead.name} (outbox id ${message.id}, tier ${tier ?? "routine"}):\n${body}`);
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "intake",
    usage: "marketplace selling intake --photos <p...> --sidecar <draft.json> [--approve] [--title T] [--price N] [--condition C] [--category G] [--obo] [--no-comps]",
    summary: "Photo-first intake: pull live comps for auto-pricing, attach the 25-mile price card, print a ladder suggestion + the one-tap approval summary, publish on --approve.",
    async run(args, m, deps) {
      const { values } = parse(args, {
        photos: { type: "string", multiple: true },
        sidecar: { type: "string" },
        approve: { type: "boolean", default: false },
        title: { type: "string" },
        price: { type: "string" },
        condition: { type: "string" },
        category: { type: "string" },
        obo: { type: "boolean", default: false },
        "no-comps": { type: "boolean", default: false },
      });
      const photos = values.photos ?? [];
      const sidecar = loadSidecar(req(values.sidecar, "--sidecar"));
      // Photo-first gate: low-confidence identification or unconfirmed specs → ask first, never draft on a guess.
      const readiness = intakeReadiness(sidecar, m.config().intake);
      if (!readiness.ready) {
        deps.stdout(`NEEDS ANSWERS before drafting (${readiness.reason}). Ask him:\n${readiness.questions.map((q, i) => `  ${i + 1}. ${q}`).join("\n")}\nThen update the sidecar and rerun. Nothing drafted, nothing published.`);
        return;
      }
      // Comp-based auto-pricing: live comps propose the price unless he pinned one.
      // The same pull builds the 25-mile price reference card (v3 plan §9, Phase 4).
      let priceCard: PriceReferenceCard | undefined;
      let comp: { price: number; compBasis: string; fromComps: boolean };
      if (values["no-comps"] || values.price) {
        comp = { price: sidecar.suggestedPrice, compBasis: "skipped — price pinned by sidecar/--price", fromComps: false };
      } else {
        const query = sidecar.brand ? `${sidecar.brand} ${sidecar.item}` : sidecar.item;
        const result = await resolveIntakeComps(query);
        priceCard = result.card;
        comp = result.fromComps
          ? { price: result.suggestedPrice as number, compBasis: result.compBasis, fromComps: true }
          : { price: sidecar.suggestedPrice, compBasis: `${sidecar.compBasis || "sidecar price"} (${result.compBasis})`, fromComps: false };
      }
      const overrides = {
        title: values.title,
        price: values.price ? Number(values.price) : (comp.fromComps ? comp.price : undefined),
        condition: values.condition,
        category: values.category,
        obo: values.obo || undefined,
      };
      const { errors, warnings } = validateIntake(photos, sidecar, overrides);
      for (const w of warnings) deps.stderr(`warning: ${w}`);
      if (errors.length > 0) {
        deps.stderr(`intake blocked:\n- ${errors.join("\n- ")}`);
        throw new UsageError("Fix the blockers above and rerun.");
      }
      const draft = buildIntakeDraft(photos, sidecar, overrides);
      deps.stdout(approvalSummary(draft));
      deps.stdout(`  Comp basis: ${comp.compBasis}${comp.fromComps ? ` — proposed $${comp.price}` : ""}`);
      if (priceCard) {
        deps.stdout(`  ${formatPriceCard(priceCard)}`);
        // Loop #1: the ladder suggestion learns from recorded sales (<5 sales → static default).
        const state = await m.openState();
        deps.stdout(`  ${formatLadderSuggestion(suggestLadder(state.document, draft.price))}`);
      }
      if (!values.approve) {
        deps.stdout("\nNot published. Rerun with --approve after his one-tap approval.");
        return;
      }
      const result = await publishApproved(draft);
      deps.stdout(`\nfacebook-cli: ${result.message}`);
      deps.stdout(result.live ? "Status: LIVE." : "Status: DRAFT (publish gate incomplete — see message).");
      await withState(m, async (doc) => {
        const { doc: d1, listing } = createListing(doc, {
          kind: "sale",
          title: draft.title,
          price: draft.price,
          priceFirm: draft.firm,
          payment: draft.payment,
          meetup: draft.meetup,
          description: draft.description,
          priceCard,
        }, m.now());
        const d2 = result.fbListingId ? attachFbListingId(d1, listing.id, result.fbListingId, m.now()) : d1;
        deps.stdout(`Registered listing "${listing.id}" in state; inquiry monitoring on.${result.fbListingId ? ` FB id ${result.fbListingId}.` : ""}`);
        return { doc: d2, value: undefined };
      });
      if (result.live) {
        const check = await messengerCheckRunner();
        deps.stdout(`Messenger readiness: ${check.trim().slice(0, 200)}`);
      }
    },
  },
  {
    name: "book",
    usage: "marketplace selling book <lead-id> --listing <id> --pickup-date <yyyy-mm-dd> --return-date <yyyy-mm-dd>",
    summary: "Draft a rental booking (pending-approval; his tap books it).",
    async run(args, m, deps) {
      const { values, positionals } = parse(args, {
        listing: { type: "string" },
        "pickup-date": { type: "string" },
        "return-date": { type: "string" },
      });
      const leadId = req(positionals[0], "<lead-id>");
      const listingId = req(values.listing, "--listing");
      await withState(m, async (doc) => {
        const { doc: d2, booking } = requestBooking(doc, listingId, {
          leadId,
          pickupDate: req(values["pickup-date"], "--pickup-date"),
          returnDate: req(values["return-date"], "--return-date"),
        }, m.now());
        deps.stdout(`Booking draft ${booking.id}: ${booking.pickupDate} → ${booking.returnDate}, deposit $${booking.deposit.amount}. Status: pending-approval — needs his tap.`);
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "approve-booking",
    usage: "marketplace selling approve-booking <booking-id>",
    summary: "Execute his approval: flip a pending booking to booked, stage the message.",
    async run(args, m, deps) {
      const { positionals } = parse(args, {});
      const bookingId = req(positionals[0], "<booking-id>");
      await withState(m, async (doc) => {
        const { doc: d1, booking } = approveBooking(doc, bookingId, m.now());
        const lead = d1.leads.find((l) => l.id === booking.leadId)!;
        const listing = d1.listings.find((l) => l.id === booking.listingId)!;
        const body = renderTemplate(d1, "booking-request", {
          name: lead.name,
          pickupDate: booking.pickupDate,
          dayRate: listing.terms!.dayRate,
          deposit: listing.terms!.deposit,
          depositMethods: listing.terms!.depositMethods.join("/"),
          meetup: listing.meetup,
        });
        const { doc: d2, message } = stageMessage(d1, {
          kind: "booking",
          channel: lead.channel,
          threadId: lead.threadId,
          recipient: lead.name,
          body,
          listingId: booking.listingId,
          leadId: booking.leadId,
          // Booking is a hard stop — always his tap (HARD_STOP_KINDS also enforces this).
          sendAuthority: "per_message",
        }, m.now());
        deps.stdout(`Booking ${booking.id} is now booked. Message staged in outbox (id ${message.id}).`);
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "advance",
    usage: "marketplace selling advance --listing <id>",
    summary: "Expire stale holds and auto-advance the queue (autonomous).",
    async run(args, m, deps) {
      const { values } = parse(args, { listing: { type: "string" } });
      const listingId = req(values.listing, "--listing");
      await withState(m, async (doc) => {
        const skipThreads = watchOnlySet(doc, m);
        const { doc: d2, result } = advanceExpiredHolds(doc, listingId, m.now(), { skipThreads });
        let d3 = d2;
        for (const e of result.expired) {
          deps.stdout(`Hold expired for ${e.name} — back to backup.`);
          d3 = recordReliability(d3, e.name, e.threadId, "hold-expired", m.now());
        }
        if (result.advanced) deps.stdout(`Advanced ${result.advanced.name} to hold at $${result.offeredPrice} (expires ${result.advanced.holdExpiresAt}).`);
        if (result.expired.length === 0) deps.stdout("No expired holds.");
        const { doc: d4, staged } = stageAdvanceMessages(d3, listingId, result, m.now(), { skipThreads });
        if (staged > 0) deps.stdout(`Staged ${staged} queue message(s) (hold lapsed / same-terms offer).`);
        return { doc: d4, value: undefined };
      });
    },
  },
  {
    name: "sold",
    usage: "marketplace selling sold --listing <id> --buyer <lead-id>",
    summary: "Mark a listing sold; other live leads are retired; the sale outcome is recorded for the pricing learning loop (autonomous).",
    async run(args, m, deps) {
      const { values } = parse(args, { listing: { type: "string" }, buyer: { type: "string" } });
      const listingId = req(values.listing, "--listing");
      const buyerId = req(values.buyer, "--buyer");
      await withState(m, async (doc) => {
        const { doc: d2, notify } = markSold(doc, listingId, buyerId, m.now());
        deps.stdout(`Listing ${listingId} marked sold. ${notify.length} other lead(s) retired.`);
        // Phase 4 (loop #1): the sale outcome recalibrates pricing + ladders.
        const listing = d2.listings.find((l) => l.id === listingId)!;
        const now = m.now();
        const { doc: d3a } = recordSaleOutcome(d2, { itemId: listingId, listPrice: listing.price, finalPrice: listing.price, soldAt: now });
        // Mirror the sale onto the running inventory row (plan §10).
        const d3b: typeof d3a = {
          ...d3a,
          inventory: {
            ...d3a.inventory,
            items: d3a.inventory.items.map((i) =>
              i.listingId === listingId ? { ...i, status: "sold" as const, soldPrice: listing.price, updatedAt: now } : i,
            ),
          },
          updatedAt: now,
        };
        deps.stdout(`Sale outcome recorded for learning (list $${listing.price} → final $${listing.price}).`);
        let d3 = d3b;
        for (const lead of notify) {
          const body = renderTemplate(d3, "sold-notice", { name: lead.name, item: d3.listings.find((l) => l.id === listingId)!.title });
          const r = stageMessage(d3, {
            kind: "sold-notice", channel: lead.channel, threadId: lead.threadId, recipient: lead.name, body,
            listingId, leadId: lead.id,
            // Routine courtesy notice — standing auto-send, no card.
            sendAuthority: "routine",
          }, m.now());
          d3 = r.doc;
        }
        if (notify.length > 0) deps.stdout(`Staged ${notify.length} sold-notice(s) in the outbox.`);
        return { doc: d3, value: undefined };
      });
    },
  },
  {
    name: "outbox",
    usage: "marketplace selling outbox [flush]",
    summary: "List pending outbox messages, or flush: standing-authority tiers (auto/routine) auto-send, the rest await his tap in one spurt.",
    async run(args, m, deps) {
      const { positionals } = parse(args, {});
      if (positionals[0] === "flush") {
        await withState(m, async (doc) => {
          const { doc: d2, spurt, autoSent, suppressed } = flushOutbox(doc, m.now(), m.config().ownerActivity.watchOnlyMinutes);
          if (suppressed.length > 0) deps.stdout(`Suppressed ${suppressed.length} message(s): the owner is active in those threads (watch-only). They will not be sent.`);
          if (spurt.length === 0 && autoSent.length === 0) {
            deps.stdout("Outbox is empty — nothing to flush.");
          } else {
            if (autoSent.length > 0) {
              deps.stdout(`AUTO-SENT under standing authority (${autoSent.length}): no card needed — the operating agent sends these now via hatch_messenger_cli (the CLI itself never writes to Messenger).\n`);
              deps.stdout(formatOutbox(autoSent));
            }
            if (spurt.length > 0) {
              deps.stdout(`SPURT: ${spurt.length} message(s) awaiting his tap. Send each via hatch_messenger_cli send (one approval card each), then run "marketplace selling sent <id...>".\n`);
              deps.stdout(formatOutbox(spurt));
            }
          }
          return { doc: d2, value: undefined };
        });
        return;
      }
      const state = await m.openState();
      deps.stdout(formatOutbox(pendingMessages(state.document)));
    },
  },
  {
    name: "sent",
    usage: "marketplace selling sent <outbox-id...>",
    summary: "Record that he tapped send on outbox messages (cards approved).",
    async run(args, m, deps) {
      const { positionals } = parse(args, {});
      if (positionals.length === 0) throw new UsageError("Provide at least one outbox id.");
      await withState(m, async (doc) => {
        const d2 = recordSent(doc, positionals, m.now());
        deps.stdout(`Marked ${positionals.length} message(s) sent.`);
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "nudge-due",
    usage: "marketplace selling nudge-due",
    summary: "Stage escalating nudges (gentle → firm → final-call) for stale threads (autonomous).",
    async run(_args, m, deps) {
      await withState(m, async (doc) => {
        const before = dueNudges(doc, m.now()).length;
        const { doc: d2, staged } = sendDueNudges(doc, m.now(), { skipThreads: watchOnlySet(doc, m) });
        let d3 = d2;
        for (const s of staged) {
          d3 = logActivity(d3, "nudge", `Nudge level ${s.level} (${s.template}) staged for ${s.lead.name} on "${d3.listings.find((l) => l.id === s.lead.listingId)?.title}".`, m.now());
        }
        if (staged.length === 0) {
          deps.stdout("No nudges due.");
        } else {
          for (const s of staged) deps.stdout(`Staged ${s.template} → ${s.lead.name} (level ${s.level}${s.lead.status === "dead" ? "; lead retired" : ""}).`);
        }
        deps.stdout(`${before} due, ${staged.length} staged (outbox dedupes re-runs).`);
        return { doc: d3, value: undefined };
      });
    },
  },
  {
    name: "offer",
    usage: "marketplace selling offer <lead-id> --amount <n>",
    summary: "Run a buyer's offer through the negotiation bands and stage the reply (autonomous; floor-bounded).",
    async run(args, m, deps) {
      const { values, positionals } = parse(args, { amount: { type: "string" } });
      const leadId = req(positionals[0], "<lead-id>");
      const amount = Number(req(values.amount, "--amount"));
      if (!(amount > 0)) throw new UsageError("--amount must be a positive number.");
      await withState(m, async (doc) => {
        const lead = doc.leads.find((l) => l.id === leadId);
        if (!lead) throw new UsageError(`Unknown lead "${leadId}".`);
        const { doc: d1, decision, lead: updated } = respondToOffer(doc, lead.listingId, leadId, amount, m.now(), m.config().negotiation);
        deps.stdout(`${lead.name} offered $${amount} (${decision.band}): ${decision.action} — ${decision.reason}`);
        let d2 = d1;
        if (isWatchOnly(d2, lead.threadId, m.now(), m.config().ownerActivity.watchOnlyMinutes)) {
          deps.stdout("Owner is active in this thread — watch-only: state updated, nothing staged.");
        } else if (decision.template) {
          d2 = stageNegotiationReply(d2, updated, decision, m.now());
          deps.stdout("Reply staged in the outbox.");
        }
        if (decision.escalation) {
          deps.stdout(`[${decision.escalation.reason}] ${decision.escalation.summary}`);
          d2 = logActivity(d2, "escalation", decision.escalation.summary.slice(0, 200), m.now());
        }
        d2 = logActivity(d2, "negotiation", `${lead.name} offered $${amount}: ${decision.action}.`, m.now());
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "floor",
    usage: "marketplace selling floor --listing <id> (--price <n> | --clear)",
    summary: "Set or clear a listing's floor price — the lowest the agent may ever agree to.",
    async run(args, m, deps) {
      const { values } = parse(args, { listing: { type: "string" }, price: { type: "string" }, clear: { type: "boolean", default: false } });
      const listingId = req(values.listing, "--listing");
      if (!values.clear && !values.price) throw new UsageError("Pass --price <n> or --clear.");
      const floor = values.clear ? undefined : Number(values.price);
      await withState(m, async (doc) => {
        const d2 = setFloorPrice(doc, listingId, floor, m.now());
        deps.stdout(floor === undefined ? `Floor cleared on ${listingId} — the counter band now restates the asking price.` : `Floor on ${listingId} set to $${floor}.`);
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "rental",
    usage: "marketplace selling rental <lead-id> --message <text>",
    summary: "Route a renter's message through the rental decision tree and stage the reply (never waives the deposit, never delivers).",
    async run(args, m, deps) {
      const { values, positionals } = parse(args, { message: { type: "string" } });
      const leadId = req(positionals[0], "<lead-id>");
      const message = req(values.message, "--message");
      await withState(m, async (doc) => {
        const lead = doc.leads.find((l) => l.id === leadId);
        if (!lead) throw new UsageError(`Unknown lead "${leadId}".`);
        const { doc: d1, decision, lead: updated } = evaluateRentalMessage(doc, lead.listingId, leadId, message, m.now(), m.config().rental);
        deps.stdout(`${lead.name}: ${decision.step}.`);
        let d2 = d1;
        if (isWatchOnly(d2, lead.threadId, m.now(), m.config().ownerActivity.watchOnlyMinutes)) {
          deps.stdout("Owner is active in this thread — watch-only: state updated, nothing staged.");
        } else {
          d2 = stageRentalReply(d2, updated, decision, m.now());
          deps.stdout("Reply staged in the outbox.");
        }
        if (decision.escalation) {
          deps.stdout(`[${decision.escalation.reason}] ${decision.escalation.summary}`);
          d2 = logActivity(d2, "escalation", decision.escalation.summary.slice(0, 200), m.now());
        }
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "health",
    usage: "marketplace selling health [--check-live]",
    summary: "Self-healing check: stale-listing suggestions (price-drop/refresh/retire); --check-live retires listings missing from my-listings.",
    async run(args, m, deps) {
      const { values } = parse(args, { "check-live": { type: "boolean", default: false } });
      await withState(m, async (doc) => {
        const stale = detectStaleListings(doc, m.now());
        if (stale.length === 0) {
          deps.stdout("No stale listings — every active listing has recent inquiries.");
        } else {
          deps.stdout("STALE LISTINGS (one-tap suggestions):");
          for (const s of stale) {
            deps.stdout(`  "${s.title}": ${s.reason} Suggested: ${s.action}${s.suggestedPrice !== undefined ? ` → $${s.suggestedPrice}` : ""}.`);
          }
        }
        // Stale auto-drop: OFF unless the owner enabled it in config.
        const drops = applyStaleDrops(doc, m.now(), m.config().staleDrop);
        let d2 = drops.doc;
        if (drops.disabled) {
          deps.stdout("Stale auto-drop: disabled (config staleDrop.enabled = false).");
        } else {
          for (const d of drops.applied) {
            deps.stdout(`Auto-dropped "${d.title}" $${d.from} → $${d.to} (floor $${d.floor}).`);
            d2 = logActivity(d2, "listing", `Auto-dropped "${d.title}" $${d.from} → $${d.to} after ${d.daysQuiet} quiet days.`, m.now());
          }
          for (const d of drops.needsApproval) deps.stdout(`Auto-drop needs his approval (no price-change authority): "${d.title}" $${d.from} → $${d.to}.`);
        }
        if (values["check-live"]) {
          const { execFile } = await import("node:child_process");
          const { doc: d3, retired } = await retireMissingListings(d2, (a) => new Promise((resolve, reject) => {
            execFile("facebook-cli", [...a], { timeout: 60_000 }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message))) : resolve(stdout)));
          }), m.now());
          d2 = d3;
          for (const r of retired) {
            deps.stdout(`Retired "${r.title}" — missing from my-listings (delisted or sold elsewhere).`);
            d2 = logActivity(d2, "listing", `Retired "${r.title}" — delisted/sold elsewhere.`, m.now());
          }
          if (retired.length === 0) deps.stdout("my-listings check: all tracked listings still live.");
        }
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "apply-drops",
    usage: "marketplace selling apply-drops",
    summary: "Execute due price-ladder drops across all listings (autonomous — the schedule was owner-approved at set-ladder; never below floor). Also runs inside sweep.",
    async run(_args, m, deps) {
      await withState(m, async (doc) => {
        const { doc: d2, applied } = applyDueDrops(doc, m.now());
        if (applied.length === 0) {
          deps.stdout("No price drops due.");
        } else {
          for (const a of applied) deps.stdout(`LADDER: "${a.title}" $${a.from} → $${a.to} (day ${a.dayOffset} drop applied).`);
          deps.stdout(`${applied.length} drop(s) applied.`);
        }
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "set-ladder",
    usage: 'marketplace selling set-ladder --listing <id> --drops "7:35,14:30" --floor 30',
    summary: "Attach an owner-approved price-drop schedule (dayOffset:price pairs, ascending days, every price ≥ floor). Drops then auto-execute on schedule via apply-drops/sweep.",
    async run(args, m, deps) {
      const { values } = parse(args, { listing: { type: "string" }, drops: { type: "string" }, floor: { type: "string" } });
      const listingId = req(values.listing, "--listing");
      const rawDrops = req(values.drops, "--drops");
      const floor = Number(req(values.floor, "--floor"));
      if (!Number.isFinite(floor) || floor < 0) throw new UsageError(`--floor must be a non-negative number, got "${values.floor}".`);
      const drops = rawDrops.split(",").map((pair) => {
        const parts = pair.trim().split(":");
        if (parts.length !== 2) throw new UsageError(`--drops expects dayOffset:price pairs, got "${pair.trim()}".`);
        const dayOffset = Number(parts[0]);
        const price = Number(parts[1]);
        if (!Number.isInteger(dayOffset) || dayOffset <= 0) throw new UsageError(`Day offset must be a positive integer, got "${parts[0]}".`);
        if (!Number.isFinite(price) || price <= 0) throw new UsageError(`Drop price must be positive, got "${parts[1]}".`);
        if (price < floor) throw new UsageError(`Drop price $${price} is below the floor $${floor} — ladders never cross the floor.`);
        return { dayOffset, price };
      });
      if (drops.length === 0) throw new UsageError("--drops needs at least one dayOffset:price pair.");
      const offsets = drops.map((d) => d.dayOffset);
      if (new Set(offsets).size !== offsets.length) throw new UsageError("Duplicate day offsets in --drops; each day appears once.");
      if (!offsets.every((o, i) => i === 0 || o > offsets[i - 1])) throw new UsageError("Day offsets must be ascending (e.g. \"7:35,14:30\").");
      await withState(m, async (doc) => {
        const listing = doc.listings.find((l) => l.id === listingId);
        if (!listing) throw new UsageError(`Unknown listing "${listingId}".`);
        const now = m.now();
        const priceLadder = { drops, floor, approvedAt: now, appliedDrops: [] as number[] };
        const updated = { ...listing, priceLadder, updatedAt: now };
        let d2: typeof doc = {
          ...doc,
          listings: doc.listings.map((l) => (l.id === listingId ? updated : l)),
          inventory: {
            ...doc.inventory,
            items: doc.inventory.items.map((i) => (i.listingId === listingId ? { ...i, priceLadder, updatedAt: now } : i)),
          },
          updatedAt: now,
        };
        d2 = logActivity(d2, "listing", `Price ladder approved for "${listing.title}": ${drops.map((d) => `day ${d.dayOffset} → $${d.price}`).join(", ")}, floor $${floor}.`, now);
        deps.stdout(`Ladder set on "${listing.title}" (approved ${now}): ${drops.map((d) => `day ${d.dayOffset} → $${d.price}`).join(", ")}; floor $${floor}. Drops auto-execute via "selling apply-drops" / sweep.`);
        return { doc: d2, value: undefined };
      });
    },
  },
];

const BUYING: readonly Command[] = [
  {
    name: "status",
    usage: "marketplace buying status",
    summary: "Hunt states and threads (read-only).",
    async run(_args, m, deps) {
      const state = await m.openState();
      const doc = state.document;
      const lines = ["BUYING STATUS"];
      for (const c of doc.campaigns) {
        lines.push(`  ${c.name} — ${c.status}${c.maxPrice ? ` — ceiling $${c.maxPrice}` : ""} — ${c.threads.length} threads`);
        lines.push(`    criteria: ${c.criteria}`);
      }
      deps.stdout(lines.join("\n"));
    },
  },
  {
    name: "start-hunt",
    usage: "marketplace buying start-hunt --name <n> --criteria <c> [--max-price <n>]",
    summary: "Start a hunt (approval-gated — new outbound campaigns are his call).",
    async run(args, m, deps) {
      const { values } = parse(args, { name: { type: "string" }, criteria: { type: "string" }, "max-price": { type: "string" } });
      await withState(m, async (doc) => {
        const { doc: d2, campaign, warnings } = startHunt(doc, {
          name: req(values.name, "--name"),
          criteria: req(values.criteria, "--criteria"),
          maxPrice: values["max-price"] ? Number(values["max-price"]) : undefined,
        }, m.now());
        deps.stdout(`Hunt "${campaign.name}" started.`);
        for (const warning of warnings) deps.stdout(`WARNING: ${warning}`);
        if (warnings.length > 0) deps.stdout(`Criteria tightened from kill history: ${campaign.criteria}`);
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "pause-hunt",
    usage: "marketplace buying pause-hunt <name>",
    summary: "Pause a hunt (autonomous).",
    async run(args, m, deps) {
      const { positionals } = parse(args, {});
      const name = req(positionals[0], "<name>");
      await withState(m, async (doc) => {
        const { doc: d2 } = pauseHunt(doc, name, m.now());
        deps.stdout(`Hunt "${name}" paused.`);
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "cancel-hunt",
    usage: "marketplace buying cancel-hunt <name> [--threads <csv>] [--template close-out|close-out-50pct] [--callback-number <n>] [--reason flakes|scams|overpriced|wrong-item|other] [--note \"...\"]",
    summary: "Kill-switch: cancel a hunt, stage templated close-outs, record the kill reason for kill-switch learning (autonomous).",
    async run(args, m, deps) {
      const { values, positionals } = parse(args, {
        threads: { type: "string" },
        template: { type: "string" },
        "callback-number": { type: "string" },
        reason: { type: "string" },
        note: { type: "string" },
      });
      const name = req(positionals[0], "<name>");
      const template = values.template as "close-out" | "close-out-50pct" | undefined;
      if (template && !["close-out", "close-out-50pct"].includes(template)) throw new UsageError(`--template must be close-out or close-out-50pct.`);
      const reasons: readonly HuntKillReason[] = ["flakes", "scams", "overpriced", "wrong-item", "other"];
      const reason = values.reason as HuntKillReason | undefined;
      if (reason && !reasons.includes(reason)) throw new UsageError(`--reason must be one of ${reasons.join("|")}.`);
      await withState(m, async (doc) => {
        const { doc: d2, staged } = cancelHunt(doc, name, {
          threadIds: values.threads ? values.threads.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
          template,
          callbackNumber: values["callback-number"],
          reason,
          note: values.note,
        }, m.now());
        deps.stdout(`Hunt "${name}" cancelled. Staged ${staged} close-out message(s) in the outbox.`);
        if (reason) deps.stdout(`Kill recorded (${reason}) — future similar hunts will start tighter.`);
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "outreach",
    usage: "marketplace buying outreach --hunt <n> --seller <profile-id> [--seller-name <n>] --message <text> [--thread <id>] [--item \"<item description>\"] [--force]",
    summary: "First outreach to a seller, guarded by contact history: repeat flakes (trust < 30) are skipped unless --force; known-good sellers get a firm-opener note. --item runs relist detection (urgency signal for the opener). Discovery message stages at routine.",
    async run(args, m, deps) {
      const { values } = parse(args, {
        hunt: { type: "string" },
        seller: { type: "string" },
        "seller-name": { type: "string" },
        message: { type: "string" },
        thread: { type: "string" },
        force: { type: "boolean" },
        item: { type: "string" },
      });
      await withState(m, async (doc) => {
        const result = outreachToSeller(doc, {
          huntName: req(values.hunt, "--hunt"),
          profileId: values.seller,
          sellerName: values["seller-name"],
          threadId: values.thread,
          message: req(values.message, "--message"),
          force: values.force,
        }, m.now());
        let d2 = result.doc;
        if (values.item && !result.skipped) {
          // Phase 4 (loop #2): same seller, similar item → urgency signal for the opener.
          const relist = detectRelist(d2, values.seller ?? values["seller-name"] ?? "", values.item, m.now());
          d2 = relist.doc;
          deps.stdout(`Relist check: ${relist.relistCount}x sighting${relist.relistCount > 1 ? "s" : ""}${relist.matched ? " — urgency signal, adjust the opener" : " — first sighting"}.`);
        }
        if (result.skipped) {
          deps.stdout(`Skipped outreach — seller trust ${result.trustScore}, repeat flake. Use --force to override.`);
        } else {
          deps.stdout(`Outreach staged at routine on thread ${result.threadId}.`);
          if (result.note) deps.stdout(`Note: ${result.note}`);
        }
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "suggest-opener",
    usage: "marketplace buying suggest-opener --hunt <name> [--relist-count <n>] [--days-on-market <n>] [--seller <profile-id>]",
    summary: "Predictive opener: learn the best opener % of ceiling from past negotiation outcomes, adjusted for seller signals (read-only).",
    async run(args, m, deps) {
      const { values } = parse(args, {
        hunt: { type: "string" },
        "relist-count": { type: "string" },
        "days-on-market": { type: "string" },
        seller: { type: "string" },
      });
      const state = await m.openState();
      const doc = state.document;
      const campaign = doc.campaigns.find((c) => c.name === req(values.hunt, "--hunt"));
      if (!campaign) throw new UsageError(`Unknown hunt "${values.hunt}".`);
      const contactScore = values.seller ? doc.contacts[values.seller]?.reliabilityScore : undefined;
      const { pctOfCeiling, rationale } = suggestOpener(
        { maxPrice: campaign.maxPrice, criteria: campaign.criteria },
        {
          relistCount: values["relist-count"] ? Number(values["relist-count"]) : undefined,
          daysOnMarket: values["days-on-market"] ? Number(values["days-on-market"]) : undefined,
          contactScore,
        },
        Object.values(doc.learning.negotiationOutcomes),
      );
      const dollars = campaign.maxPrice !== undefined ? ` ($${Math.round((pctOfCeiling / 100) * campaign.maxPrice)} on the $${campaign.maxPrice} ceiling)` : "";
      deps.stdout(`Suggested opener: ${pctOfCeiling}% of ceiling${dollars}.\n${rationale}`);
    },
  },
  {
    name: "leads",
    usage: "marketplace buying leads --hunt <name>",
    summary: "Show tracked seller threads for a hunt (read-only).",
    async run(args, m, deps) {
      const { values } = parse(args, { hunt: { type: "string" } });
      const name = req(values.hunt, "--hunt");
      const state = await m.openState();
      const c = state.document.campaigns.find((x) => x.name === name);
      if (!c) throw new UsageError(`Unknown hunt "${name}".`);
      deps.stdout(c.threads.length === 0 ? `Hunt "${name}" (${c.status}): no threads tracked.` : `Hunt "${name}" (${c.status}) threads:\n${c.threads.map((t) => `  ${t}`).join("\n")}`);
    },
  },
];

const SERVICES: readonly Command[] = [
  {
    name: "request",
    usage: 'marketplace services request --type home|cleaning --specs "..." --budget <n> --window "..."',
    summary: "Intake: open a service request and link an inventory service row (status requested). Budget must be > 0; specs required.",
    async run(args, m, deps) {
      const { values } = parse(args, { type: { type: "string" }, specs: { type: "string" }, budget: { type: "string" }, window: { type: "string" } });
      const type = req(values.type, "--type") as "home" | "cleaning";
      if (type !== "home" && type !== "cleaning") throw new UsageError(`--type must be home|cleaning, got "${values.type}".`);
      const budget = Number(req(values.budget, "--budget"));
      // Phase 4 (plan §9): the 25-mile service price card at intake —
      // soft-fails to an empty card when the comp pull finds nothing.
      let priceCard: PriceReferenceCard | undefined;
      try {
        priceCard = await buildPriceCard(facebookCompSource(), `${type === "cleaning" ? "house cleaning" : "home services"} ${req(values.specs, "--specs")}`.slice(0, 80));
        deps.stdout(`  ${formatPriceCard(priceCard)}`);
      } catch {
        deps.stdout("  Price card: comp pull failed — continuing without one.");
      }
      await withState(m, async (doc) => {
        try {
          const { doc: d2, request, inventoryId } = createServiceRequest(doc, {
            type,
            specs: req(values.specs, "--specs"),
            budgetCeiling: budget,
            timingWindow: values.window ?? "",
            priceCard,
          }, m.now());
          deps.stdout(`Service request ${request.id} opened (${type}): "${request.specs}".\nBudget $${budget}, window "${request.timingWindow}". Inventory row ${inventoryId} (status requested).`);
          return { doc: d2, value: undefined };
        } catch (error) {
          throw new UsageError((error as Error).message);
        }
      });
    },
  },
  {
    name: "add-quote",
    usage: 'marketplace services add-quote --request <id> --provider <name> --amount <n> [--notes "..."] [--available "..."] [--thread <id>]',
    summary: "Record a provider quote: flips the request to quoted, updates the inventory row, resets the 48h nudge clock.",
    async run(args, m, deps) {
      const { values } = parse(args, {
        request: { type: "string" },
        provider: { type: "string" },
        amount: { type: "string" },
        notes: { type: "string" },
        available: { type: "string" },
        thread: { type: "string" },
      });
      const amount = Number(req(values.amount, "--amount"));
      await withState(m, async (doc) => {
        try {
          const { doc: d2, quote } = addQuote(doc, req(values.request, "--request"), {
            providerName: req(values.provider, "--provider"),
            amount,
            notes: values.notes,
            available: values.available,
            threadId: values.thread,
          }, m.now());
          const count = d2.serviceRequests.find((r) => r.id === values.request)!.quotes.length;
          deps.stdout(`Quote recorded: ${quote.providerName} $${quote.amount} for request ${values.request} (status quoted, ${count} quote(s)).`);
          return { doc: d2, value: undefined };
        } catch (error) {
          throw new UsageError((error as Error).message);
        }
      });
    },
  },
  {
    name: "discover",
    usage: "marketplace services discover --request <id>",
    summary: "Run LIVE read-only facebook-cli marketplace searches for the request's criteria (25-mile radius of the Highland Village area) and print candidate providers with trust scores. Next: screen promising providers, then add-quote as replies land.",
    async run(args, m, deps) {
      const { values } = parse(args, { request: { type: "string" } });
      const state = await m.openState();
      const request = state.document.serviceRequests.find((r) => r.id === req(values.request, "--request"));
      if (!request) throw new UsageError(`Unknown service request "${values.request}".`);
      const { discoverProvidersWithQueries, formatCandidate } = await import("../marketplace/services/discover.js");
      const { resolveLiveTrustSignals } = await import("../marketplace/selling/trust-live.js");
      const pass = await discoverProvidersWithQueries(request);
      const batchPrices = pass.candidates.map((c) => c.price).filter((p): p is number => p !== undefined);
      deps.stdout(`LIVE DISCOVERY — request ${request.id} ("${request.specs}", budget $${request.budgetCeiling}, window "${request.timingWindow}")`);
      deps.stdout(`Searched ${pass.queries.length} querie(s) within 25 mi of the Highland Village area: ${pass.queries.map((q) => `"${q}"`).join(", ")}`);
      if (pass.candidates.length === 0) {
        deps.stdout("No candidates found. Try broadening the specs or check local groups manually.");
        return;
      }
      // Trust enrichment, bounded: seller-info per candidate, failures degrade to unknown.
      const TRUST_CAP = 8;
      for (const c of pass.candidates.slice(0, TRUST_CAP)) {
        let trustLabel = "n/a";
        try {
          const result = await resolveLiveTrustSignals({
            listingId: c.listingId,
            sellerId: c.sellerId,
            price: c.price,
            batchPrices,
            perQueryResults: pass.perQuery,
          });
          const who = result.reputation?.sellerName ? ` (${result.reputation.sellerName})` : "";
          const rating = result.reputation?.ratingAverage !== undefined
            ? `, ★${result.reputation.ratingAverage}×${result.reputation.ratingCount ?? 0}`
            : "";
          trustLabel = `${result.score.score}${who}${rating}`;
          if (result.score.reasons.length > 0) trustLabel += ` [${result.score.reasons.join("; ")}]`;
        } catch {
          // keep n/a
        }
        deps.stdout(formatCandidate(c, trustLabel));
      }
      for (const c of pass.candidates.slice(TRUST_CAP)) {
        deps.stdout(formatCandidate(c));
      }
      deps.stdout("");
      deps.stdout("Next steps (Karen voice: terse, direct — screening BEFORE price talk):");
      deps.stdout(`  marketplace services screen --request ${request.id} --provider "<name>"`);
      deps.stdout(`  marketplace services add-quote --request ${request.id} --provider "<name>" --amount <n> [--available "..."]`);
      deps.stdout(`  marketplace services compare --request ${request.id}   (aim for 3+ quotes)`);
    },
  },
  {
    name: "screen",
    usage: 'marketplace services screen --request <id> --provider <name> [--thread <id>]',
    summary: "Stage the per-subtype screening questions as ONE message at routine tier (before any price talk); records the provider as screened.",
    async run(args, m, deps) {
      const { values } = parse(args, { request: { type: "string" }, provider: { type: "string" }, thread: { type: "string" } });
      await withState(m, async (doc) => {
        try {
          const { doc: d2, messageId, body } = stageScreening(
            doc, req(values.request, "--request"), req(values.provider, "--provider"), values.thread, m.now(),
          );
          deps.stdout(`Screening questions staged to ${values.provider} (outbox id ${messageId}, tier routine):\n${body}`);
          return { doc: d2, value: undefined };
        } catch (error) {
          throw new UsageError((error as Error).message);
        }
      });
    },
  },
  {
    name: "add-reference",
    usage: 'marketplace services add-reference --request <id> --provider <name> --score <1-5> [--notes "..."]',
    summary: "Record a reference check from a past client (score 1–5). Scores ≤ 2 or flag words in notes mark the provider RED.",
    async run(args, m, deps) {
      const { values } = parse(args, {
        request: { type: "string" },
        provider: { type: "string" },
        score: { type: "string" },
        notes: { type: "string" },
      });
      const score = Number(req(values.score, "--score"));
      await withState(m, async (doc) => {
        try {
          const { doc: d2 } = recordReference(doc, req(values.request, "--request"), {
            providerName: req(values.provider, "--provider"),
            score,
            notes: values.notes,
          }, m.now());
          const check = checkReferences(values.provider!, d2.serviceRequests.find((r) => r.id === values.request)!.references);
          deps.stdout(`Reference recorded for ${values.provider}: ${score}/5${check.redFlags.length > 0 ? ` — RED FLAGS: ${check.redFlags.join("; ")}` : " — clean"}.`);
          return { doc: d2, value: undefined };
        } catch (error) {
          throw new UsageError((error as Error).message);
        }
      });
    },
  },
  {
    name: "check-references",
    usage: "marketplace services check-references --request <id> --provider <name>",
    summary: "Print the reference summary for a provider: count, average, and any RED flags (low scores, flag words). Read-only.",
    async run(args, m, deps) {
      const { values } = parse(args, { request: { type: "string" }, provider: { type: "string" } });
      const state = await m.openState();
      const request = state.document.serviceRequests.find((r) => r.id === req(values.request, "--request"));
      if (!request) throw new UsageError(`Unknown service request "${values.request}".`);
      const check = checkReferences(req(values.provider, "--provider"), request.references);
      const lines = [
        `REFERENCES — ${check.providerName} (request ${request.id})`,
        `  count: ${check.count}${check.avg !== undefined ? ` · avg: ${check.avg.toFixed(1)}/5` : ""}`,
      ];
      if (check.redFlags.length === 0) {
        lines.push(check.count === 0 ? "  no references recorded yet" : "  no red flags — clean");
      } else {
        lines.push(`  RED FLAGS:`);
        for (const f of check.redFlags) lines.push(`    - ${f}`);
      }
      deps.stdout(lines.join("\n"));
    },
  },
  {
    name: "compare",
    usage: "marketplace services compare --request <id>",
    summary: "Side-by-side quote table (provider, amount vs budget, availability fit, screened y/n, reference avg, red flags) plus the one-line recommendation. Read-only.",
    async run(args, m, deps) {
      const { values } = parse(args, { request: { type: "string" } });
      const state = await m.openState();
      const request = state.document.serviceRequests.find((r) => r.id === req(values.request, "--request"));
      if (!request) throw new UsageError(`Unknown service request "${values.request}".`);
      deps.stdout(formatComparison(request));
    },
  },
  {
    name: "nudge-due",
    usage: "marketplace services nudge-due",
    summary: "Stage the one 48h follow-up nudge for requests still waiting on quotes (single level, never twice).",
    async run(_args, m, deps) {
      await withState(m, async (doc) => {
        const due = servicesNudgeDue(doc, m.now());
        let d2 = doc;
        for (const { request } of due) {
          const { doc: d3, messageId } = stageServiceNudge(d2, request.id, m.now());
          d2 = d3;
          deps.stdout(`Staged 48h quote follow-up for request ${request.id} (outbox id ${messageId}, tier routine).`);
        }
        if (due.length === 0) deps.stdout("No service quote nudges due.");
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "book",
    usage: "marketplace services book --request <id> --provider <name>",
    summary: "HARD STOP: stage a booking confirmation (kind booking, per_message) for his tap. Nothing books without approve-booking.",
    async run(args, m, deps) {
      const { values } = parse(args, { request: { type: "string" }, provider: { type: "string" } });
      await withState(m, async (doc) => {
        try {
          const { doc: d2, messageId, body } = requestServiceBooking(
            doc, req(values.request, "--request"), req(values.provider, "--provider"), m.now(),
          );
          deps.stdout(`Booking confirmation staged for ${values.provider} (outbox id ${messageId}).\n${body}\n\nAwaiting his tap — run "marketplace services approve-booking --request ${values.request}" to confirm.`);
          return { doc: d2, value: undefined };
        } catch (error) {
          throw new UsageError((error as Error).message);
        }
      });
    },
  },
  {
    name: "approve-booking",
    usage: "marketplace services approve-booking --request <id>",
    summary: "His explicit tap: confirm the pending booking — flips the request and inventory row to booked with the quoted cost.",
    async run(args, m, deps) {
      const { values } = parse(args, { request: { type: "string" } });
      await withState(m, async (doc) => {
        try {
          const { doc: d2 } = approveServiceBooking(doc, req(values.request, "--request"), m.now());
          const request = d2.serviceRequests.find((r) => r.id === values.request)!;
          deps.stdout(`BOOKED: request ${request.id} with provider ${request.providerId}. Request + inventory row are now booked.`);
          return { doc: d2, value: undefined };
        } catch (error) {
          throw new UsageError((error as Error).message);
        }
      });
    },
  },
  {
    name: "rate",
    usage: 'marketplace services rate --request <id> --score <1-5> [--notes "..."]',
    summary: "Record his post-service 1–5 rating: updates provider trust (running mean, learning loop #6), marks request/inventory done.",
    async run(args, m, deps) {
      const { values } = parse(args, { request: { type: "string" }, score: { type: "string" }, notes: { type: "string" } });
      const score = Number(req(values.score, "--score"));
      await withState(m, async (doc) => {
        try {
          const { doc: d2 } = rateService(doc, req(values.request, "--request"), score, values.notes, m.now());
          const request = d2.serviceRequests.find((r) => r.id === values.request)!;
          const trust = d2.learning.providerTrust[request.providerId!];
          deps.stdout(`Rated ${score}/5. Provider trust for ${request.providerId}: ${trust.score.toFixed(1)} over ${trust.jobs} job(s). Request marked done.`);
          return { doc: d2, value: undefined };
        } catch (error) {
          throw new UsageError((error as Error).message);
        }
      });
    },
  },
];

const CHANNELS: readonly Command[] = [  {
    name: "poll",
    usage: "marketplace channels poll [--since <iso>]",
    summary: "Poll Messenger + Voice SMS + AgentMail, match to leads, run scam + logistics checks (read-only; writes state only).",
    async run(args, m, deps) {
      const { values } = parse(args, { since: { type: "string" } });
      const since = values.since ?? new Date(Date.now() - 24 * 3600_000).toISOString();
      const events = await pollAll(m.pollers(), since);
      await withState(m, async (doc) => {
        // Watermark-based incremental reads: skip anything already read per
        // thread, then dedupe by event id. Runaway cap: 200 events per poll.
        const delta = filterByWatermark(doc, events).slice(0, 200);
        const fresh = dedupe(doc, delta);
        let d2: typeof doc = { ...doc, seenEvents: [...doc.seenEvents, ...fresh.map((e) => e.id)] };
        const lines: string[] = [`Polled 3 channels since ${since}: ${events.length} event(s), ${fresh.length} new.`];
        const escalations: string[] = [];

        const cfg = m.config();
        const now = m.now();
        // Owner vs agent by sender id: the agent sends through the owner's account, so a message
        // from the owner's id that matches an outbox send is the agent's own, anything else is his.
        const roles = new Map(fresh.map((e) => [e.id, e.senderId ? classifySender(d2, { threadId: e.threadId, senderId: e.senderId, body: e.body }) : "counterparty"]));
        const ownerEvents = fresh.filter((e) => roles.get(e.id) === "owner");
        if (ownerEvents.length > 0) {
          const messages = ownerEvents.map((e) => ({ threadId: e.threadId, senderId: e.senderId!, senderName: e.senderName, body: e.body, sentAt: e.sentAt }));
          d2 = recordOwnerActivity(d2, messages);
          const { doc: d3, report } = reconcileOwnerActivity(d2, messages);
          d2 = d3;
          for (const n of report.notes) lines.push(`owner: ${n}`);
        }

        for (const event of fresh) {
          if (roles.get(event.id) !== "counterparty") continue;
          try {
            // Watch-only: the owner wrote here inside the window — update state, never stage a message.
            const watchOnly = isWatchOnly(d2, event.threadId, now, cfg.ownerActivity.watchOnlyMinutes);
            const lead = matchLead(d2, event);
            const screen = screenInbound(event.body);
            if (screen.flagged) {
              const esc = escalate("scam-flagged", `Scam-flagged inbound from ${event.senderName} (${event.channel}): ${screen.reasons.join(", ")}`, {
                sender: event.senderName, channel: event.channel, threadId: event.threadId, reasons: screen.reasons.join(","),
              });
              escalations.push(`[${esc.reason}] ${esc.summary} — no auto-reply sent.`);

              continue;
            }
            if (lead && lead.listingId) {
              const listing = d2.listings.find((l) => l.id === lead.listingId);
              const priceAccepted = lead.status === "confirmed";
              if (listing && isLogisticsHandoff(event.body, priceAccepted)) {
                // THE selling hard stop: holding reply + escalate, never address/time.
                if (!watchOnly) {
                  const body = renderTemplate(d2, "holding-logistics", { name: event.senderName });
                  d2 = stageMessage(d2, {
                    kind: "reply",
                    channel: event.channel,
                    threadId: event.threadId,
                    recipient: event.senderName,
                    body,
                    listingId: lead.listingId,
                    leadId: lead.id,
                    // The warm deferral commits nothing — routine tier so it
                    // auto-sends under standing authority (v3).
                    sendAuthority: "routine",
                  }, now).doc;
                }
                const esc = escalate("logistics-handoff",
                  `LOGISTICS HANDOFF: ${event.senderName} accepted $${listing.price}${listing.priceFirm ? " firm" : ""} for "${listing.title}" and is asking for address/pickup time. ${watchOnly ? "You're active in the thread, so no holding reply was staged" : "Holding reply staged"} — address/time handoff is Toozy's call (suggest Highland Village public meetup).`,
                  { buyer: event.senderName, item: listing.title, price: String(listing.price), threadId: event.threadId, message: event.body.slice(0, 200) });
                escalations.push(`[${esc.reason}] ${esc.summary}`);
                continue;
              }
            }
            // BUYING side: seller thread on an active hunt — check the deal-agreed hard stop.
            const campaign = d2.campaigns.find((c) => c.status === "active" && c.threads.includes(event.threadId));
            if (campaign) {
              const acceptance = detectSellerAcceptance(event.body, campaign.maxPrice);
              if (acceptance.accepted) {
                const esc = escalate("deal-agreed",
                  `DEAL AGREED: ${event.senderName} said yes${acceptance.price !== undefined ? ` at $${acceptance.price}` : ""} on hunt "${campaign.name}" (${campaign.criteria}). No reply sent to the seller, no pickup committed, no money moved — "seller said yes at your price, here's the deal, want it?"`,
                  { seller: event.senderName, hunt: campaign.name, price: acceptance.price !== undefined ? String(acceptance.price) : "", threadId: event.threadId, message: event.body.slice(0, 200) });
                escalations.push(`[${esc.reason}] ${esc.summary}`);
                continue;
              }
            }
            if (!lead) {
              lines.push(`new: ${event.senderName} (${event.channel}, thread ${event.threadId}): "${event.body.slice(0, 100)}"`);
              continue;
            }
            lines.push(`lead ${lead.id}: ${event.senderName}: "${event.body.slice(0, 100)}"${watchOnly ? " [watch-only]" : ""}`);
            // Buyer reliability: contact + lowball pattern detection.
            d2 = recordReliability(d2, event.senderName, event.threadId, "contact", now);
            const listing = lead.listingId ? d2.listings.find((l) => l.id === lead.listingId) : undefined;
            if (!listing) continue;
            if (listing.priceFirm) {
              const lowball = detectLowballOffer(event.body, listing.price);
              if (lowball !== undefined) {
                d2 = recordReliability(d2, event.senderName, event.threadId, "lowball", now);
                lines.push(`  lowball pattern: ${event.senderName} offered $${lowball} vs $${listing.price} firm (reliability score now ${buyerScore(d2, event.senderName)})`);
              }
            }
            const agentMayReply = lead.needsAgentFollowUp && canAutonomous(d2, sellingScope(listing.id), ACTIONS.REPLY) && ["new", "contacted", "hold"].includes(lead.status);
            if (!agentMayReply) continue;
            if (listing.kind === "sale") {
              // Negotiation bands: polite hold / one firm counter at the floor / decline; stalls escalate.
              const offer = extractOffer(event.body, listing.price);
              if (offer === undefined) continue;
              const current = d2.leads.find((l) => l.id === lead.id)!;
              const { doc: d3, decision, lead: updated } = respondToOffer(d2, listing.id, current.id, offer, now, cfg.negotiation);
              d2 = watchOnly ? d3 : stageNegotiationReply(d3, updated, decision, now);
              lines.push(`  offer $${offer}: ${decision.action}${watchOnly ? " (watch-only, nothing staged)" : decision.template ? " (reply staged)" : ""}`);
              d2 = logActivity(d2, "negotiation", `${lead.name} offered $${offer} on "${listing.title}": ${decision.action}.`, now);
              if (decision.escalation) escalations.push(`[${decision.escalation.reason}] ${decision.escalation.summary}`);
            } else {
              // Rental decision tree: delivery → decline; rate → deposit → specific time → ready for his tap.
              const current = d2.leads.find((l) => l.id === lead.id)!;
              const { doc: d3, decision, lead: updated } = evaluateRentalMessage(d2, listing.id, current.id, event.body, now, cfg.rental);
              d2 = watchOnly ? d3 : stageRentalReply(d3, updated, decision, now);
              lines.push(`  rental: ${decision.step}${watchOnly ? " (watch-only, nothing staged)" : " (reply staged)"}`);
              if (decision.escalation) escalations.push(`[${decision.escalation.reason}] ${decision.escalation.summary}`);
            }
          } catch (error) {
            // One bad event never takes the poll down: log it, keep going.
            logParseFailure("poll.event", error, event);
            lines.push(`skipped event ${event.id}: ${(error as Error).message}`);
          }
        }

        if (escalations.length > 0) {
          lines.push("\nESCALATIONS (surface to Toozy):");
          for (const e of escalations) {
            lines.push(`  ${e}`);
            d2 = logActivity(d2, "escalation", e.slice(0, 200), m.now());
          }
        }
        // Watermarks + rolling summaries: raw bodies are summarized once,
        // then dropped — full histories are never re-read.
        d2 = updateWatermarks(d2, fresh);
        d2 = await rollSummaries(d2, fresh, undefined, m.now());
        deps.stdout(lines.join("\n"));
        return { doc: { ...d2, updatedAt: m.now() }, value: undefined as void };
      });
    },
  },
];

/**
 * Runaway guards (ADR 0024): per-run caps so a headless loop can never
 * spiral — max threads touched, max thread age, max events per poll.
 */
const MAX_THREADS_PER_SWEEP = 50;
const MAX_THREAD_AGE_DAYS = 60;
const MAX_EVENTS_PER_POLL = 200;

const TOPLEVEL: readonly Command[] = [
  {
    name: "sweep",
    usage: "marketplace sweep",
    summary: "One pass, all listings: incremental poll → advance holds → due nudges → stale check (shared sweep window, no per-listing polling).",
    async run(_args, m, deps) {
      const lines = ["SWEEP — one pass, all listings"];
      // Reliability: collect this run's parse failures (still logged to stderr with the raw output)
      // and isolate every step, so one bad payload or one bad listing never crashes the run.
      const failures: ParseFailure[] = [];
      const restore = setParseFailureSink((f) => {
        failures.push(f);
        process.stderr.write(`${JSON.stringify(f)}\n`);
      });
      const step = async (name: string, fn: () => Promise<void>) => {
        try {
          await fn();
        } catch (error) {
          logParseFailure(`sweep.${name}`, error, "");
          lines.push(`${name}: FAILED (${(error as Error).message}) — continuing.`);
        }
      };
      const sub = { ...deps, stdout: (s: string) => lines.push(s) };
      try {
        // 1. Incremental poll (watermarks; capped events).
        await step("poll", () => findCommand(CHANNELS, "poll").run([], m, sub));
        // 2. Advance expired holds on every active listing (thread-age cap), staging lapse/offer messages.
        await step("advance", async () => {
          const state = await m.openState();
          const now = m.now();
          const cutoff = new Date(new Date(now).getTime() - MAX_THREAD_AGE_DAYS * 24 * 3600_000).toISOString();
          const active = state.document.listings.filter((l) => isLiveListingStatus(l.status) && l.monitoring).slice(0, MAX_THREADS_PER_SWEEP);
          let advanced = 0;
          let expired = 0;
          for (const listing of active) {
            try {
              await withState(m, async (doc) => {
                const skipThreads = watchOnlySet(doc, m, now);
                const { doc: d2, result } = advanceExpiredHolds(doc, listing.id, now, { skipThreads });
                let d3 = d2;
                for (const e of result.expired) {
                  if (e.firstSeenAt < cutoff) continue; // runaway guard: ancient threads age out quietly
                  d3 = recordReliability(d3, e.name, e.threadId, "hold-expired", now);
                  expired++;
                }
                if (result.advanced) {
                  advanced++;
                  d3 = logActivity(d3, "queue", `Hold lapsed on "${listing.title}"; advanced ${result.advanced.name} at $${result.offeredPrice}.`, now);
                }
                const { doc: d4 } = stageAdvanceMessages(d3, listing.id, result, now, { skipThreads });
                return { doc: d4, value: undefined };
              });
            } catch (error) {
              if (error instanceof AuthorityError) {
                lines.push(`advance: skipped "${listing.title}" — no advance-queue authority in this scope.`);
                continue;
              }
              logParseFailure("sweep.advance.listing", error, listing.id);
              lines.push(`advance: "${listing.title}" failed (${(error as Error).message}) — continuing.`);
            }
          }
          lines.push(`advance: ${expired} hold(s) expired, ${advanced} queue(s) advanced.`);
        });
        // 3. Due nudges (autonomous, outbox-deduped, watch-only threads skipped).
        await step("nudge", () => findCommand(SELLING, "nudge-due").run([], m, sub));
        // 4. Stale-listing suggestions + auto-drop (disabled by default; no live check in the loop — cheap).
        await step("health", () => findCommand(SELLING, "health").run([], m, sub));
      } finally {
        restore();
      }
      if (failures.length > 0) {
        lines.push(`parse failures: ${failures.length} (raw outputs logged to stderr as marketplace.parse_failure records).`);

        try {
          await withState(m, async (doc) => {
            let d2 = doc;
            for (const f of failures.slice(0, 20)) d2 = logActivity(d2, "parse-failure", `${f.source}: ${f.error.slice(0, 120)}`, m.now());
            return { doc: d2, value: undefined };
          });
        } catch {
          /* recording the failures must not fail the run */
        }
      }
      lines.push(`advance: ${expired} hold(s) expired, ${advanced} queue(s) advanced.`);
      // 3. Owner-approved price ladders: due drops auto-execute on schedule (v3 plan §2).
      await findCommand(SELLING, "apply-drops").run([], m, { ...deps, stdout: (s: string) => lines.push(s) });
      // 4. Due nudges (autonomous, outbox-deduped).
      await findCommand(SELLING, "nudge-due").run([], m, { ...deps, stdout: (s: string) => lines.push(s) });
      // 4b. Services lane: the single 48h quote follow-up nudge per request.
      await findCommand(SERVICES, "nudge-due").run([], m, { ...deps, stdout: (s: string) => lines.push(s) });
      // 4c. Phase 4 (loop #5): trust decay — cheap, idempotent, no network.
      await withState(m, async (doc) => {
        const { doc: d2, decayed } = decayTrust(doc, now);
        if (decayed.length > 0) lines.push(`trust-decay: ${decayed.length} contact(s) regressed toward neutral.`);
        return { doc: d2, value: undefined };
      });
      // 5. Stale-listing suggestions (no live check in the loop — cheap).
      await findCommand(SELLING, "health").run([], m, { ...deps, stdout: (s: string) => lines.push(s) });

      deps.stdout(lines.join("\n"));
    },
  },
  {
    name: "digest",
    usage: "marketplace digest [--since <iso>]",
    summary: "End-of-day digest in four sections: active listings + new inquiries, negotiations, rentals, action needed.",
    async run(args, m, deps) {
      const { values } = parse(args, { since: { type: "string" } });
      const since = values.since ?? new Date(Date.now() - 24 * 3600_000).toISOString();
      const state = await m.openState();
      const doc = state.document;
      const recent = doc.activity.filter((a) => a.at >= since);
      const lines = [`MARKETPLACE DIGEST (since ${since})`];
      if (recent.length === 0) lines.push("  Nothing to report — no confirmations, bookings, escalations, or nudges.");
      const byKind: Record<string, string[]> = {};
      for (const a of recent) (byKind[a.kind] ??= []).push(`  [${a.at.slice(0, 16)}] ${a.text}`);
      for (const [kind, items] of Object.entries(byKind)) {
        lines.push(`${kind.toUpperCase()} (${items.length}):`);
        lines.push(...items.slice(0, 10));
      }
      const stale = detectStaleListings(doc, m.now());
      if (stale.length > 0) {
        lines.push(`STALE LISTINGS (${stale.length}):`);
        for (const s of stale) lines.push(`  "${s.title}": ${s.reason} Suggest: ${s.action}${s.suggestedPrice !== undefined ? ` → $${s.suggestedPrice}` : ""}`);
      }
      const pending = pendingMessages(doc).length;
      const held = awaitingTap(doc).length;
      lines.push(`Outbox: ${held} message(s) awaiting his tap; ${pending} staged pending (auto/routine flush on their own).`);
      // Phase 4 (plan §10): inventory changes ride the digest.
      const changed = changedInventoryRows(doc, since);
      if (changed.length > 0) {
        lines.push(`INVENTORY CHANGES (${changed.length}):`);
        lines.push(...changed.slice(0, 20));
      }
      deps.stdout(lines.join("\n"));

    },
  },
  {
    name: "inventory",
    usage: "marketplace inventory",
    summary: "Running inventory readout: items for sale, service requests, wanted-item hunts, grouped by status (read-only).",
    async run(_args, m, deps) {
      const state = await m.openState();
      deps.stdout(formatInventory(state.document));
    },
  },
];

const LEARNING: readonly Command[] = [
  {
    name: "summary",
    usage: "marketplace learning summary",
    summary: "Analytics block: sales count, avg days-to-close, avg final-vs-list, negotiation close rate by opener bucket, kill reasons, provider ratings (read-only).",
    async run(_args, m, deps) {
      const state = await m.openState();
      deps.stdout(formatLearningSummary(state.document));
    },
  },
  {
    name: "approval-windows",
    usage: "marketplace learning approval-windows",
    summary: "Recompute his approval tap windows (per-hour-of-week probability, rolling 14 days) and print the top windows (read-only apart from the recompute).",
    async run(_args, m, deps) {
      await withState(m, async (doc) => {
        const { doc: d2, hourlyTapProbability, tapsInWindow } = recomputeApprovalWindows(doc, m.now());
        if (tapsInWindow === 0) {
          deps.stdout("No approval taps in the last 14 days — no windows yet. Taps feed automatically via `selling sent`.");
        } else {
          const top = topWindows(hourlyTapProbability, 6);
          deps.stdout(`Top approval windows (${tapsInWindow} tap(s), rolling 14 days):`);
          for (const w of top) deps.stdout(`  ${w.label}: ${Math.round(w.probability * 100)}% of taps`);
        }
        return { doc: d2, value: undefined };
      });
    },
  },
  {
    name: "decay-trust",
    usage: "marketplace learning decay-trust",
    summary: "Regress stale contact trust scores 10% toward neutral per week of 7+ day inactivity (autonomous; also runs inside sweep).",
    async run(_args, m, deps) {
      await withState(m, async (doc) => {
        const { doc: d2, decayed } = decayTrust(doc, m.now());
        if (decayed.length === 0) {
          deps.stdout("No stale contacts — nothing decayed.");
        } else {
          deps.stdout(`Decayed ${decayed.length} contact(s) toward neutral:`);
          for (const d of decayed) deps.stdout(`  ${d.name ?? d.id}: ${d.from} → ${d.to} (${d.weeksInactive}w inactive)`);
        }
        return { doc: d2, value: undefined };
      });
    },
  },
];

function findCommand(table: readonly Command[], name: string | undefined): Command {
  const cmd = table.find((c) => c.name === name);
  if (!cmd) throw new UsageError(`Unknown subcommand "${name ?? ""}".`);
  return cmd;
}

function usageFor(table: readonly Command[], title: string): string {
  return [`${title}:`, ...table.map((c) => `  ${c.usage}\n    ${c.summary}`)].join("\n");
}

/**
 * `orchestrator marketplace selling|buying|services|channels|learning|sweep|digest|inventory ...`
 * Read-only commands never send. Outbound is always staged → flushed in spurts.
 */
export async function runMarketplaceCommand(args: readonly string[], m: MarketplaceDeps, deps: CliDeps): Promise<void> {
  const [mechanism, sub, ...rest] = args;
  try {
    if (mechanism === "selling") {
      const cmd = findCommand(SELLING, sub);
      await cmd.run(rest, m, deps);
      return;
    }
    if (mechanism === "buying") {
      const cmd = findCommand(BUYING, sub);
      await cmd.run(rest, m, deps);
      return;
    }
    if (mechanism === "services") {
      const cmd = findCommand(SERVICES, sub);
      await cmd.run(rest, m, deps);
      return;
    }
    if (mechanism === "channels") {
      const cmd = findCommand(CHANNELS, sub);
      await cmd.run(rest, m, deps);
      return;
    }
    if (mechanism === "learning") {
      const cmd = findCommand(LEARNING, sub);
      await cmd.run(rest, m, deps);
      return;
    }
    if (mechanism === "sweep" || mechanism === "digest" || mechanism === "inventory") {
      const cmd = findCommand(TOPLEVEL, mechanism);
      await cmd.run([sub, ...rest].filter((x): x is string => x !== undefined), m, deps);
      return;
    }
    throw new UsageError(`Expected selling|buying|services|channels|learning|sweep|digest|inventory, got "${mechanism ?? ""}".`);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr(`Usage: orchestrator marketplace <selling|buying|services|channels|sweep|digest> <command>\n\n${usageFor(SELLING, "selling")}\n\n${usageFor(BUYING, "buying")}\n\n${usageFor(SERVICES, "services")}\n\n${usageFor(CHANNELS, "channels")}\n\n${usageFor(TOPLEVEL, "top-level")}`);
      deps.stderr(`\nError: ${(error as Error).message}`);
      throw error;
    }
    throw error;
  }
}

/** Entry used by src/cli/index.ts — opens state from the working directory. */
export async function runMarketplaceCommandFromCwd(args: readonly string[], deps: CliDeps): Promise<number> {
  const m = createMarketplaceDeps({ cwd: deps.cwd });
  await runMarketplaceCommand(args, m, deps);
  return 0;
}

/** Test helper: run against in-memory state. */
export function createTestMarketplaceDeps(): MarketplaceDeps {
  return createMarketplaceDeps({ storage: new InMemoryMarketplaceStorage(), now: () => "2026-09-26T05:00:00Z" });
}
