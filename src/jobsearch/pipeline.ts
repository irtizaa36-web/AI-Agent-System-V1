import { createHash, randomUUID } from "node:crypto";
import type { JobRecord, Preferences } from "./records";
import type { Source } from "./sources/source";
import { jitter, mapWithConcurrency } from "./sources/source";
import { toJobRecord } from "./normalize";
import { dedupe } from "./dedupe";
import { applyFilters, summarizeRejections } from "./filter";
import { sortByRank } from "./rank";
import { effectiveScore } from "./score";
import type { AffinityModel } from "./affinity";
import { scoreRecords, type CandidateProfile } from "./score";
import type { ScoringClient } from "./scoring-client";
import { CostLedger } from "./cost";
import { degraded, healthy, type SourceHealth } from "./health";
import type { RunSummary } from "./digest";
import { writeRejectionsLog } from "./digest";
import { appendLivenessReviewQueue, checkLiveness, type LivenessFetcher } from "./liveness";
import type { JobStore } from "../store/job-store";
import { dirname, join } from "node:path";

/**
 * The pipeline. One function, ten stages, in the order the plan set out.
 *
 * Two properties are load-bearing and worth stating plainly:
 *
 * It is idempotent. Running it twice in a row costs almost nothing the second
 * time, because every posting is hashed and anything already seen is dropped
 * before a single token is spent. That is what makes a scheduled run safe to
 * re-execute, and what makes "did the 8am run work?" a cheap question.
 *
 * It degrades rather than dies. A source that 404s, a batch the model fails
 * on, a board that changes its markup — each is recorded and reported in the
 * digest, and the rest of the run completes. The failure mode this is built
 * to avoid is the silent one: a pipeline that stops finding jobs and does not
 * mention it.
 */

export interface PipelineDeps {
  readonly sources: readonly Source[];
  readonly store: JobStore;
  readonly prefs: Preferences;
  readonly profile: CandidateProfile;
  /**
   * Her applied-history affinity model (affinity.ts), built by the caller
   * from the LinkedIn pull file. Null/absent means no affinity signal —
   * scoring behaves exactly as before.
   */
  readonly affinityModel?: AffinityModel | null;
  /**
   * Absent means scoring is skipped this run — the run still fetches,
   * dedupes and filters. `scoringUnavailableReason` says why, so the
   * digest's failure message names the real cause rather than assuming it
   * was always a missing API key (it might instead be a missing resume —
   * see MissingProfileError in config.ts, and CLAUDE.md's own reminder that
   * a wrong-but-plausible message is worse than no message: it sends
   * whoever reads it chasing the wrong fix).
   */
  readonly scoringClient?: ScoringClient;
  /** Short clause completing "...not scored: {reason}." Defaults to the API-key case for callers that don't pass one. */
  readonly scoringUnavailableReason?: string;
  readonly costLogPath: string;
  /**
   * Where the run's rejected records are written (one JSONL line each, id +
   * title + company + bucketed reason) so filter tuning can see *which*
   * roles a check killed. Defaults to `rejections-<date>.jsonl` next to the
   * cost log. Write-only side effect after the pipeline decision is made.
   */
  readonly rejectionsLogPath?: string;
  /** How many sources to fetch at once. Deliberately small — politeness, not throughput. */
  readonly concurrency?: number;
  /** Off in tests, on in real runs. */
  readonly politeDelay?: boolean;
  /**
   * Pre-digest liveness validation (Stage 13). When provided, every
   * shortlisted posting's apply URL is checked: confirmed-dead roles are
   * excluded from the digest (counted, never silently dropped); ambiguous
   * ones stay in AND are appended to the human review queue. Absent = the
   * stage is skipped (tests, offline runs). The CLI passes the real fetcher.
   */
  readonly livenessFetcher?: LivenessFetcher;
  /**
   * Where ambiguous liveness cases are appended for human-paced spot-checks.
   * Defaults to `liveness-review-queue.jsonl` next to the cost log. Appends
   * only; never rewrites history.
   */
  readonly livenessQueuePath?: string;
}

/**
 * Bumped whenever the deterministic title logic changes, so records filtered
 * under an older rule are re-evaluated. v2: the title-cluster hard gate was
 * removed; title/experience fit is judged during scoring instead. `titles` is
 * no longer part of the hash because it no longer affects filtering.
 */
const TITLE_GATE_VERSION = "experience-alignment-v2";

