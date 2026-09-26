import { randomUUID } from "node:crypto";
import { redactCodes, SecretCode } from "./redact";
import { defaultAliases, normalizeService, NEVER_VERIFY, REAL_MOBILE_ONLY, servicesNamed } from "./services";
import type { VoiceStateStore } from "./store";
import type { AlertReason, PendingVerification, SecurityAlert, VoiceInbound } from "./types";

/**
 * The verification-code broker (ADR 0023). The agent may use an incoming
 * code only when all three hold:
 *
 *   (a) the agent itself started a pending verification for that service,
 *   (b) that verification is less than VERIFICATION_WINDOW_MS old, and
 *   (c) the service named in the message is that service, and no other
 *       service with an open verification is named alongside it.
 *
 * Any other code is a security signal. The broker records an alert for
 * Toozy and does nothing with the code. Codes never reach the state file or
 * an alert: alerts store redacted text, a pending verification records only
 * the message id it was satisfied by, and the code itself leaves this
 * module only as a SecretCode.
 */

export const VERIFICATION_WINDOW_MS = 10 * 60 * 1000;

// Deliberately narrow: "confirm", "security" or "PIN" alone show up in ordinary buyer texts.
const CODE_CONTEXT = /\b(code|verification|verify|passcode|one[- ]time|otp|2fa|two[- ]factor|sign[- ]?in|log[- ]?in)\b/i;
const CODE_CANDIDATE = /(?<![\d])(?:([A-Z]{1,3})-)?(\d{3,4}[ -]?\d{1,4})(?![\d])/g;

/**
 * The code in a message, when the message reads like a verification text:
 * it must use verification wording and contain exactly one distinct
 * 4–8 digit code. Two different candidates is ambiguous, so it returns
 * undefined rather than guessing, and the message is handled as a non-code.
 */
export function extractCode(text: string): SecretCode | undefined {
  if (!CODE_CONTEXT.test(text)) return undefined;
  const found = new Set<string>();
  for (const match of text.matchAll(CODE_CANDIDATE)) {
    const digits = match[2].replace(/\D/g, "");
    if (digits.length >= 4 && digits.length <= 8) found.add(digits);
  }
  if (found.size !== 1) return undefined;
  return new SecretCode([...found][0]);
}

/** Whether a message reads like a verification text, even when the code is ambiguous. */
export function looksLikeVerificationText(text: string): boolean {
  return CODE_CONTEXT.test(text) && redactCodes(text) !== text;
}

export type CodeOutcome =
  | { readonly kind: "disabled" }
  | { readonly kind: "not-a-code" }
  | { readonly kind: "already-processed" }
  | { readonly kind: "consumed"; readonly pending: PendingVerification; readonly code: SecretCode }
  | { readonly kind: "alert"; readonly alert: SecurityAlert };

export class VerificationError extends Error {}

export interface BrokerOptions {
  readonly enabled: boolean;
  readonly now?: () => Date;
}

export class VerificationBroker {
  private readonly now: () => Date;

  constructor(
    private readonly store: VoiceStateStore,
    private readonly options: BrokerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.options.enabled;
  }

  /** Called by the agent right before it asks a service to text a code, for a flow Toozy asked for. */
  async start(service: string, input: { readonly purpose: string; readonly aliases?: readonly string[] }): Promise<PendingVerification> {
    if (!this.options.enabled) throw new VerificationError("The verification-code broker is off (VOICE_CODE_BROKER_ENABLED is not \"true\").");
    const key = normalizeService(service);
    if (key.length === 0) throw new VerificationError("service is required");
    if (NEVER_VERIFY.has(key))
      throw new VerificationError(`${key} is never verified through the Voice number (ADR 0023). No pending verification was opened.`);
    if (REAL_MOBILE_ONLY.has(key))
      throw new VerificationError(`${key} is verified with the real mobile, never the Voice number (ADR 0023). No pending verification was opened.`);
    if (input.purpose.trim().length === 0) throw new VerificationError("purpose is required: say which of Toozy's requests this verification is for");
    const aliases = [...new Set([...defaultAliases(key), ...(input.aliases ?? []).map(normalizeService)].filter((a) => a.length > 0))];
    const pending: PendingVerification = {
      id: `ver-${randomUUID().slice(0, 8)}`,
      service: key,
      aliases,
      purpose: input.purpose.trim(),
      startedAt: this.now().toISOString(),
      status: "open",
    };
    await this.store.update((doc) => ({ ...doc, pending: [...doc.pending, pending] }));
    return pending;
  }

  async cancel(id: string): Promise<PendingVerification> {
    let cancelled: PendingVerification | undefined;
    await this.store.update((doc) => {
      const found = doc.pending.find((p) => p.id === id);
      if (!found) throw new VerificationError(`No pending verification "${id}".`);
      if (found.status !== "open") throw new VerificationError(`Verification "${id}" is already ${found.status}.`);
      cancelled = { ...found, status: "cancelled", closedAt: this.now().toISOString() };
      return { ...doc, pending: doc.pending.map((p) => (p.id === id ? cancelled! : p)) };
    });
    return cancelled!;
  }

