import type { RelistSighting, TrackerDocument } from "../types";
import { logActivity } from "../state";
import { findContact, normalizeContactName } from "./contact-check";

/**
 * LEARNING loop #2 — relist detection (v3 plan §6.2, Phase 4).
 *
 * When the same seller reappears with a similar item after a prior hunt
 * interaction, that's an urgency signal: the relist count feeds
 * suggestOpener's −5pp adjustment (≥3 relists) and the opener copy can
 * reference the leverage ("I saw this get relisted a few times — happy
 * to take it off your hands today at …").
 *
 * Signature matching (documented, deliberately simple): the item
 * description is normalized to a sorted keyword set (lowercase, alphanumerics
 * only, stopwords dropped). Two items are "similar" when the Jaccard
 * similarity of their keyword sets is ≥ 0.5 — catches "Sony WH-1000XM4
 * headphones beige" vs "Beige Sony WH1000XM4 headset" without an embedding
 * model. Sightings live in learning.relistSightings, keyed by contact id
 * (or "name:<normalized>" when the seller isn't in the contacts store).
 */

const STOPWORDS = new Set([
  "a", "an", "the", "for", "of", "in", "on", "and", "or", "with", "to",
  "is", "are", "it", "its", "by", "at", "from", "this", "that", "brand",
  "new", "used", "like", "great", "nice", "sale", "selling",
]);

/** Minimum Jaccard similarity for two item descriptions to count as a relist. */
export const RELIST_SIMILARITY_THRESHOLD = 0.5;

/** Normalize an item description to a sorted keyword signature. */
export function normalizeSignature(item: string): string {
  // Split on whitespace only, then strip non-alphanumerics INSIDE each
  // token: "WH-1000XM4" and "WH1000XM4" normalize to the same token, which
  // is exactly the relist paraphrase we want to catch.
  const tokens = item
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  return [...new Set(tokens)].sort().join(" ");
}

/** Jaccard similarity between two keyword signatures (0–1). */
export function signatureSimilarity(a: string, b: string): number {
  const setA = new Set(a.split(" ").filter(Boolean));
  const setB = new Set(b.split(" ").filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let overlap = 0;
  for (const t of setA) if (setB.has(t)) overlap++;
  return overlap / (setA.size + setB.size - overlap);
}

function sightingKey(doc: TrackerDocument, sellerKey: string): { key: string; displayName: string } {
  const found = findContact(doc, { profileId: sellerKey }) ?? findContact(doc, { name: sellerKey });
  if (found) return { key: found.id, displayName: found.record.name ?? found.id };
  const normalized = normalizeContactName(sellerKey);
  return { key: `name:${normalized}`, displayName: sellerKey };
}

export interface RelistResult {
  readonly doc: TrackerDocument;
  /** Total sightings for this seller+item signature INCLUDING this one. */
  readonly relistCount: number;
  /** True when a prior sighting matched (i.e. this is a genuine relist). */
  readonly matched: boolean;
  readonly sightingKey: string;
}

/**
 * Record that this seller was seen with this item. Returns the relist
 * count for the opener logic (1 = first sighting). On a genuine relist
 * (count ≥ 2) an activity line carries the leverage note.
 */
export function detectRelist(
  doc: TrackerDocument,
  sellerKey: string,
  itemName: string,
  nowIso: string,
): RelistResult {
  const { key, displayName } = sightingKey(doc, sellerKey);
  const signature = normalizeSignature(itemName);
  const prior: readonly RelistSighting[] = doc.learning.relistSightings?.[key] ?? [];
  const matching = prior.filter((s) => signatureSimilarity(s.signature, signature) >= RELIST_SIMILARITY_THRESHOLD);
  const sighting: RelistSighting = { signature, itemName, at: nowIso };
  const sightings = [...prior, sighting];
  let next: TrackerDocument = {
    ...doc,
    learning: {
      ...doc.learning,
      relistSightings: { ...(doc.learning.relistSightings ?? {}), [key]: sightings },
    },
    updatedAt: nowIso,
  };
  const relistCount = matching.length + 1;
  if (matching.length > 0) {
    next = logActivity(
      next,
      "hunt",
      `Relist detected: ${displayName} relisted ${relistCount}x — urgency signal ("${itemName}").`,
      nowIso,
    );
  }
  return { doc: next, relistCount, matched: matching.length > 0, sightingKey: key };
}