export async function runPipeline(deps: PipelineDeps): Promise<RunSummary> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const ledger = new CostLedger(runId, deps.costLogPath);
  const health: SourceHealth[] = [];
  const filterVersion = createHash("sha1")
    .update(JSON.stringify({ titleExclusions: deps.prefs.titleExclusions, titleGate: TITLE_GATE_VERSION }))
    .digest("hex");

  // Stages 1-2 — fetch, with per-source health and no source able to fail the run.
  const fetched = await mapWithConcurrency(deps.sources, deps.concurrency ?? 4, async (source) => {
    if (deps.politeDelay !== false) await jitter();
    const checkedAt = new Date().toISOString();
    try {
      const postings = await source.fetch();
      health.push(healthy(source.id, postings.length, checkedAt));
      return postings;
    } catch (error) {
      health.push(degraded(source.id, error, checkedAt));
      return [];
    }
  });

  const rawPostings = fetched.flat();
  const now = new Date().toISOString();

  // Stage 3 — normalize. The raw body goes to disk; only the trimmed summary
  // travels onward, so no prompt ever carries a page of HTML.
  const normalized: JobRecord[] = [];
  for (const raw of rawPostings) {
    const provisional = toJobRecord(raw, { descriptionPath: "", tokenBudget: deps.prefs.postingTokenBudget, now });
    const descriptionPath = await deps.store.saveRawBody(provisional.contentHash, raw.body);
    normalized.push({ ...provisional, descriptionPath });
  }

  // Stages 4-5 — the delta. Everything already known is dropped here, before
  // anything expensive happens.
  const known = await deps.store.listJobs();
  const { fresh, merged, duplicateCount } = dedupe(normalized, known, filterVersion);

  // Stage 6 — the free filters. One `now` shared across the whole batch, so
  // recency comparisons are consistent within a single run.
  const passed: JobRecord[] = [];
  const rejected: JobRecord[] = [];
  const filterNow = new Date(now);
  const maxAgeBySource = new Map<string, number>();
  for (const source of deps.sources) {
    if (source.maxAgeDays !== undefined) maxAgeBySource.set(source.id, source.maxAgeDays);
  }
  for (const record of fresh) {
    const entryMaxAgeDays = record.sources.length > 0 ? maxAgeBySource.get(record.sources[0].sourceId) : undefined;
    const outcome = applyFilters(record, deps.prefs, filterNow, entryMaxAgeDays);
    if (outcome.passed) {
      passed.push(record);
    } else {
      rejected.push({ ...record, state: "filtered", filterReason: outcome.reason, filterVersion });
    }
  }

  // The rejections log is written after the pipeline decision is made: the
  // records are already rejected, so the log can never change what the run
  // does — it just makes the next tuning session non-blind.
  await writeRejectionsLog(
    rejected,
    deps.rejectionsLogPath ?? join(dirname(deps.costLogPath), `rejections-${now.slice(0, 10)}.jsonl`),
  );

  // Stage 8 — the only model call. Skipped entirely with no client configured.
  let scored: readonly JobRecord[] = [];
  let failures: readonly string[] = [];
  if (deps.scoringClient && passed.length > 0) {
    const result = await scoreRecords(passed, deps.profile, deps.prefs, deps.scoringClient, ledger, deps.affinityModel ?? null);
    scored = result.scored;
    failures = result.failures;
  } else if (passed.length > 0) {
    const reason = deps.scoringUnavailableReason ?? "no ANTHROPIC_API_KEY configured";
    failures = [
      `${passed.length} posting(s) fetched and filtered but not scored: ${reason}. They are saved and will be scored on the next run once this is resolved.`,
    ];
  }

  // Anything the model did not get to keeps its `seen` state on purpose, so
  // the next run picks it up instead of losing it.
  const scoredIds = new Set(scored.map((record) => record.id));
  const unscored = passed.filter((record) => !scoredIds.has(record.id));

  await deps.store.saveJobs([...scored, ...unscored, ...rejected, ...merged]);

  // Stage 9 — rank and cut. The cutoff compares the effective score (the
  // composite by default, the re-weighted average when the human set
  // scoreWeights); the sort order is a separate, tunable display concern
  // (rank.ts) — a role with no stated salary is never excluded by it, only
  // shown lower.
  const ranked = sortByRank(scored, deps.prefs);
  const aboveCutoff = ranked.filter((record) => effectiveScore(record, deps.prefs) >= deps.prefs.scoreCutoff);
  const shortlisted = aboveCutoff.slice(0, deps.prefs.digestLimit);
  const alsoSeen = ranked.filter((record) => !shortlisted.includes(record));

  // Stage 13 — pre-digest liveness validation. Dead postings leave the
  // digest (counted in the summary); ambiguous ones stay in and join the
  // human review queue for paced spot-checks. Skipped when no fetcher is
  // injected, so tests and offline runs never touch the network.
  let liveShortlisted: JobRecord[] = shortlisted;
  let livenessRemovedCount = 0;
  if (deps.livenessFetcher) {
    const liveness = await checkLiveness(shortlisted, deps.livenessFetcher);
    livenessRemovedCount = liveness.removed.length;
    liveShortlisted = [...liveness.live];
    await appendLivenessReviewQueue(
      liveness.reviewQueue,
      deps.livenessQueuePath ?? join(dirname(deps.costLogPath), "liveness-review-queue.jsonl"),
    );
  }

  const tokens = ledger.totalTokens();

  return {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    fetchedCount: rawPostings.length,
    newCount: fresh.length,
    duplicateCount,
    filteredCount: rejected.length,
    filterReasons: summarizeRejections(rejected),
    scoredCount: scored.length,
    shortlisted: liveShortlisted,
    alsoSeen,
    livenessRemovedCount,
    health,
    failures,
    costUsd: ledger.total(),
    inputTokens: tokens.input,
    outputTokens: tokens.output,
  };
}
