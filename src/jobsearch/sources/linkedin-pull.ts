import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RawPosting } from "../records";
import type { Source } from "./source";
import { isNotFoundError } from "../../store/run-store";
import { parseAppliedHistory, type AppliedHistoryEntry } from "../affinity";

/**
 * The `linkedin-pull` source adapter. It reads the previous morning's
 * supervised browser-task pull from a local JSON file and feeds it into the
 * pipeline like any other source — normalize → dedupe → filters → scoring.
 *
 * ADR 0013 stands for the engine: NO pipeline code may ever make a request
 * to linkedin.com, in any form. This module honors that by construction —
 * it performs pure local-file ingestion. It imports no HTTP client, calls
 * no fetch, and opens no sockets; the only way LinkedIn data enters the
 * pipeline is the human-paced, supervised, read-only browser task described
 * in ADR 0020 and docs/job-search/linkedin-pull-runbook.md, whose output
 * lands on disk at `profile/<name>/linkedin-pull/<date>.json`.
 *
 * If the file is absent, the source yields nothing and the run continues.
 * Malformed JSON is tolerated the same way: logged by the caller as a
 * degraded source would be, never fatal. (This module returns []; the
 * registry/CLI layer decides how to report it.)
 */

/** One pulled posting, as the morning browser task writes it. */
export interface LinkedInPullItem {
  /** Stable id for the posting (e.g. the LinkedIn job id). */
  readonly id: string;
  readonly title: string;
  readonly company: string;
  /** The LinkedIn job URL — carried through as the apply URL; never fetched by the pipeline. */
  readonly url: string;
  readonly location: string;
  /** ISO date when LinkedIn says it was posted, when stated. Never guessed — null when absent. */
  readonly postedAt: string | null;
  /** Plain-text summary of the posting, as pulled. */
  readonly summary: string;
  readonly salaryMin: number | null;
  readonly salaryMax: number | null;
  readonly salaryCurrency: string | null;
}

export interface LinkedInPullFile {
  readonly pulledAt: string;
  readonly items: readonly LinkedInPullItem[];
  /**
   * Her applied-jobs history as the morning pull extracts it — revealed
   * preference data for the affinity module. Optional: older pull files
   * predate it, and a missing/empty array simply means no affinity signal.
   */
  readonly appliedHistory?: readonly AppliedHistoryEntry[];
  /**
   * Her saved (not yet applied) jobs, when the pull extracts them — synced
   * into application records with status `saved` (leads, not applications).
   * Optional like appliedHistory.
   */
  readonly savedJobs?: readonly SavedJobEntry[];
}

export const LINKEDIN_PULL_SOURCE_ID = "linkedin-pull";

/**
 * Today's date stamp in America/Chicago — the pull files are named by the
 * date the supervised browser task runs them (a morning Central-time task),
 * so the lookup must use her wall clock, not UTC. A UTC stamp would pick
 * yesterday's file during the first six hours of every Central day.
 */
export function chicagoDateStamp(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return parts;
}

