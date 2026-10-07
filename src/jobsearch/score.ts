import type { Confidence, JobRecord, Preferences, ScoreDimensions, ScoreWeights } from "./records";
import { SCORE_DIMENSION_KEYS } from "./records";
import { salaryUnknown } from "./filter";
import { affinityBonus, type AffinityModel } from "./affinity";
import type { CostLedger } from "./cost";
import type { ScoringClient } from "./scoring-client";

/**
 * Stage 8: the only place in the scheduled pipeline where a model is used at
 * all, and the only place one is genuinely needed — judging whether a real
 * posting fits a real person.
 *
 * Three decisions keep this cheap. Postings are scored in batches, so the
 * rubric and profile are sent once per batch rather than once per posting.
 * The system prefix is identical across every batch in a run, so prompt
 * caching bills it at roughly a tenth after the first. And the model writes
 * the two-line rationale in the same call that produces the score, so the
 * digest needs no second, larger model at all.
 */

export interface CandidateProfile {
  /** The resume, already parsed to text once and cached on disk. */
  readonly resume: string;
  /** Anything she has said about what she wants that isn't a mechanical filter. */
  readonly notes: string;
}

export interface ScoredPosting {
  readonly id: string;
  readonly score: number;
  readonly confidence: Confidence;
  readonly rationale: string;
  readonly gaps: readonly string[];
  /**
   * The six per-axis scores beside the composite. Null when the model didn't
   * return a valid full set — the composite is what rank/cut read by
   * default, so a null here changes nothing.
   */
  readonly dimensions: ScoreDimensions | null;
}

const RUBRIC = `You are scoring job postings for one candidate. For each posting, decide how well it fits.

Score 0-100:
  85-100  Strong fit. Title, level, and most requirements line up with real resume content.
  65-84   Good fit worth her time. Some gaps, none disqualifying.
  40-64   Partial fit. Wrong level, adjacent function, or several unmet requirements.
  0-39    Not a fit.

Confidence is about how much the POSTING told you, not how good the match is:
  high    The posting stated responsibilities, requirements, and level clearly.
  medium  Enough to judge, with gaps in what was stated.
  low     Vague, boilerplate-heavy, or too short to judge properly.

Title vs. experience:
- The candidate does NOT need a title from a fixed list. Judge whether the role's actual duties align with the experience on her resume, whatever the title says. A differently-named role that does the same kind of work (program, marketing, vendor/partner, GTM, operations, P&L ownership) is a fit; a role that merely shares a title word but needs a different discipline is not.
- Read the title and description together. Ask: would she plausibly apply to this herself, given what she has actually done?
- The "Target roles" list below is only a hint about roles she has liked before. A title missing from it is not a reason to lower the score, and a title on it is not a reason to raise it.

Rules you must follow:
- Judge only against what the resume actually says. Never assume experience that is not written there.
- "gaps" lists requirements the posting asks for that the resume does not support. Name them plainly. An empty list means the resume genuinely covers the stated requirements.
- If a posting does not state salary, that is unknown, not a negative. Do not speculate about pay.
- The rationale is at most two short sentences, written to her, saying why this is or is not worth her time. No preamble, no restating the job title.
- "dimensions" scores each axis 0-100 independently: title (title/level fit to her target roles), experience (years/level fit), skills (coverage of the stated requirements), location (remote/metro fit to her requirement), salary (stated pay against her floor — when pay is not stated, score 50: unknown, neither good nor bad), recency (how fresh the posting is, from the posted/firstSeen dates given). The composite "score" remains your own overall judgment, as before.

Return ONLY a JSON array, no prose and no code fences, shaped exactly:
[{"id":"<the id given>","score":<0-100>,"confidence":"low|medium|high","rationale":"<=2 sentences","gaps":["..."],"dimensions":{"title":<0-100>,"experience":<0-100>,"skills":<0-100>,"location":<0-100>,"salary":<0-100>,"recency":<0-100>}}]
Return one object for every posting you were given, in the same order.`;

/**
 * The cached prefix. Everything that is identical for every batch in a run
 * lives here; everything that varies lives in the user turn. Keeping that
 * split clean is what makes the cache actually hit — a single varying
 * character in here would invalidate it on every call.
 */
