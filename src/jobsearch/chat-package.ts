import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { dataDirFor } from "./config";
import type { RunSummary } from "./digest";
import { formatDigestEmailBody, formatDigestEmailSubject } from "./digest-email";
import { salaryUnknown } from "./filter";
import type { JobRecord } from "./records";

const execFileAsync = promisify(execFile);

/**
 * The scheduled run's terminal artifact. Under the standing NO-EMAILS rule
 * (2026-10-04) the run sends nothing to anyone — no email, no SMS, no
 * iMessage. Instead it writes a dated "chat package" under the profile's
 * data dir that the supervising agent relays to chat, where the
 * select-then-tailor loop happens: the human picks roles from the shortlist
 * and tailored resumes get built later, on that tap — never in this run.
 *
 * Layout, per run:
 *   data/<profile>/chat-packages/<startedAt-stamp>/
 *     shortlist.txt  — human-readable list, reusing the digest email body formatter
 *     roles.json     — per-role metadata (title, company, location, pay band,
 *                      posted age, experience required, verified apply URL, fit note)
 *     manifest.json  — run timestamp, role count, package paths
 */

/** One shortlisted role, flattened for roles.json. */
export interface ChatPackageRole {
  /** Stable dedupe identity of the posting — the idempotency key for sends. */
  readonly roleId: string;
  readonly title: string;
  readonly company: string;
  readonly location: string;
  readonly payBand: string;
  readonly postedAge: string;
  readonly experienceRequired: string;
  readonly applyUrl: string;
  readonly fitNote: string;
}

/**
 * The roles.json envelope. The VM sender reads this to decide whether to
 * send: `date` must be today (America/Chicago), `code_sha` is compared
 * against the expected pipeline SHA (alert on mismatch, never block), and
 * `roles[].roleId` feeds the sent-ledger idempotency keys.
 */
export interface ChatPackageRolesEnvelope {
  /** Run date, YYYY-MM-DD in America/Chicago. */
  readonly date: string;
  /** git HEAD of the tree that ran the pipeline; "unknown" when unavailable. */
  readonly code_sha: string;
  /** Experience band that produced this shortlist, e.g. "3-7". */
  readonly filter_version: string;
  readonly roles: ChatPackageRole[];
}

/** Run-level metadata the caller supplies; everything has a safe default. */
export interface ChatPackageMeta {
  readonly filterVersion?: string;
  readonly codeSha?: string;
}

export interface ChatPackageManifest {
  readonly runTimestamp: string;
  readonly roleCount: number;
  readonly packageDir: string;
  readonly files: {
    readonly shortlist: string;
    readonly roles: string;
    readonly manifest: string;
  };
}

function payBand(record: JobRecord): string {
  if (salaryUnknown(record)) return "Pay not stated";
  const currency = record.salaryCurrency ?? "";
  const figure = (n: number | null): string => (n === null ? "?" : n.toLocaleString());
  return record.salaryMin === record.salaryMax
    ? `${figure(record.salaryMin)} ${currency}`.trim()
    : `${figure(record.salaryMin)}-${figure(record.salaryMax)} ${currency}`.trim();
}

function postedAge(record: JobRecord, nowIso: string): string {
  if (!record.postedAt) return "date unknown";
  const posted = new Date(record.postedAt).getTime();
  const now = new Date(nowIso).getTime();
  if (Number.isNaN(posted) || Number.isNaN(now)) return "date unknown";
  const days = Math.max(0, Math.floor((now - posted) / (24 * 60 * 60 * 1000)));
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  return `${days} days ago`;
}

function experienceRequired(record: JobRecord): string {
  const min = record.experienceYearsMin;
  const max = record.experienceYearsMax;
  if (min === null && max === null) return "not stated";
  if (min !== null && max !== null) return min === max ? `${min} years` : `${min}-${max} years`;
  if (min !== null) return `${min}+ years`;
  return `up to ${max} years`;
}

export function chatPackageRole(record: JobRecord, nowIso: string): ChatPackageRole {
  return {
    roleId: record.identityKey,
    title: record.title,
    company: record.company,
    location: record.rawLocation || record.locationClass,
    payBand: payBand(record),
    postedAge: postedAge(record, nowIso),
    experienceRequired: experienceRequired(record),
    applyUrl: record.applyUrl,
    fitNote: record.rationale ?? "",
  };
}

/** Best-effort git HEAD of the run tree — "unknown" when not a git checkout. */
async function resolveCodeSha(root: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], { timeout: 5000 });
    const sha = stdout.trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : "unknown";
  } catch {
    return "unknown";
  }
}

function chicagoDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "unknown";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

/**
 * Writes the chat package for a run and prints its path plus the role count
 * to stdout, so the supervising agent can relay it to chat. Returns the
 * package directory. Never builds tailored resumes — that happens later, on
 * the human's tap, outside the scheduled run.
 */
export async function writeChatPackage(
  profile: string,
  root: string,
  summary: RunSummary,
  stdout: (line: string) => void,
  meta: ChatPackageMeta = {},
): Promise<string> {
  const stamp = summary.startedAt.replace(/[:.]/g, "-");
  const packageDir = join(root, dataDirFor(profile), "chat-packages", stamp);
  await mkdir(packageDir, { recursive: true });

  const roles = summary.shortlisted.map((record) => chatPackageRole(record, summary.startedAt));
  const files = { shortlist: "shortlist.txt", roles: "roles.json", manifest: "manifest.json" } as const;

  const shortlist = `${formatDigestEmailSubject(summary)}\n\n${formatDigestEmailBody(summary)}`;
  await writeFile(join(packageDir, files.shortlist), shortlist, "utf8");

  const envelope: ChatPackageRolesEnvelope = {
    date: chicagoDate(summary.startedAt),
    code_sha: meta.codeSha ?? (await resolveCodeSha(root)),
    filter_version: meta.filterVersion ?? "unknown",
    roles,
  };
  await writeFile(join(packageDir, files.roles), JSON.stringify(envelope, null, 2), "utf8");

  const manifest: ChatPackageManifest = {
    runTimestamp: summary.startedAt,
    roleCount: summary.shortlisted.length,
    packageDir,
    files: { ...files },
  };
  await writeFile(join(packageDir, files.manifest), JSON.stringify(manifest, null, 2), "utf8");

  stdout(`Chat package written to ${packageDir} — ${roles.length} role${roles.length === 1 ? "" : "s"} shortlisted.`);
  return packageDir;
}