/** The dated pull file the morning browser task delivers. */
export function linkedInPullPath(profile: string, date: string, root = "."): string {
  return join(root, "profile", profile, "linkedin-pull", `${date}.json`);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Validates one pulled item; returns null when the item is unusable (skipped, never fatal). */
function toPosting(item: unknown, sourceId: string, fetchedAt: string): RawPosting | null {
  if (typeof item !== "object" || item === null) return null;
  const entry = item as Record<string, unknown>;
  // An id is required by the pull-file schema: it is the stable handle the
  // supervised pull uses to reference an item across days. Items without one
  // are rejected individually — never the whole file.
  if (!isNonEmptyString(entry["id"]) || !isNonEmptyString(entry["title"]) || !isNonEmptyString(entry["company"]) || !isNonEmptyString(entry["url"])) {
    return null;
  }
  const postedAt = typeof entry["postedAt"] === "string" && !Number.isNaN(new Date(entry["postedAt"]).getTime())
    ? (entry["postedAt"] as string)
    : null;
  // The pipeline's salary parsing re-derives figures from text, so a stated
  // range from the pull file is appended verbatim — LinkedIn's own stated
  // numbers, never a guess. Absent stays absent (null, not zero).
  const salaryMin = asNumberOrNull(entry["salaryMin"]);
  const salaryMax = asNumberOrNull(entry["salaryMax"]);
  const salaryCurrency = isNonEmptyString(entry["salaryCurrency"]) ? (entry["salaryCurrency"] as string).trim() : null;
  const body = isNonEmptyString(entry["summary"]) ? (entry["summary"] as string) : "";
  const salaryLine =
    salaryMin !== null || salaryMax !== null
      ? `\n\nStated salary range: ${salaryMin !== null ? salaryMin.toLocaleString() : "?"}–${salaryMax !== null ? salaryMax.toLocaleString() : "?"}${salaryCurrency ? ` ${salaryCurrency}` : ""}`
      : "";
  return {
    sourceId,
    url: (entry["url"] as string).trim(),
    title: (entry["title"] as string).trim(),
    company: (entry["company"] as string).trim(),
    location: isNonEmptyString(entry["location"]) ? (entry["location"] as string).trim() : "",
    body: `${body}${salaryLine}`,
    postedAt,
    fetchedAt,
  };
}

/**
 * Pure: parsed pull file -> postings. Invalid items are skipped individually.
 * A stated salary range from the pull is appended to the body verbatim so
 * the pipeline's salary parsing can read it; nothing is ever guessed.
 */
export function parseLinkedInPull(data: unknown, fetchedAt: string): readonly RawPosting[] {
  if (typeof data !== "object" || data === null) return [];
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const postings: RawPosting[] = [];
  for (const item of items) {
    const posting = toPosting(item, LINKEDIN_PULL_SOURCE_ID, fetchedAt);
    if (posting) postings.push(posting);
  }
  return postings;
}

/**
 * Reads today's pull file for the profile. Missing file -> no postings, no
 * error. Malformed JSON or a wrong-shaped file -> no postings, no error
 * (the morning pull is best-effort; the ATS boards are the primary sweep).
 */
export async function readLinkedInPull(profile: string, date: string, root = "."): Promise<readonly RawPosting[]> {
  const path = linkedInPullPath(profile, date, root);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return [];
  }
  return parseLinkedInPull(parsed, new Date().toISOString());
}

/**
 * Reads the pull file's `appliedHistory` for the profile — her revealed
 * preferences for the affinity module. Missing file, malformed JSON, or a
 * missing/invalid `appliedHistory` array all mean the same thing: no
 * affinity signal, and everything else works exactly as before.
 */
/** One saved (not yet applied) job from the LinkedIn pull's `savedJobs` array. */
export interface SavedJobEntry {
  readonly title: string;
  readonly company: string;
  readonly location: string;
  readonly url: string | null;
  readonly savedAt: string | null;
}

/**
 * Validates the pull file's `savedJobs` array. Same discipline as
 * parseAppliedHistory: entries missing title/company are skipped
 * individually, anything not an array means no saved jobs.
 */
export function parseSavedJobs(data: unknown): readonly SavedJobEntry[] {
  if (!Array.isArray(data)) return [];
  const entries: SavedJobEntry[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    const title = typeof entry["title"] === "string" ? entry["title"].trim() : "";
    const company = typeof entry["company"] === "string" ? entry["company"].trim() : "";
    if (!title || !company) continue;
    const location = typeof entry["location"] === "string" ? entry["location"].trim() : "";
    const url = typeof entry["url"] === "string" && entry["url"].trim() ? entry["url"].trim() : null;
    const rawSaved = typeof entry["savedAt"] === "string" ? entry["savedAt"] : null;
    const savedAt = rawSaved !== null && !Number.isNaN(new Date(rawSaved).getTime()) ? rawSaved : null;
    entries.push({ title, company, location, url, savedAt });
  }
  return entries;
}

/** Reads the pull file's `savedJobs` array (her saved, not-yet-applied jobs). Same missing/malformed → [] discipline as readAppliedHistory. */
export async function readSavedJobs(profile: string, date: string, root = "."): Promise<readonly SavedJobEntry[]> {
  const path = linkedInPullPath(profile, date, root);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  return parseSavedJobs((parsed as { savedJobs?: unknown }).savedJobs);
}

export async function readAppliedHistory(profile: string, date: string, root = "."): Promise<readonly AppliedHistoryEntry[]> {
  const path = linkedInPullPath(profile, date, root);
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  return parseAppliedHistory((parsed as { appliedHistory?: unknown }).appliedHistory);
}

/**
 * The Source the pipeline runs. Reads the local pull file for `date`
 * (default: today); never touches the network — see the module doc comment.
 */
export function createLinkedInPullSource(profile: string, root = ".", date?: string): Source {
  const pullDate = date ?? chicagoDateStamp(new Date());
  return {
    id: LINKEDIN_PULL_SOURCE_ID,
    company: null,
    async fetch() {
      return readLinkedInPull(profile, pullDate, root);
    },
  };
}
