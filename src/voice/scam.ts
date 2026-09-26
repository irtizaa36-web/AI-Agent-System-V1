import type { Listing } from "./types";

/**
 * The scam classifier that runs before any reply is drafted (ADR 0023). It
 * is rule-based and leans towards flagging: a false positive costs one
 * alert Toozy dismisses, while a false negative could put a drafted reply
 * in front of a scammer. Any flag means no draft, only an alert.
 */

export type ScamFlag =
  | "verification-code-request"
  | "overpayment-scheme"
  | "paypal-email-phishing"
  | "qr-code"
  | "shipping-only-local";

interface Rule {
  readonly flag: ScamFlag;
  readonly test: (text: string, listing: Listing | undefined) => boolean;
}

const any = (text: string, patterns: readonly RegExp[]) => patterns.some((p) => p.test(text));

const RULES: readonly Rule[] = [
  {
    // The Google Voice / 6-digit code relay: "I just sent you a code, read it back to prove you're real."
    flag: "verification-code-request",
    test: (t) =>
      any(t, [
        /\b(send|give|share|tell|text|forward|read|reply with)\b[^.?!]{0,40}\b(code|pin|digits?)\b/,
        /\b(code|pin)\b[^.?!]{0,40}\b(i|we) (just )?(sent|texted|send)\b/,
        /\b(6|six)[- ]digit\b/,
        /\bgoogle voice code\b/,
        /\bverify (that )?(you|u)('re| are)? ?(real|legit|not a (bot|scam(mer)?))\b/,
        // Code relay that avoids the words code/PIN/digits: "read back the number Google texts you".
        /\b(read|tell|give|share|forward|send)\b[^.?!]{0,30}\bthe (verification |confirmation )?(number|numbers)\b[^.?!]{0,40}\b(texts?|texted|sends?|sent)\b[^.?!]{0,10}\byou\b/,
      ]),
  },
  {
    // Fake Zelle "business upgrade" or pending-payment notices, and paper cheques or money orders for more than the price.
    flag: "overpayment-scheme",
    test: (t) =>
      any(t, [
        /\bcashier'?s? ?che(ck|que)\b/,
        /\bcertified che(ck|que)\b/,
        /\bmoney order\b/,
        /\bzelle\b[^.?!]{0,80}\b(extra|over ?pa(y|id)|more than|refund|send (back|the (rest|difference|balance))|business account|upgrade|pending|limit)\b/,
        /\b(extra|over ?pa(y|id)|more than (the )?(asking|price))\b[^.?!]{0,80}\bzelle\b/,
        /\bover ?pa(y|id|yment)\b/,
        /\b(mover|shipping agent|courier)\b[^.?!]{0,60}\b(pay|fee|money)\b/,
      ]),
  },
  {
    // "What's your email so I can pay through PayPal?" leads to a fake PayPal email.
    flag: "paypal-email-phishing",
    test: (t) =>
      any(t, [
        /\bpaypal\b[^]{0,120}\b(e-?mail|address)\b/,
        /\b(e-?mail|address)\b[^]{0,120}\bpaypal\b/,
        /\b(what'?s|what is|send me|give me) (your|ur) e-?mail\b[^]{0,80}\b(pay|payment|venmo|cash ?app|invoice)\b/,
      ]),
  },
  {
    flag: "qr-code",
    test: (t) => any(t, [/\bqr\b/, /\bscan (this|the|my) (code|image|link)\b/]),
  },
  {
    // A buyer who can't come in person, on a listing that is local pickup only.
    flag: "shipping-only-local",
    test: (t, listing) =>
      listing?.localOnly === true &&
      any(t, [
        /\b(ship|shipping|shipped|mail it|mail (it|this) to)\b/,
        /\b(fedex|ups|usps|dhl|courier)\b/,
        /\b(out of (town|state|the country)|not in (town|the area)|overseas|offshore)\b/,
        /\b(send|have) (my|a) (mover|agent|driver)\b/,
      ]),
  },
];

export function classifyScam(text: string, listing: Listing | undefined): readonly ScamFlag[] {
  const normalized = text.toLowerCase().replace(/[‘’]/g, "'");
  return RULES.filter((rule) => rule.test(normalized, listing)).map((rule) => rule.flag);
}
