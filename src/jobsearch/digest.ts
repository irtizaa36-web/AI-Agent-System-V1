import type { ApplicationRecord, JobRecord, ScoreDimensions } from "./records";
import { SCORE_DIMENSION_KEYS } from "./records";
import { salaryUnknown, bucketRejectionReason, type RejectionBucket } from "./filter";
import type { SourceHealth } from "./health";
import { summarizeHealth } from "./health";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Stage 10: the digest. Pure templating — no model writes this, because
 * nothing here requires judgment that stage 8 has not already made.
 *
 * What it refuses to do matters as much as what it does: a posting with no
 * stated salary says "not stated" rather than showing a plausible number, and
 * the gaps the scorer found are printed next to the roles she is most likely
 * to apply to, not hidden at the bottom.
 */

export interface RunSummary {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly fetchedCount: number;
  readonly newCount: number;
  readonly duplicateCount: number;
  readonly filteredCount: number;
  readonly filterReasons: readonly RejectionBucket[];
  readonly scoredCount: number;
  readonly shortlisted: readonly JobRecord[];
  readonly alsoSeen: readonly JobRecord[];
  /**
   * Stage 13: how many shortlisted postings the liveness check confirmed
   * dead and excluded from this digest. Absent = the stage was skipped
   * (tests, offline runs) or nothing was removed.
   */
  readonly livenessRemovedCount?: number;
  readonly health: readonly SourceHealth[];
  readonly failures: readonly string[];
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

function money(usd: number): string {
  if (usd === 0) return "$0.00";
  return usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

/** How many sub-cutoff roles the digest lists before collapsing the rest into a count line. */
export const ALSO_SEEN_LIMIT = 10;

function salaryLine(record: JobRecord): string {
  if (salaryUnknown(record)) return "Pay not stated";
  const currency = record.salaryCurrency ?? "";
  if (record.salaryMin === record.salaryMax) return `${record.salaryMin?.toLocaleString()} ${currency}`.trim();
  return `${record.salaryMin?.toLocaleString()}–${record.salaryMax?.toLocaleString()} ${currency}`.trim();
}

/** "N applicants" when a source stated a count; null otherwise so callers can omit it silently. */
export function applicantLine(record: JobRecord): string | null {
  const count = record.applicantCount;
  if (count === null || count === undefined) return null;
  return `${count.toLocaleString()} applicant${count === 1 ? "" : "s"}`;
}

function applicantSuffix(record: JobRecord): string {
  const line = applicantLine(record);
  return line ? ` · ${line}` : "";

/** Stage 12: the per-axis breakdown under a shortlisted role, when the scoring response carried one. */
function dimensionsLine(record: JobRecord): string | null {
  const dims = record.scoreDimensions;
  if (!dims) return null;
  return `_Fit breakdown:_ ${SCORE_DIMENSION_KEYS.map((key) => `${key} ${dims[key]}`).join(" · ")}`;

}

function roleBlock(record: JobRecord, index: number): string {
  const lines = [
    `### ${index}. ${record.title} — ${record.company}`,
    "",
    `**Score ${record.score ?? "?"}/100** · confidence ${record.confidence ?? "unknown"} · ${record.locationClass} · ${salaryLine(record)}${applicantSuffix(record)}`,
    "",
    record.rationale || "_No rationale returned._",
  ];

  const breakdown = dimensionsLine(record);
  if (breakdown) lines.push("", breakdown);

  if (record.gaps.length > 0) {
    lines.push("", `**Gaps:** ${record.gaps.join("; ")}`);
  }

  lines.push("", `[Apply](${record.applyUrl})`);
  if (record.sources.length > 1) {
    lines.push(`Also posted: ${record.sources.slice(1).map((source) => `[${source.sourceId}](${source.url})`).join(", ")}`);
  }

  return lines.join("\n");
}

export function renderDigest(summary: RunSummary): string {
  const date = summary.startedAt.slice(0, 10);
  const lines: string[] = [
    `# Job digest — ${date}`,
    "",
    `${summary.shortlisted.length} role${summary.shortlisted.length === 1 ? "" : "s"} worth a look · ` +
      `${summary.newCount} new of ${summary.fetchedCount} fetched · ` +
      `${summary.filteredCount} filtered out · ` +
      `run cost ${money(summary.costUsd)}`,
    "",
  ];

  if (summary.shortlisted.length === 0) {
    lines.push("No new roles cleared the score cutoff this run.", "");
  } else {
    lines.push("## Worth a look", "");
    summary.shortlisted.forEach((record, index) => {
      lines.push(roleBlock(record, index + 1), "");
    });
  }

  if ((summary.livenessRemovedCount ?? 0) > 0) {
    lines.push(
      `_${summary.livenessRemovedCount} role${summary.livenessRemovedCount === 1 ? "" : "s"} removed — ` +
        `posting no longer live when checked._`,
      "",
    );
  }

  if (summary.alsoSeen.length > 0) {
    lines.push("## Also seen (below cutoff)", "");
    const shown = summary.alsoSeen.slice(0, ALSO_SEEN_LIMIT);
    for (const record of shown) {
      lines.push(`- **${record.score ?? "?"}** · [${record.title} — ${record.company}](${record.applyUrl})`);
    }
    if (summary.alsoSeen.length > ALSO_SEEN_LIMIT) {
      lines.push(`- …and ${summary.alsoSeen.length - ALSO_SEEN_LIMIT} more below the cutoff`);
    }
    lines.push("");
  }

  lines.push("## Run", "");
  lines.push(`- Sources: ${summarizeHealth(summary.health)}`);
  lines.push(`- Tokens: ${summary.inputTokens.toLocaleString()} in, ${summary.outputTokens.toLocaleString()} out`);
  lines.push(`- Cost: ${money(summary.costUsd)}`);

  if (summary.filterReasons.length > 0) {
    const top = summary.filterReasons.slice(0, 5);
    const rest = summary.filterReasons.slice(5).reduce((sum, bucket) => sum + bucket.count, 0);
    const parts = top.map((bucket) => `${bucket.reason} (${bucket.count})`);
    if (rest > 0) parts.push(`${summary.filterReasons.length - 5} more reasons (${rest})`);
    lines.push(`- Filtered out: ${parts.join(", ")}`);
  }

  const broken = summary.health.filter((entry) => entry.state === "degraded");
  if (broken.length > 0) {
    lines.push("", "### Sources needing attention", "");
    for (const entry of broken) {
      lines.push(`- \`${entry.sourceId}\` — ${entry.error ?? "unknown error"}`);
    }
  }

  if (summary.failures.length > 0) {
    lines.push("", "### Postings not scored this run", "");
    lines.push("_These keep their place in the queue and are retried on the next run._", "");
    for (const failure of summary.failures) {
      lines.push(`- ${failure}`);
    }
  }

  lines.push(
    "",
    "---",
    "",
    "_Discovery and scoring only. Nothing was applied to, nobody was contacted, and no message was sent._",
  );

  return lines.join("\n");
}

/** One rejected record as the rejections log serializes it: enough to see *which* roles a check killed, so filter tuning isn't blind. */
export interface RejectionLogEntry {
  readonly id: string;
  readonly title: string;
  readonly company: string;
  /** The bucketed filter stage, not the full reason string — the digest's bucketing, per record. */
  readonly reason: string;
}

/**
 * Writes the run's rejected records to a JSONL log, one line each. Filter
 * tuning is blind without this: `summarizeRejections` buckets counts, but
 * nobody can see *which* roles a check killed to judge whether the check is
 * too tight. Write-only side effect after the pipeline decision is made —
 * the records are already rejected by this point, so the log can never
 * change what the pipeline does.
 */
export async function writeRejectionsLog(rejected: readonly JobRecord[], path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lines = rejected.map((record) =>
    JSON.stringify({
      id: record.id,
      title: record.title,
      company: record.company,
      reason: bucketRejectionReason(record.filterReason ?? "Unknown reason"),
    } satisfies RejectionLogEntry),
  );
  await appendFile(path, lines.length > 0 ? `${lines.join("\n")}\n` : "", "utf8");
}
/** One shortlisted role as digestPayload serializes it — flattened from JobRecord, dashboard- and prompt-facing rather than the pipeline's own internal shape. */
export interface DigestPayloadRole {
  readonly id: string;
  readonly title: string;
  readonly company: string;
  readonly locationClass: string;
  readonly salaryStated: boolean;
  readonly salaryMin: number | null;
  readonly salaryMax: number | null;
  /** Optional so digests stored before this field existed still type-check. `null` means the source did not say. */
  readonly applicantCount?: number | null;
  readonly score: number | null;
  readonly confidence: string | null;
  readonly rationale: string | null;
  readonly gaps: readonly string[];
  readonly applyUrl: string;
  /** Stage 12: the six per-axis scores, when the scoring response carried them. */
  readonly scoreDimensions: ScoreDimensions | null;
}

/**
 * The structured, typed shape `digests/latest.json` is written in on every
 * run and reconcile — real enough to import and read back elsewhere (see
 * feedback.ts's buildRunContext), not just a display payload for the
 * dashboard.
 */
export interface DigestPayload {
  readonly runId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly counts: {
    readonly fetched: number;
    readonly new: number;
    readonly duplicates: number;
    readonly filtered: number;
    readonly scored: number;
    readonly shortlisted: number;
  };
  readonly filterReasons: readonly RejectionBucket[];
  readonly costUsd: number;
  readonly shortlisted: readonly DigestPayloadRole[];
  readonly health: readonly SourceHealth[];
  readonly failures: readonly string[];
}

/** The same run, as data, for the dashboard to render and for the feedback loop to answer questions from. */
export function digestPayload(summary: RunSummary): DigestPayload {
  return {
    runId: summary.runId,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    counts: {
      fetched: summary.fetchedCount,
      new: summary.newCount,
      duplicates: summary.duplicateCount,
      filtered: summary.filteredCount,
      scored: summary.scoredCount,
      shortlisted: summary.shortlisted.length,
    },
    filterReasons: summary.filterReasons,
    costUsd: summary.costUsd,
    shortlisted: summary.shortlisted.map((record) => ({
      id: record.id,
      title: record.title,
      company: record.company,
      locationClass: record.locationClass,
      salaryStated: !salaryUnknown(record),
      salaryMin: record.salaryMin,
      salaryMax: record.salaryMax,
      applicantCount: record.applicantCount ?? null,
      score: record.score,
      confidence: record.confidence,
      rationale: record.rationale,
      gaps: record.gaps,
      applyUrl: record.applyUrl,
      scoreDimensions: record.scoreDimensions,
    })),
    health: summary.health,
    failures: summary.failures,
  };
}

/**
 * The CRM follow-up readout for the digest (Stage 14). Read-only: it lists
 * the applications whose nudge date has passed so she can follow up herself.
 * Nothing here sends, applies, or changes anything.
 */
export function renderFollowUpsSection(
  apps: readonly ApplicationRecord[],
  jobs: readonly JobRecord[],
): string {
  if (apps.length === 0) return "";
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  const lines = ["## Follow-ups due", ""];
  for (const app of apps) {
    const job = jobById.get(app.jobId);
    const label = job ? `${job.title} @ ${job.company}` : `application ${app.id}`;
    const due = app.followUpDueAt ? app.followUpDueAt.slice(0, 10) : "unknown date";
    lines.push(`- ${label} — ${app.status}, nudge was due ${due}`);
  }
  lines.push("", "These are reminders only — nothing is sent automatically.");
  return lines.join("\n");
}
