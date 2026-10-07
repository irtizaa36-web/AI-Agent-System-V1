import type { Lead, TrackerDocument } from "../types";
import { ACTIONS, assertAutonomous, sellingScope } from "../policy";
import { renderTemplate } from "../templates";
import { stageMessage } from "../outbox";

/**
 * SELLING — auto-nudge cadence (ADR 0024).
 *
 * Every thread carries turn-state: awaiting-them (we're waiting on the
 * buyer) or awaiting-us, plus hold-expiry. Stale awaiting-them threads get
 * nudged on schedule with escalating assertiveness:
 *   level 1 "gentle"  → after 24h of silence,
 *   level 2 "firm"    → after 72h,
 *   level 3 "final-call" → after 7 days, then the lead retires to "dead".
 * Toozy never has to say "nudge them" again — the sweep stages due nudges
 * (deduped by the outbox) and he taps them in a spurt.
 */

export const NUDGE_LEVELS = ["nudge-gentle", "nudge-firm", "nudge-final"] as const;

/** Silence thresholds (ms) before each nudge level is due. */
const NUDGE_AFTER_MS = [24 * 3600_000, 72 * 3600_000, 7 * 24 * 3600_000];

export interface DueNudge {
  readonly lead: Lead;
  /** 1-based: 1 = gentle, 2 = firm, 3 = final-call. */
  readonly level: number;
  readonly template: (typeof NUDGE_LEVELS)[number];
}

/** Which leads are due for their next nudge right now. */
export function dueNudges(doc: TrackerDocument, nowIso: string): DueNudge[] {
  const now = new Date(nowIso).getTime();
  const due: DueNudge[] = [];
  for (const lead of doc.leads) {
    if (!lead.needsAgentFollowUp) continue;
    if (lead.awaiting !== "them") continue;
    if (!["new", "contacted"].includes(lead.status)) continue;
    if (lead.nudgeLevel >= NUDGE_LEVELS.length) continue;
    const since = new Date(lead.lastNudgeAt ?? lead.lastContactAt).getTime();
    if (now - since >= NUDGE_AFTER_MS[lead.nudgeLevel]) {
      due.push({ lead, level: lead.nudgeLevel + 1, template: NUDGE_LEVELS[lead.nudgeLevel] });
    }
  }
  return due.sort((a, b) => b.level - a.level);
}

/**
 * Stage all due nudges into the outbox (autonomous "nudge" action).
 * Final-call nudges retire the lead to "dead" after staging — the queue
 * moves on without him having to ask.
 */
export function sendDueNudges(
  doc: TrackerDocument,
  nowIso: string,
  opts: { readonly skipThreads?: ReadonlySet<string> } = {},
): { doc: TrackerDocument; staged: DueNudge[] } {
  // Owner watch-only threads get no nudge (state untouched, so it comes due again after the window).
  const due = dueNudges(doc, nowIso).filter((d) => !opts.skipThreads?.has(d.lead.threadId));
  let next = doc;
  const staged: DueNudge[] = [];
  for (const { lead, level, template } of due) {
    assertAutonomous(next, sellingScope(lead.listingId), ACTIONS.NUDGE);
    const listing = next.listings.find((l) => l.id === lead.listingId);
    if (!listing) continue;
    const body = renderTemplate(next, template, {
      name: lead.name,
      item: listing.title,
      price: listing.price,
      meetup: listing.meetup,
    });
    const stagedMsg = stageMessage(next, {
      kind: "nudge",
      channel: lead.channel,
      threadId: lead.threadId,
      recipient: lead.name,
      body,
      listingId: lead.listingId,
      leadId: lead.id,
      // v3 plan §2: nudges stage at "routine" — his standing decision is
      // full auto on routine, so flush dispatches these without a card.
      sendAuthority: "routine",
    }, nowIso);
    next = stagedMsg.doc;
    const retired = level >= NUDGE_LEVELS.length;
    const updated: Lead = {
      ...lead,
      nudgeLevel: level,
      lastNudgeAt: nowIso,
      lastContactAt: nowIso,
      status: retired ? "dead" : lead.status,
      notes: [...lead.notes, retired ? `Final-call nudge sent at ${nowIso}; lead retired.` : `Nudge level ${level} staged at ${nowIso}.`],
    };
    next = { ...next, leads: next.leads.map((l) => (l.id === lead.id ? updated : l)), updatedAt: nowIso };
    staged.push({ lead: updated, level, template });
  }
  return { doc: next, staged };
}