export function buildSystemPrompt(profile: CandidateProfile, prefs: Preferences): string {
  const targets = prefs.titles.length > 0 ? `${prefs.titles.join(", ")} (examples only, not a required list)` : "(not yet configured — judge on the resume alone)";
  const floor = prefs.salaryFloor === null ? "(not set)" : `${prefs.salaryFloor.toLocaleString()} ${prefs.salaryCurrency}`;

  return `${RUBRIC}

## Target roles
${targets}

## Location requirement
${prefs.remoteOnly ? "Remote roles only." : "Remote or onsite."}${prefs.metros.length > 0 ? ` Onsite acceptable in: ${prefs.metros.join(", ")}.` : ""}${prefs.usRemoteOnly ? " Remote seat must be based in the US." : ""}

## Compensation floor
${floor}

## Her notes
${profile.notes || "(none provided)"}

## Her resume
${profile.resume}`;
}

/** The varying half: just the postings, trimmed. */
export function buildBatchPrompt(batch: readonly JobRecord[]): string {
  const postings = batch.map((record) => ({
    id: record.id,
    title: record.title,
    company: record.company,
    location: record.rawLocation || "(not stated)",
    remote: record.locationClass,
    salary: salaryUnknown(record)
      ? "not stated"
      : `${record.salaryMin?.toLocaleString() ?? "?"}-${record.salaryMax?.toLocaleString() ?? "?"} ${record.salaryCurrency ?? ""}`.trim(),
    posted: record.postedAt ?? "(not stated)",
    firstSeen: record.firstSeenAt,
    description: record.summary,
  }));

  return `Score these ${batch.length} postings.\n\n${JSON.stringify(postings, null, 1)}`;
}

export interface ScoringParseResult {
  readonly entries: readonly ScoredPosting[];
  /** Malformed entries that were skipped, named by index — they join the digest's failure list rather than voiding the batch. */
  readonly failures: readonly string[];
}

/**
 * Parses the model's reply. Deliberately strict about the shape and
 * deliberately forgiving about the wrapper: a model that wraps valid JSON in
 * a code fence has not actually failed, but one that invents a score of 120
 * or drops the id has, and that must not pass silently into the digest.
 *
 * One malformed entry no longer voids the whole batch: each entry is parsed
 * in its own try/catch, the bad one is skipped and named in `failures`, and
 * the rest parse on. The batch-level throw stays for transport-shaped
 * failures (not a JSON array at all), where nothing is salvageable.
 */