  async list(): Promise<readonly PendingVerification[]> {
    return (await this.store.load()).pending;
  }

  isFresh(pending: PendingVerification): boolean {
    const age = this.now().getTime() - Date.parse(pending.startedAt);
    return age >= 0 && age < VERIFICATION_WINDOW_MS;
  }

  /**
   * Decides what happens to one inbound message. Messages without a
   * verification-shaped code return "not-a-code" so the reply drafter can
   * look at them; everything code-shaped ends here, as either "consumed" or
   * an alert.
   */
  async ingest(message: VoiceInbound): Promise<CodeOutcome> {
    if (!this.options.enabled) return { kind: "disabled" };
    if (!looksLikeVerificationText(message.text)) return { kind: "not-a-code" };

    let outcome: CodeOutcome = { kind: "already-processed" };
    await this.store.update((doc) => {
      if (doc.processedMessageIds.includes(message.messageId)) return doc;
      const processed = [...doc.processedMessageIds, message.messageId];
      const code = extractCode(message.text);
      const open = doc.pending.filter((p) => p.status === "open");
      const decision = decide(message.text, code, open, (p) => this.isFresh(p));

      if (decision.kind === "match" && code) {
        const closed: PendingVerification = {
          ...decision.pending,
          status: "consumed",
          closedAt: this.now().toISOString(),
          consumedFromMessageId: message.messageId,
        };
        outcome = { kind: "consumed", pending: closed, code };
        return { ...doc, processedMessageIds: processed, pending: doc.pending.map((p) => (p.id === closed.id ? closed : p)) };
      }
      const reason = decision.kind === "match" ? "ambiguous-service" : decision.reason;
      const detail = decision.kind === "match" ? "The message contains more than one possible code." : decision.detail;
      const alert = makeAlert(message, reason, detail, this.now());
      outcome = { kind: "alert", alert };
      return { ...doc, processedMessageIds: processed, alerts: [...doc.alerts, alert] };
    });
    return outcome;
  }
}

type Decision =
  | { readonly kind: "match"; readonly pending: PendingVerification }
  | { readonly kind: "no-match"; readonly reason: AlertReason; readonly detail: string };

function decide(
  text: string,
  code: SecretCode | undefined,
  open: readonly PendingVerification[],
  isFresh: (p: PendingVerification) => boolean,
): Decision {
  const extra = Object.fromEntries(open.map((p) => [p.service, p.aliases]));
  const named = servicesNamed(text, extra);
  const namedList = [...named].sort().join(", ") || "none";

  if (open.length === 0)
    return { kind: "no-match", reason: "no-pending-verification", detail: `A code arrived but the agent started no verification. Services named: ${namedList}.` };

  const fresh = open.filter(isFresh);
  if (fresh.length === 0)
    return {
      kind: "no-match",
      reason: "pending-expired",
      detail: `A code arrived, but every open verification is more than 10 minutes old (${open.map((p) => p.service).join(", ")}).`,
    };

  if (named.size === 0)
    return { kind: "no-match", reason: "service-not-named", detail: `The message doesn't name a service. Waiting on: ${fresh.map((p) => p.service).join(", ")}.` };

  const matching = fresh.filter((p) => named.has(p.service));
  if (matching.length === 0)
    return {
      kind: "no-match",
      reason: "service-mismatch",
      detail: `The message names ${namedList}, but the agent is waiting on ${fresh.map((p) => p.service).join(", ")}.`,
    };

  const otherOpenNamed = open.filter((p) => named.has(p.service) && p.service !== matching[0].service);
  if (otherOpenNamed.length > 0 || new Set(matching.map((p) => p.service)).size > 1)
    return { kind: "no-match", reason: "ambiguous-service", detail: `The message names more than one service the agent is waiting on (${namedList}).` };

  if (!code) return { kind: "no-match", reason: "ambiguous-service", detail: "The message contains more than one possible code." };

  // The newest open verification for that service is the one this code answers.
  const newest = [...matching].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt))[0];
  return { kind: "match", pending: newest };
}

export function makeAlert(
  message: VoiceInbound,
  reason: AlertReason,
  detail: string,
  now: Date,
  flags?: readonly string[],
): SecurityAlert {
  return {
    id: `alert-${randomUUID().slice(0, 8)}`,
    at: now.toISOString(),
    reason,
    detail: redactCodes(detail),
    messageId: message.messageId,
    threadId: message.threadId,
    counterparty: message.counterparty,
    redactedText: redactCodes(message.text),
    ...(flags && flags.length > 0 ? { flags } : {}),
    acknowledged: false,
  };
}
