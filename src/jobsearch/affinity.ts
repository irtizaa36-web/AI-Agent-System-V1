import type { JobRecord } from "./records";

/**
 * Applied-history revealed preferences (2026-09-28).
 *
 * The supervised LinkedIn pull also extracts her full applied-jobs history
 * (title/company/location/date applied/status). That history is
 * revealed-preference data: it outranks stated preferences for calibration,
 * but it never overrides the frozen config cutoffs ($120k floor, 3–6 yrs,
 * geos, cutoff 65) — it only nudges the composite score of roles that look
 * like the ones she actually applies to.
 *
 * Everything here is deterministic — token counts and a capped bonus, no
 * model calls, no external signals. Her data only. The bonus is applied in
 * score.ts and recorded in the scoring rationale, so it's auditable: any
 * reviewer can see exactly how many points came from affinity and why.
 *
 * A missing or empty history means no affinity signal: every function below
 * degrades to a zero bonus, and the run behaves exactly as if this module
 * didn't exist.
 */

/** One applied job from the LinkedIn pull's `appliedHistory` array. */
export interface AppliedHistoryEntry {
  readonly title: string;
  readonly company: string;
  readonly location: string;
  readonly dateApplied: string | null;
  readonly status: string | null;
}

/**
 * The deterministic affinity model: how often each title token and each
 * company appears in her applied history. Plain records, so they serialize
 * cleanly if anyone wants to snapshot one.
 */
export interface AffinityModel {
  readonly entryCount: number;
  readonly titleTokens: Readonly<Record<string, number>>;
  readonly companies: Readonly<Record<string, number>>;
}

/** The affinity bonus never exceeds this many composite points. */
export const AFFINITY_MAX_BONUS = 5;

/** Title-token bonus is capped separately so one keyword-stuffed title can't eat the whole budget. */
const TITLE_TOKEN_BONUS_CAP = 3;
/** Re-applying somewhere she already applied is a stronger signal than a shared keyword. */
const COMPANY_MATCH_BONUS = 2;

const TITLE_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "to", "in", "at", "on", "with",
  "by", "as", "is", "are", "i", "ii", "iii", "iv", "v", "jr", "sr",
]);

/**
 * Title tokens: lowercase alphanumeric words, stopwords dropped. Seniority
 * words (senior, lead, staff, principal) are deliberately kept — they carry
 * level signal she reveals by applying.
 */
export function titleTokens(title: string): readonly string[] {
  const tokens = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !TITLE_STOPWORDS.has(token));
  return [...new Set(tokens)];
}

