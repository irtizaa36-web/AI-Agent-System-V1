import { randomUUID } from "node:crypto";
import type { Channel, OutboxKind, OutboxMessage, SendAuthority, TrackerDocument } from "./types";
import { DEFAULT_CONFIG } from "./config";
import { isWatchOnly } from "./owner_activity";
import { appendTapTimestamp } from "./learning/approval";

/**
 * Send queue (ADR 0024). Nothing goes straight to Messenger: every outbound
 * message is staged here first, then flushed in batches — Toozy's "5-minute
 * spurts" for the approval-card workflow. A flush marks messages
 * "awaiting-tap" and prints the EXACT text awaiting his tap; the operating
 * agent sends them (one approval card each) and records them "sent".
 *
 * The agent never waits idly on approvals: between spurts it keeps working
 * the other threads.
 */

export interface StageInput {
  readonly kind: OutboxKind;
  readonly channel: Channel;
  readonly threadId: string;
  readonly recipient: string;
  readonly body: string;
  /** v3: approval tier. Defaults to "per_message" — staging never grants authority silently. */
  readonly sendAuthority?: SendAuthority;
  readonly listingId?: string;
  readonly leadId?: string;
}

/**
 * Stage an outbound message. Nothing goes straight to Messenger: every
 * outbound message is staged here first, then flushed in batches —
 * Toozy's "5-minute spurts" for the approval-card workflow.
 *
 * Runaway guard: the same body is never staged twice for the same thread
 * while the first copy is still pending/awaiting-tap. Returns the existing
 * message with duplicated: true instead of drafting a duplicate nudge.
 */
export function stageMessage(doc: TrackerDocument, input: StageInput, now: string = new Date().toISOString()): { doc: TrackerDocument; message: OutboxMessage; duplicated: boolean } {
  const duplicate = doc.outbox.find(
    (m) => m.threadId === input.threadId && m.body === input.body && (m.status === "pending" || m.status === "awaiting-tap"),
  );
  if (duplicate) return { doc, message: duplicate, duplicated: true };
  const message: OutboxMessage = {
    id: randomUUID(),
    kind: input.kind,
    channel: input.channel,
    threadId: input.threadId,
    recipient: input.recipient,
    body: input.body,
    stagedAt: now,
    status: "pending",
    sendAuthority: input.sendAuthority ?? "per_message",
    listingId: input.listingId,
    leadId: input.leadId,
  };
  return { doc: { ...doc, outbox: [...doc.outbox, message], updatedAt: now }, message, duplicated: false };
}

export function pendingMessages(doc: TrackerDocument): OutboxMessage[] {
  return doc.outbox.filter((m) => m.status === "pending");
}

export function awaitingTap(doc: TrackerDocument): OutboxMessage[] {
  return doc.outbox.filter((m) => m.status === "awaiting-tap");
}

/**
/**
 * Flush under the standing send-authority model (his locked decision:
 * FULL AUTO on routine from day one; taps reserved for commits/hard
 * stops only), with the owner-activity backstop (ADR 0024): a message for
 * a thread where the owner wrote within the watch window is marked
 * "suppressed" and never sent nor carded.
 *
 * - tiers "auto"/"routine" (non-hard-stop kinds): marked "sent" immediately
 *   with sentAt — the operating agent sends them now under standing authority.
 * - "per_message" tier and every HARD_STOP_KINDS message: moved to
 *   "awaiting-tap" and returned in the spurt for his approval cards.
 * - watch-only threads: suppressed regardless of tier.
 */
export function flushOutbox(
  doc: TrackerDocument,
  now: string = new Date().toISOString(),
  watchOnlyMinutes: number = DEFAULT_CONFIG.ownerActivity.watchOnlyMinutes,
): FlushResult {
  const pending = pendingMessages(doc);
  const suppressed = pending.filter((m) => isWatchOnly(doc, m.threadId, now, watchOnlyMinutes));
  const suppressedIds = new Set(suppressed.map((m) => m.id));
  const eligible = pending.filter((m) => !suppressedIds.has(m.id));
  const auto = eligible.filter(autoSendable);
  const autoIds = new Set(auto.map((m) => m.id));
  const held = eligible.filter((m) => !autoIds.has(m.id));
  const heldIds = new Set(held.map((m) => m.id));
  const outbox = doc.outbox.map((m) =>
    autoIds.has(m.id)
      ? { ...m, status: "sent" as const, sentAt: now }
      : heldIds.has(m.id)
        ? { ...m, status: "awaiting-tap" as const }
        : suppressedIds.has(m.id)
          ? { ...m, status: "suppressed" as const }
          : m,
  );
  return {
    doc: { ...doc, outbox, updatedAt: now },
    spurt: held.map((m) => ({ ...m, status: "awaiting-tap" as const })),
    autoSent: auto.map((m) => ({ ...m, status: "sent" as const, sentAt: now })),
    suppressed: suppressed.map((m) => ({ ...m, status: "suppressed" as const })),
  };
}

