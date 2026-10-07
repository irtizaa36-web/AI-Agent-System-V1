import { randomUUID } from "node:crypto";
import type { Campaign, HuntKill, HuntKillReason, TrackerDocument } from "../types";
import { ACTIONS, assertAutonomous, BUYING_SCOPE } from "../policy";
import { renderTemplate } from "../templates";
import { stageMessage } from "../outbox";
import { logActivity } from "../state";

/**
 * BUYING — hunt definitions and lifecycle (ADR 0024).
 *
 * Hunts are outbound deal searches: item criteria (e.g. genuine-Apple-only),
 * price ceilings, seller outreach, offer sequences with walk-away points,
 * deal verification (authenticity). Start/pause/cancel lifecycle lives here.
 *
 * Hard stops: any PURCHASE needs Toozy's approval (he pays) — there is no
 * autonomous path to money moving out. Outreach, offers within ceiling, and
 * close-outs are autonomous.
 */

export interface StartHuntInput {
  readonly name: string;
  readonly criteria: string;
  readonly maxPrice?: number;
}

/**
 * Kill-switch learning (v3 plan §3, §6.3): before a new hunt starts, scan
 * learning.huntKills for kills with similar criteria and tighten the new
 * hunt accordingly. Matching is intentionally simple and documented:
 * tokenize both criteria strings (lowercase, split on non-alphanumerics,
 * drop tokens shorter than 3 chars and common stopwords); two criteria are
 * "similar" when they share ≥ 2 content tokens. Similar kills produce a
 * warning each and auto-append exclusion rules to the new hunt's criteria.
 */
const CRITERIA_STOPWORDS = new Set([
  "the", "and", "for", "with", "only", "from", "good", "new", "used", "like", "any", "all", "are",
]);

function criteriaTokens(criteria: string): readonly string[] {
  const tokens = criteria.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !CRITERIA_STOPWORDS.has(t));
  return [...new Set(tokens)];
}

/** Hunt kills whose criteria look like the given criteria (token-overlap match). */
export function similarHuntKills(doc: TrackerDocument, criteria: string): readonly HuntKill[] {
  const tokens = new Set(criteriaTokens(criteria));
  return doc.learning.huntKills.filter((kill) => {
    const killTokens = new Set(criteriaTokens(kill.criteria));
    let overlap = 0;
    for (const t of tokens) if (killTokens.has(t)) overlap++;
    return overlap >= 2;
  });
}

/** Reason-derived exclusion rules auto-appended to a new hunt's criteria. */
export function exclusionRuleForReason(reason: HuntKillReason): string | undefined {
  switch (reason) {
    case "flakes": return "sellers with flake history (trust < 30)";
    case "scams": return "sellers failing the scam screen";
    case "overpriced": return "listings priced above the ceiling or stale relists";
    case "wrong-item": return "variants outside the stated criteria";
    case "other": return undefined;
  }
}

/**
 * Build the kill-history warnings + the criteria text for a new hunt.
 * Grouped by kill reason so two kills for the same reason read as one line.
 */
export function applyKillLearning(doc: TrackerDocument, criteria: string): { criteria: string; warnings: readonly string[] } {
  const similar = similarHuntKills(doc, criteria);
  if (similar.length === 0) return { criteria, warnings: [] };
  const byReason = new Map<HuntKillReason, number>();
  for (const kill of similar) byReason.set(kill.reason, (byReason.get(kill.reason) ?? 0) + 1);
  const warnings = [...byReason.entries()].map(([reason, n]) =>
    `killed ${n} similar hunt${n === 1 ? "" : "s"} for ${reason} — consider a lower ceiling`);
  const rules = [...new Set([...byReason.keys()].map(exclusionRuleForReason).filter((r): r is string => r !== undefined))];
  const tightened = rules.length > 0 ? `${criteria.trim()} [excludes: ${rules.join("; ")}]` : criteria;
  return { criteria: tightened, warnings };
}

/** Starting a hunt is owner-initiated (he names the item + max price — that IS
 * the approval). Headless loops must never call this on their own. */