/** Company names compared case-insensitively, punctuation-normalized. */
export function normalizeCompany(company: string): string {
  return company.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * Validates the pull file's `appliedHistory` array. Entries missing a title
 * or company are skipped individually — a sloppy pull never voids the
 * history. Anything not an array (absent, null, wrong shape) means no
 * affinity signal: returns [].
 */
export function parseAppliedHistory(data: unknown): readonly AppliedHistoryEntry[] {
  if (!Array.isArray(data)) return [];
  const entries: AppliedHistoryEntry[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const title = typeof entry["title"] === "string" ? entry["title"].trim() : "";
    const company = typeof entry["company"] === "string" ? entry["company"].trim() : "";
    if (!title || !company) continue;
    const location = typeof entry["location"] === "string" ? entry["location"].trim() : "";
    const rawDate = typeof entry["dateApplied"] === "string" ? entry["dateApplied"] : null;
    const dateApplied = rawDate !== null && !Number.isNaN(new Date(rawDate).getTime()) ? rawDate : null;
    const status = typeof entry["status"] === "string" && entry["status"].trim() ? entry["status"].trim() : null;
    entries.push({ title, company, location, dateApplied, status });
  }
  return entries;
}

/**
 * The seed revealed-preference set — her five real applied jobs from the
 * 2026-09-28 read-only LinkedIn snapshot, verbatim (titles/companies as
 * extracted; applied dates were relative ("2 weeks ago" etc.) so no exact
 * dateApplied is recorded rather than inventing one):
 *
 *   Field Marketing Manager — Eon.io (Dallas TX Remote)
 *   Senior Marketing Events Manager — GoFundMe (US Remote)
 *   Performance Marketing Specialist — Bloom Nutrition (Austin TX Hybrid)
 *   Sr. Manager, Marketplaces (Walmart) — Dyson (New York NY On-site)
 *   Client Partner, Strategic New Business — LTK (New York NY Remote)
 *
 * The skew it captures is the snapshot's own finding: marketing/events
 * titles, remote/hybrid leaning, Dallas/Austin/NYC.
 *
 * Small sample (n=5), so influence is bounded: the seed is included by
 * default, pass `[]` to build from pull history alone, and the per-record
 * bonus caps (title +3, company +2, total +5) bound what any single seed
 * entry can contribute. As the pull file's appliedHistory grows, it
 * dominates the seed naturally — seed entries that reappear in the pull are
 * deduped, never double-counted.
 */
export const SEED_APPLIED_HISTORY: readonly AppliedHistoryEntry[] = [
  { title: "Field Marketing Manager", company: "Eon.io", location: "Dallas TX (Remote)", dateApplied: null, status: "Applied" },
  { title: "Senior Marketing Events Manager", company: "GoFundMe", location: "US (Remote)", dateApplied: null, status: "Applied" },
  { title: "Performance Marketing Specialist", company: "Bloom Nutrition", location: "Austin TX (Hybrid)", dateApplied: null, status: "Applied" },
  { title: "Sr. Manager, Marketplaces (Walmart)", company: "Dyson", location: "New York NY (On-site)", dateApplied: null, status: "Applied" },
  { title: "Client Partner, Strategic New Business", company: "LTK", location: "New York NY (Remote)", dateApplied: null, status: "Applied" },
];

/**
 * Counts title tokens and companies across her applied history, seeded with
 * SEED_APPLIED_HISTORY unless overridden. Pull history takes precedence in
 * dedupe order: an entry whose normalized company+title already appears in
 * the pull keeps the pull's fuller record, so the snapshot's five never
 * double-count as the real history grows.
 */
export function buildAffinity(
  history: readonly AppliedHistoryEntry[],
  seed: readonly AppliedHistoryEntry[] = SEED_APPLIED_HISTORY,
): AffinityModel {
  const seen = new Set<string>();
  const combined: AppliedHistoryEntry[] = [];
  for (const entry of [...history, ...seed]) {
    const key = `${normalizeCompany(entry.company)}|${entry.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    combined.push(entry);
  }

  const tokenCounts: Record<string, number> = {};
  const companies: Record<string, number> = {};
  for (const entry of combined) {
    for (const token of titleTokens(entry.title)) {
      tokenCounts[token] = (tokenCounts[token] ?? 0) + 1;
    }
    const company = normalizeCompany(entry.company);
    if (company) companies[company] = (companies[company] ?? 0) + 1;
  }
  return { entryCount: combined.length, titleTokens: tokenCounts, companies };
}

export interface AffinityBonus {
  readonly points: number;
  readonly reasons: readonly string[];
}

/**
 * The capped affinity bonus for one scored record. +1 per title token she
 * has applied under (cap 3), +2 when the company is one she applied to
 * before, hard-capped at AFFINITY_MAX_BONUS total. A null or empty model —
 * no pull file, no history — is a zero bonus with no reasons.
 */
export function affinityBonus(record: JobRecord, model: AffinityModel | null): AffinityBonus {
  if (!model || model.entryCount === 0) return { points: 0, reasons: [] };

  const reasons: string[] = [];
  let points = 0;

  const matchedTokens = titleTokens(record.title).filter((token) => (model.titleTokens[token] ?? 0) > 0);
  if (matchedTokens.length > 0) {
    const tokenPoints = Math.min(matchedTokens.length, TITLE_TOKEN_BONUS_CAP);
    points += tokenPoints;
    const counts = matchedTokens.map((token) => `${token} (${model.titleTokens[token]} prior)`);
    reasons.push(`title tokens ${counts.slice(0, 5).join(", ")}${matchedTokens.length > 5 ? ", …" : ""}`);
  }

  const company = normalizeCompany(record.company);
  const companyCount = company ? (model.companies[company] ?? 0) : 0;
  if (companyCount > 0) {
    points += COMPANY_MATCH_BONUS;
    reasons.push(`company ${record.company} applied to ${companyCount}× before`);
  }

  return { points: Math.min(points, AFFINITY_MAX_BONUS), reasons };
}
