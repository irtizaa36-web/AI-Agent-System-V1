/**
 * Which routine questions a buyer's text asks. Only three are routine:
 * whether the item is available, what the price is, and when pickup can
 * happen. Anything else (a counter-offer, a question about condition, a
 * long message) is "needs Toozy": the drafter writes nothing, because a
 * wrong answer there is a promise Toozy didn't make.
 */

export type RoutineIntent = "availability" | "price" | "pickup";

export interface IntentReading {
  readonly routine: readonly RoutineIntent[];
  /** Why this can't be answered from a template; empty when it can. */
  readonly needsToozy: readonly string[];
}

const ROUTINE: Readonly<Record<RoutineIntent, readonly RegExp[]>> = {
  availability: [/\bavailable\b/, /\bavail\b/, /\bstill (have|got|for sale|selling)\b/, /\b(is|it'?s) (it|this) (still )?for sale\b/, /\bsold( yet)?\b/],
  price: [/\bhow much\b/, /\bwhat'?s? (is )?the price\b/, /\basking\b/, /\bprice\??$/m, /\bcost\b/],
  pickup: [/\bpick ?up\b/, /\bwhen can i (come|get|grab)\b/, /\b(come|swing|stop) by\b/, /\bwhere (are you|is it|can i|do i)\b/, /\bmeet\b/, /\bwhen (are|r) (you|u) (free|available)\b/, /\bwhat time\b/],
};

const NEEDS_TOOZY: readonly (readonly [string, RegExp])[] = [
  ["counter-offer or negotiation", /\b(would|will|could) (you|u) (take|do|accept)\b|\blowest\b|\bbest price\b|\bobo\b|\bnegotiable\b|\b(my )?offer\b|\bdiscount\b|\bdeal\b/],
  ["question about the item itself", /\b(condition|working|does it (still )?works?|it works|still works?|scratch(es)?|damage[ds]?|dent|stain|smell|dimensions?|measure(ments)?|size|model|year|warranty|receipt|original|box|battery|mileage|miles|pet|smok(e|ing|er))\b/],
  ["hold or reservation request", /\b(hold|reserve|save) (it|this)\b/],
  ["delivery request", /\b(deliver|delivery|drop (it )?off|bring it)\b/],
];

export function readIntents(text: string): IntentReading {
  const t = text.toLowerCase().replace(/[‘’]/g, "'");
  const routine = (Object.keys(ROUTINE) as RoutineIntent[]).filter((intent) => ROUTINE[intent].some((p) => p.test(t)));
  const needsToozy = NEEDS_TOOZY.filter(([, pattern]) => pattern.test(t)).map(([reason]) => reason);
  if (text.length > 320) needsToozy.push("long message");
  if (routine.length === 0 && needsToozy.length === 0) needsToozy.push("not one of the routine questions (availability, price, pickup)");
  return { routine, needsToozy };
}