export function startHunt(doc: TrackerDocument, input: StartHuntInput, nowIso: string): { doc: TrackerDocument; campaign: Campaign; warnings: readonly string[] } {
  if (doc.campaigns.some((c) => c.name === input.name && c.status !== "cancelled")) {
    throw new Error(`Hunt "${input.name}" already exists and is not cancelled.`);
  }
  const { criteria, warnings } = applyKillLearning(doc, input.criteria);
  const campaign: Campaign = {
    id: `hunt-${randomUUID().slice(0, 8)}`,
    name: input.name,
    status: "active",
    criteria,
    maxPrice: input.maxPrice,
    threads: [],
    offers: [],
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  let next: TrackerDocument = { ...doc, campaigns: [...doc.campaigns, campaign], updatedAt: nowIso };
  for (const warning of warnings) {
    next = logActivity(next, "hunt", `Hunt "${input.name}" started with a kill-history warning: ${warning}`, nowIso);
  }
  return { doc: next, campaign, warnings };
}

export function pauseHunt(doc: TrackerDocument, name: string, nowIso: string): { doc: TrackerDocument; campaign: Campaign } {
  assertAutonomous(doc, BUYING_SCOPE, ACTIONS.PAUSE_HUNT);
  const campaign = findActive(doc, name);
  const updated: Campaign = { ...campaign, status: "paused", updatedAt: nowIso };
  return { doc: withCampaign(doc, updated, nowIso), campaign: updated };
}

export interface CancelHuntInput {
  /** Thread ids to receive the templated close-out. */
  readonly threadIds?: readonly string[];
  /** "close-out" | "close-out-50pct" — the 50% follow-up variant leaves a callback number. */
  readonly template?: "close-out" | "close-out-50pct";
  readonly callbackNumber?: string;
  /**
   * Why the hunt was killed (v3 plan §3, learning loop #3). When supplied,
   * the kill is recorded in learning.huntKills and tightens future hunts.
   */
  readonly reason?: HuntKillReason;
  /** Free-form note stored with the kill record. */
  readonly note?: string;
}

/**
 * Cancel a hunt and stage a templated close-out to each supplied thread.
 * Autonomous — kill-switch with templated close-outs. Close-outs are routine
 * traffic: they stage at `routine` (standing authority, v3 plan §3/§5), not
 * per_message.
 */
export function cancelHunt(doc: TrackerDocument, name: string, input: CancelHuntInput = {}, nowIso: string = new Date().toISOString()): { doc: TrackerDocument; campaign: Campaign; staged: number } {
  assertAutonomous(doc, BUYING_SCOPE, ACTIONS.CLOSE_OUT);
  const campaign = findActive(doc, name);
  const updated: Campaign = { ...campaign, status: "cancelled", cancelledAt: nowIso, updatedAt: nowIso };
  let next = withCampaign(doc, updated, nowIso);

  if (input.reason) {
    const kill: HuntKill = {
      huntName: name,
      criteria: campaign.criteria,
      reason: input.reason,
      note: input.note,
      at: nowIso,
    };
    next = {
      ...next,
      learning: { ...next.learning, huntKills: [...next.learning.huntKills, kill] },
      updatedAt: nowIso,
    };
    next = logActivity(next, "hunt", `Hunt "${name}" killed: ${input.reason}${input.note ? ` — ${input.note}` : ""}.`, nowIso);
  }

  const template = input.template ?? "close-out";
  if (template === "close-out-50pct" && !input.callbackNumber) {
    throw new Error(`cancelHunt with the "close-out-50pct" template needs a callbackNumber.`);
  }
  let staged = 0;
  for (const threadId of input.threadIds ?? campaign.threads) {
    const body = renderTemplate(next, template, {
      name: "there",
      callbackNumber: input.callbackNumber ?? "n/a",
    });
    const result = stageMessage(next, {
      kind: "close-out",
      channel: "messenger",
      threadId,
      recipient: threadId,
      body,
      sendAuthority: "routine",
    }, nowIso);
    next = result.doc;
    staged++;
  }
  return { doc: next, campaign: updated, staged };
}

/** Track an outreach thread under a hunt. */
export function trackThread(doc: TrackerDocument, campaignId: string, threadId: string, nowIso: string): TrackerDocument {
  const campaign = doc.campaigns.find((c) => c.id === campaignId);
  if (!campaign) throw new Error(`Unknown campaign "${campaignId}".`);
  if (campaign.threads.includes(threadId)) return doc;
  return withCampaign(doc, { ...campaign, threads: [...campaign.threads, threadId] }, nowIso);
}

/**
 * Walk-away check: an offer above the hunt's ceiling is never made
 * autonomously — it escalates instead of sending.
 */
export function offerWithinCeiling(campaign: Campaign, amount: number): boolean {
  if (campaign.maxPrice === undefined) return true;
  return amount <= campaign.maxPrice;
}

/** Record an offer on a hunt thread (both sides of the negotiation). */
export function recordOffer(
  doc: TrackerDocument,
  campaignName: string,
  threadId: string,
  amount: number,
  kind: "ours" | "theirs",
  nowIso: string,
): TrackerDocument {
  const campaign = doc.campaigns.find((c) => c.name === campaignName);
  if (!campaign) throw new Error(`Unknown hunt "${campaignName}".`);
  const updated: Campaign = {
    ...campaign,
    offers: [...campaign.offers, { threadId, amount, kind, at: nowIso }],
  };
  return withCampaign(doc, updated, nowIso);
}

export type NegotiateStep = { readonly action: "offer"; readonly amount: number } | { readonly action: "walk-away"; readonly reason: string };

/**
 * Stage an offer/counter message on a hunt thread at `routine` tier
 * (standing authority, v3 plan §3). The amount MUST be at or below the
 * hunt ceiling — offers above the ceiling are never made autonomously
 * (negotiateStep walks away instead), so this throws rather than staging
 * an unauthorized offer. A seller's agreement (deal-agreed) is a separate
 * hard stop — never a staged message.
 */
export function stageOffer(
  doc: TrackerDocument,
  campaignName: string,
  threadId: string,
  amount: number,
  body: string,
  nowIso: string,
): { doc: TrackerDocument; message: import("../types").OutboxMessage } {
  assertAutonomous(doc, BUYING_SCOPE, ACTIONS.OFFER);
  const campaign = doc.campaigns.find((c) => c.name === campaignName);
  if (!campaign) throw new Error(`Unknown hunt "${campaignName}".`);
  if (!offerWithinCeiling(campaign, amount)) {
    throw new Error(`Refusing to stage a $${amount} offer above the $${campaign.maxPrice} ceiling of hunt "${campaignName}".`);
  }
  const { doc: d2, message } = stageMessage(doc, {
    kind: "reply",
    channel: "messenger",
    threadId,
    recipient: threadId,
    body,
    sendAuthority: "routine",
  }, nowIso);
  return { doc: d2, message };
}

/**
 * Autonomous negotiation step for a seller's ask. Policy:
 *   - ask at/under ceiling → handled by detectSellerAcceptance (ping, not here).
 *   - ask over ceiling, first time on this thread → counter AT the ceiling.
 *   - ask over ceiling again after our ceiling counter → walk away.
 * Never offers above the ceiling. Never says "I'll take it" — the
 * deal-agreed ping is Toozy's call.
 */
export function negotiateStep(campaign: Campaign, threadId: string, theirAsk: number): NegotiateStep {
  const ceiling = campaign.maxPrice;
  if (ceiling === undefined) return { action: "offer", amount: theirAsk };
  if (theirAsk <= ceiling) return { action: "offer", amount: theirAsk };
  const ourCounters = campaign.offers.filter((o) => o.threadId === threadId && o.kind === "ours" && o.amount >= ceiling).length;
  if (ourCounters === 0) return { action: "offer", amount: ceiling };
  return { action: "walk-away", reason: `Seller holding above the $${ceiling} ceiling after our counter at ceiling.` };
}

const SELLER_YES = /\b(deal|agreed|yes|yeah|yep|sounds good|works for me|ok(ay)?|confirmed|i accept)\b/i;
const PRICE_RE = /\$\s?(\d+(?:\.\d{1,2})?)/;

export interface SellerAcceptance {
  readonly accepted: boolean;
  readonly price?: number;
}

/**
 * THE buying hard stop detector. A seller AGREES to our predetermined price
 * (at or under the ceiling) → accepted. The caller must NOT message the
 * seller ("I'll take it"), commit to pickup, or move money — it raises the
 * deal-agreed escalation: "seller said yes at your price, here's the deal,
 * want it?"
 */
export function detectSellerAcceptance(body: string, ceiling: number | undefined): SellerAcceptance {
  const text = body ?? "";
  if (!SELLER_YES.test(text)) return { accepted: false };
  const m = PRICE_RE.exec(text);
  if (!m) return { accepted: true };
  const price = Number(m[1]);
  if (ceiling !== undefined && price > ceiling) return { accepted: false, price };
  return { accepted: true, price };
}

function findActive(doc: TrackerDocument, name: string): Campaign {
  const campaign = doc.campaigns.find((c) => c.name === name);
  if (!campaign) throw new Error(`Unknown hunt "${name}".`);
  if (campaign.status === "cancelled") throw new Error(`Hunt "${name}" is already cancelled.`);
  return campaign;
}

function withCampaign(doc: TrackerDocument, campaign: Campaign, nowIso: string): TrackerDocument {
  return {
    ...doc,
    campaigns: doc.campaigns.map((c) => (c.id === campaign.id ? { ...campaign, updatedAt: nowIso } : c)),
    updatedAt: nowIso,
  };
}
