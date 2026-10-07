import type { VoiceEmailInput, VoiceInbound } from "./types";

/**
 * Turns a Google Voice notification email into a VoiceInbound, or returns
 * undefined for anything else.
 *
 * This parses emails Google writes for people, not a documented format,
 * the same caveat as alert-mail.ts (ADR 0013). It is deliberately strict:
 * the sender must be Google Voice and the subject must say "New text
 * message from …" or "New voicemail from …". Anything else, including a
 * missed-call notice or a redesigned email, is ignored rather than guessed
 * at, so a format change fails closed.
 */

const VOICE_SENDER = /(^|[<\s])(voice-noreply@google\.com|[^@\s<>]+@txt\.voice\.google\.com)>?$/i;
const SUBJECT = /^new (text message|voicemail) from (.+?)\s*$/i;

/** Google's footer starts at one of these lines; everything from there on is dropped. */
const FOOTER_MARKERS = [
  /^to respond to this (text )?message/i,
  /^your account\b/i,
  /^help center\b/i,
  /^play message\b/i,
  /^google llc\b/i,
  /^you are receiving this email because/i,
];

/**
 * Google's own chrome at the top of the body ("<https://voice.google.com>").
 * It is not part of the message, and leaving it in makes every real email
 * read as naming the "google" service, which poisons code matching.
 */
const CHROME_HEADER_LINE = /^<https?:\/\/[^\s<>]+>\s*$/i;

function stripChromeHeader(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (start < lines.length && (lines[start].trim() === "" || CHROME_HEADER_LINE.test(lines[start].trim()))) start += 1;
  return lines.slice(start).join("\n");
}

function senderAddress(from: string): string {
  const angle = from.match(/<([^>]+)>/);
  return (angle ? angle[1] : from).trim();
}

/** Google puts a bare link to voice.google.com above the message; it is chrome, not message text. */
const CHROME_HEADER_LINE = /^<https?:\/\/[^\s<>]+>\s*$/i;

function stripChromeHeader(body: string): string {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let start = 0;
  while (start < lines.length && (lines[start].trim() === "" || CHROME_HEADER_LINE.test(lines[start].trim()))) start += 1;
  return lines.slice(start).join("\n");
}

function stripFooter(body: string): string {
  const kept: string[] = [];
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    if (FOOTER_MARKERS.some((marker) => marker.test(line.trim()))) break;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

export function parseVoiceEmail(email: VoiceEmailInput): VoiceInbound | undefined {
  if (!VOICE_SENDER.test(senderAddress(email.from))) return undefined;
  const subject = email.subject.trim().match(SUBJECT);
  if (!subject) return undefined;
  const kind = subject[1].toLowerCase() === "voicemail" ? "voicemail" : "text";
  const text = stripChromeHeader(stripFooter(email.body));
  if (text.length === 0) return undefined;
  const replyAddress = kind === "text" ? senderAddress(email.replyTo ?? email.from) : undefined;
  return {
    kind,
    messageId: email.id,
    threadId: email.threadId,
    counterparty: subject[2],
    ...(replyAddress ? { replyAddress } : {}),
    text,
    receivedAt: email.receivedAt,
  };
}

/** Validates the JSON the agent hands over, with a clear error for a missing field. */
export function toVoiceEmailInput(value: unknown): VoiceEmailInput {
  if (typeof value !== "object" || value === null) throw new Error("message must be a JSON object");
  const v = value as Record<string, unknown>;
  for (const field of ["id", "threadId", "from", "subject", "body", "receivedAt"] as const) {
    if (typeof v[field] !== "string" || (v[field] as string).length === 0) throw new Error(`message.${field} must be a non-empty string`);
  }
  if (Number.isNaN(Date.parse(v.receivedAt as string))) throw new Error("message.receivedAt must be an ISO timestamp");
  if (v.replyTo !== undefined && typeof v.replyTo !== "string") throw new Error("message.replyTo must be a string when present");
  return {
    id: v.id as string,
    threadId: v.threadId as string,
    from: v.from as string,
    ...(typeof v.replyTo === "string" ? { replyTo: v.replyTo } : {}),
    subject: v.subject as string,
    body: v.body as string,
    receivedAt: v.receivedAt as string,
  };
}