/**
 * Message kinds that NEVER auto-send, regardless of tier (v3 plan §2/§5 —
 * his locked decision: taps reserved for commits and hard stops only).
 * Checked before ANY auto-send, so a mis-tiered message can never slip
 * through.
 * - "confirmation": price commitment AND post-acceptance pickup details
 *   (the confirm flow stages both in one pickup-confirm message) — always his tap.
 * - "booking": rental booking commit — always his tap.
 * - "sms-draft": Voice SMS stays drafts-only per standing policy — always his tap.
 */
export const HARD_STOP_KINDS: ReadonlySet<OutboxKind> = new Set(["confirmation", "booking", "sms-draft"]);

/** True when a pending message may leave the outbox on standing authority alone. */
export function autoSendable(m: Pick<OutboxMessage, "kind" | "sendAuthority">): boolean {
  if (HARD_STOP_KINDS.has(m.kind)) return false;
  return m.sendAuthority === "auto" || m.sendAuthority === "routine";
}
}

export interface FlushResult {
  readonly doc: TrackerDocument;
  /**
   * The approval-card spurt: per_message-tier messages plus hard-stop
   * kinds. These are the ONLY messages that need his tap.
   */
  readonly spurt: OutboxMessage[];
  /**
   * Tier auto/routine messages dispatched under his standing authority —
   * no card. Bodies are kept for audit; the operating agent sends them
   * now (the CLI itself never writes to Messenger).
   */
  readonly autoSent: OutboxMessage[];
  /** Watch-only backstop: held because the owner is active in the thread; never sent. */
  readonly suppressed: OutboxMessage[];
}


/**
 * Record that the owner tapped send on these messages (cards approved).
 * Every tap timestamp feeds learning.approvalPatterns — an append-only
 * stats update (window 14d; avg tap delay recomputed incrementally).
 * Minimal for now; Phase 4 builds the approval-window queue on it.
 */
export function recordSent(doc: TrackerDocument, ids: readonly string[], now: string = new Date().toISOString()): TrackerDocument {
  const set = new Set(ids);
  const tapped: OutboxMessage[] = doc.outbox.filter((m) => set.has(m.id) && m.status === "awaiting-tap");
  let next: TrackerDocument = {
    ...doc,
    outbox: doc.outbox.map((m) => (set.has(m.id) ? { ...m, status: "sent" as const, sentAt: now } : m)),
    updatedAt: now,
  };
  for (const m of tapped) next = recordApprovalTap(next, m, now);
  return next;
}

function recordApprovalTap(doc: TrackerDocument, message: OutboxMessage, now: string): TrackerDocument {
  const prev = doc.learning.approvalPatterns["global"] ?? { windowDays: 14, tapCount: 0, avgTapDelayMinutes: 0 };
  const delayMinutes = Math.max(0, (new Date(now).getTime() - new Date(message.stagedAt).getTime()) / 60000);
  const tapCount = prev.tapCount + 1;
  const avgTapDelayMinutes = (prev.avgTapDelayMinutes * prev.tapCount + delayMinutes) / tapCount;
  return {
    ...doc,
    learning: {
      ...doc.learning,
      approvalPatterns: {
        ...doc.learning.approvalPatterns,
        global: { windowDays: 14, tapCount, avgTapDelayMinutes, lastTapAt: now },
      },
      // Phase 4 (loop #4): tap timestamps feed the approval-window
      // distribution (rolling 14-day window, capped).
      approvalTaps: appendTapTimestamp(doc.learning.approvalTaps, now),
    },
    updatedAt: now,
  };
}