export function parseScoringResponse(text: string): ScoringParseResult {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`scoring response was not a JSON array: ${cleaned.slice(0, 200)}`);
  }

  const parsed: unknown = JSON.parse(cleaned.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("scoring response did not parse to an array");

  const entries: ScoredPosting[] = [];
  const failures: string[] = [];
  parsed.forEach((entry, index) => {
    try {
      entries.push(parseScoringEntry(entry, index));
    } catch (error) {
      failures.push(`scoring entry ${index}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { entries, failures };
}

function parseScoringEntry(entry: unknown, index: number): ScoredPosting {
  const item = entry as Record<string, unknown>;
  const id = typeof item["id"] === "string" ? item["id"] : null;
  if (!id) throw new Error(`scoring entry ${index} has no id`);

  const rawScore = Number(item["score"]);
  if (!Number.isFinite(rawScore)) throw new Error(`scoring entry ${id} has a non-numeric score`);

  const confidence = item["confidence"];
  const gaps = Array.isArray(item["gaps"]) ? item["gaps"].filter((gap): gap is string => typeof gap === "string") : [];

  return {
    id,
    score: Math.max(0, Math.min(100, Math.round(rawScore))),
    confidence: confidence === "high" || confidence === "medium" || confidence === "low" ? confidence : "low",
    rationale: typeof item["rationale"] === "string" ? item["rationale"].trim() : "",
    gaps,
    dimensions: parseScoreDimensions(item["dimensions"]),
  };
}

/**
 * Parses the six per-axis scores. All-or-nothing on purpose: a partial set
 * would mislead re-weighting, so anything short of six finite 0-100 numbers
 * stores null and the composite rules alone — the entry itself is never
 * failed for bad dimensions (same isolation rule as every other field).
 */
export function parseScoreDimensions(value: unknown): ScoreDimensions | null {
  if (typeof value !== "object" || value === null) return null;
  const obj = value as Record<string, unknown>;
  const dims = {} as Record<keyof ScoreDimensions, number>;
  for (const key of SCORE_DIMENSION_KEYS) {
    const raw = Number(obj[key]);
    if (!Number.isFinite(raw)) return null;
    dims[key] = Math.max(0, Math.min(100, Math.round(raw)));
  }
  return dims;
}

/**
 * The score rank/cut actually read (Stage 12). Default (no `scoreWeights`,
 * or no stored dimensions): the model's composite, exactly as before —
 * cut/rank behavior is identical until a human re-weights. With weights set
 * and dimensions present: the normalized weighted average, rounded.
 */
export function effectiveScore(record: JobRecord, prefs: Preferences): number {
  const weights: ScoreWeights | null = prefs.scoreWeights;
  const dims = record.scoreDimensions;
  if (!weights || !dims) return record.score ?? 0;
  let weighted = 0;
  let total = 0;
  for (const key of SCORE_DIMENSION_KEYS) {
    const weight = weights[key];
    if (!Number.isFinite(weight) || weight < 0) continue;
    weighted += weight * dims[key];
    total += weight;
  }
  if (total <= 0) return record.score ?? 0;
  return Math.round(weighted / total);
}

export function chunk<T>(items: readonly T[], size: number): readonly (readonly T[])[] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export interface ScoreRunResult {
  readonly scored: readonly JobRecord[];
  /** Batches the model failed on. Their postings stay unscored and are retried next run rather than silently dropped. */
  readonly failures: readonly string[];
}

/**
 * Scores every filtered posting, batch by batch, applying the result back
 * onto the records. A batch that fails does not fail the run: those postings
 * keep their `seen` state and come back around next run, which is the
 * difference between losing a morning's discoveries and losing nothing.
 */
export async function scoreRecords(
  records: readonly JobRecord[],
  profile: CandidateProfile,
  prefs: Preferences,
  client: ScoringClient,
  ledger: CostLedger,
  /**
   * Her applied-history affinity model (affinity.ts), or null when the
   * LinkedIn pull carried no applied history. Optional so existing callers
   * keep working — absent means no bonus, exactly the pre-affinity behavior.
   */
  affinity?: AffinityModel | null,
): Promise<ScoreRunResult> {
  if (records.length === 0) return { scored: [], failures: [] };

  const system = buildSystemPrompt(profile, prefs);
  const scored: JobRecord[] = [];
  const failures: string[] = [];

  for (const batch of chunk(records, prefs.scoringBatchSize)) {
    try {
      const result = await client.complete({
        model: prefs.scoringModel,
        system,
        user: buildBatchPrompt(batch),
        // ~260 tokens of JSON per posting with the six dimensions, with headroom.
        maxTokens: Math.max(1024, batch.length * 300),
      });
      await ledger.record("score", prefs.scoringModel, result.usage);

      const parseResult = parseScoringResponse(result.text);
      // Malformed entries are skipped individually, never voiding the batch —
      // each one is named so it lands in the digest's failure list.
      for (const failure of parseResult.failures) {
        failures.push(failure);
      }
      const byId = new Map(parseResult.entries.map((entry) => [entry.id, entry]));
      for (const record of batch) {
        const judgement = byId.get(record.id);
        if (!judgement) {
          failures.push(`${record.company} — ${record.title}: model returned no score`);
          continue;
        }
        const scoredRecord: JobRecord = {
          ...record,
          score: judgement.score,
          confidence: judgement.confidence,
          rationale: judgement.rationale,
          gaps: judgement.gaps,
          scoreDimensions: judgement.dimensions,
        };
        // Applied-history affinity: a capped, deterministic bonus on the
        // composite, recorded in the rationale so it's auditable. Frozen
        // cutoffs are untouched — the bonus only nudges roles that look
        // like the ones she actually applies to.
        const bonus = affinityBonus(scoredRecord, affinity ?? null);
        const finalScore = Math.min(100, (scoredRecord.score ?? 0) + bonus.points);
        const rationale = bonus.points > 0
          ? `${scoredRecord.rationale ?? ""} [affinity +${bonus.points}: ${bonus.reasons.join("; ")}]`.trim()
          : scoredRecord.rationale;
        const withAffinity: JobRecord = { ...scoredRecord, score: finalScore, rationale };
        scored.push({
          ...withAffinity,
          state: effectiveScore(withAffinity, prefs) >= prefs.scoreCutoff ? "shortlisted" : "scored",
        });
      }
    } catch (error) {
      failures.push(`batch of ${batch.length}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { scored, failures };
}
