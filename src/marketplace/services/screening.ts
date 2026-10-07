import type { ServiceReference, ServiceType } from "../types";

/**
 * SERVICES — two-phase trust protocol, phase (a): screening questions
 * (v3 plan §4). This lane is stricter than buying/selling because price
 * agreement is NOT quality agreement: skill-specific screening questions
 * go out BEFORE any price talk.
 *
 * Question templates are per service subtype. The intake type is coarse
 * ("home" | "cleaning"), so the subtype is detected from the specs text
 * with detectHomeSubtype() — mounting is the default when nothing matches
 * (TV mounting is the canonical home service in plan §4).
 */

export const SCREENING_QUESTIONS: Record<string, readonly string[]> = {
  "home/mounting": [
    "send a photo of a similar mount you've done",
    "do you bring the mount or should I supply it",
  ],
  "home/repair": [
    "are you licensed/insured for this work",
    "what's your warranty",
  ],
  cleaning: [
    "do you bring supplies/products",
    "how do you price — hourly or flat",
  ],
};

const MOUNTING_WORDS = ["mount", "tv", "hang", "install"];
const REPAIR_WORDS = ["repair", "fix", "plumb", "leak", "electric", "handyman", "faucet", "drywall"];

/** Detect the home-service subtype from the request specs (defaults to mounting). */
export function detectHomeSubtype(specs: string): "mounting" | "repair" {
  const hay = specs.toLowerCase();
  if (REPAIR_WORDS.some((w) => hay.includes(w))) return "repair";
  if (MOUNTING_WORDS.some((w) => hay.includes(w))) return "mounting";
  return "mounting";
}

/** Screening questions for a request, in send order. Pure. */
export function screeningQuestions(serviceType: ServiceType, specs: string): readonly string[] {
  if (serviceType === "cleaning") return SCREENING_QUESTIONS["cleaning"];
  return SCREENING_QUESTIONS[`home/${detectHomeSubtype(specs)}`];
}

/**
 * Two-phase trust protocol, phase (b): reference red-flag words (v3 plan
 * §4). When past clients say any of these about a provider — or any
 * reference scores ≤ 2 — the provider is RED: booking is not recommendable
 * until Toozy overrides. Documented list; matched case-insensitively as
 * substrings of the reference notes.
 */
export const REFERENCE_RED_FLAG_WORDS: readonly string[] = [
  "scam",
  "fraud",
  "ghost",
  "no-show",
  "noshow",
  "never showed",
  "unlicensed",
  "damaged",
  "damage",
  "broken",
  "stole",
  "theft",
  "overcharg",
  "flaky",
  "flake",
  "rude",
  "sketchy",
  "late",
];

export interface ReferenceCheck {
  readonly providerName: string;
  readonly count: number;
  /** Mean score, or undefined when no references were recorded. */
  readonly avg?: number;
  /** One line per red flag found. Empty ⇒ clean. */
  readonly redFlags: readonly string[];
  /** True when at least one reference exists and none are red. */
  readonly clean: boolean;
}

/** Summarize reference checks for one provider and flag reds. Pure. */
export function checkReferences(providerName: string, references: readonly ServiceReference[]): ReferenceCheck {
  const ours = references.filter((r) => r.providerId === providerSlug(providerName));
  const redFlags: string[] = [];
  for (const r of ours) {
    if (r.score <= 2) redFlags.push(`low score ${r.score}/5 (recorded ${r.at.slice(0, 10)})`);
    const hay = r.notes.toLowerCase();
    for (const word of REFERENCE_RED_FLAG_WORDS) {
      if (hay.includes(word)) {
        redFlags.push(`flag word "${word}" in reference notes`);
        break;
      }
    }
  }
  const count = ours.length;
  const avg = count === 0 ? undefined : ours.reduce((sum, r) => sum + r.score, 0) / count;
  return { providerName, count, avg, redFlags, clean: count > 0 && redFlags.length === 0 };
}

/** Normalized provider id: shared by quotes, references, and the trust record. */
export function providerSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "provider";
}
