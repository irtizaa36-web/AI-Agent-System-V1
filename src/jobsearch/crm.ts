import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApplicationRecord, ApplicationStatus, JobRecord } from "./records";
import { normalizeCompany } from "./affinity";
import type { AppliedHistoryEntry } from "./affinity";
import type { SavedJobEntry } from "./sources/linkedin-pull";
import { chicagoDateStamp, parseSavedJobs } from "./sources/linkedin-pull";

/**
 * The candidate's application tracker (Stage 14) — the part of the system
 * she will open every day, so it is the most carefully tested module here.
 *
 * Boundary, stated once and enforced everywhere: this tracker is read-only
 * against the outside world. It records what SHE did (applied, interviewed,
 * rejected a posting), never does anything on her behalf. No auto-send, no
 * auto-apply, no acceptance, no outreach — `jobs applied` is an explicit tap
 * she makes after she applied on the employer's own site, and the reminder
 * list in the digest is a readout, not a sender. See ADR 0021.
 */

/**
 * The full explicit state machine. Tailoring states are preserved
 * (`pending-approval` → `materials_ready` gate from Stage 11), and the
 * post-application funnel runs applied → screening → interview → offer /
 * rejected. `saved` is for LinkedIn saved jobs (leads, not applications).
 * `submitted_by_human` / `responded` are legacy states the tailoring flow
 * used; they still transition into the funnel.
 */
export const APPLICATION_TRANSITIONS: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
  "saved": ["queued", "applied", "withdrawn"],
  "queued": ["saved", "pending-approval", "materials_ready", "applied", "withdrawn"],
  "pending-approval": ["materials_ready", "withdrawn"],
  "materials_ready": ["applied", "withdrawn"],
  "prefilled": ["applied", "withdrawn"],
  "submitted_by_human": ["applied", "screening", "rejected", "withdrawn"],
  "applied": ["screening", "rejected", "withdrawn"],
  "screening": ["interview", "rejected", "withdrawn"],
  "interview": ["offer", "rejected", "withdrawn"],
  "responded": ["applied", "screening", "interview", "rejected", "withdrawn"],
  "offer": ["withdrawn"],
  "rejected": [],
  "withdrawn": [],
};

export class IllegalApplicationTransitionError extends Error {}

/** True when the status machine allows `from` → `to`. */
export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return (APPLICATION_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Moves an application record to a new status, or throws
 * IllegalApplicationTransitionError. Entering `applied` stamps `appliedAt`
 * when unset; entering applied/screening/interview refreshes `followUpDueAt`
 * (a nudge is owed after each human-visible step, not just the first).
 */
export function transitionApplication(
  app: ApplicationRecord,
  to: ApplicationStatus,
  now: Date = new Date(),
): ApplicationRecord {
  if (app.status === to) return app;
  if (!canTransition(app.status, to)) {
    throw new IllegalApplicationTransitionError(
      `Cannot move application ${app.id} from ${app.status} to ${to}.`,
    );
  }
  const stamp = now.toISOString();
  return {
    ...app,
    status: to,
    appliedAt: to === "applied" && !app.appliedAt ? stamp : app.appliedAt,
    followUpDueAt:
      to === "applied" || to === "screening" || to === "interview"
        ? addDays(stamp, FOLLOW_UP_AFTER_DAYS)
        : app.followUpDueAt,
  };
}

function addDays(iso: string, days: number): string {
  const date = new Date(iso);
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

/** A nudge is owed N days after she last acted (applied / screened / interviewed). */
export const FOLLOW_UP_AFTER_DAYS = 7;

const ACTIVE_FOLLOW_UP_STATUSES: readonly ApplicationStatus[] = ["applied", "screening", "interview"];

/**
 * Applications that are waiting on the employer and whose follow-up date has
 * passed. Pure readout — the digest and dashboard display it; nothing sends.
 */
export function dueFollowUps(apps: readonly ApplicationRecord[], now: Date = new Date()): ApplicationRecord[] {
  const cutoff = now.toISOString();
  return apps.filter(
    (app) =>
      ACTIVE_FOLLOW_UP_STATUSES.includes(app.status) &&
      app.followUpDueAt !== null &&
      app.followUpDueAt <= cutoff,
  );
}

/**
 * Rejects one posting. Sets the job record's state to `rejected` with a
 * reason — it does NOT mute the company. Company-level muting is the
 * separate `jobs mute-company` action with its own storage and its own
 * explicit tap.
 */
export function rejectPostingForJob(job: JobRecord): JobRecord {
  return {
    ...job,
    state: "rejected",
    filterReason: "Candidate rejected this posting (explicit action).",
  };
}

/** Storage for the explicit company mute list, separate from preference exclusions. */
export function mutedCompaniesPath(profile: string, root: string): string {
  return join(root, ".orchestrator", "jobs", profile, "muted-companies.json");
}

export async function loadMutedCompanies(profile: string, root: string): Promise<readonly string[]> {
  try {
    const raw = await readFile(mutedCompaniesPath(profile, root), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((name): name is string => typeof name === "string");
  } catch {
    return [];
  }
}

export async function addMutedCompany(
  profile: string,
  root: string,
  name: string,
): Promise<{ added: boolean; muted: readonly string[] }> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Company name is required.");
  const current = await loadMutedCompanies(profile, root);
  const normalized = normalizeCompany(trimmed);
  if (current.some((existing) => normalizeCompany(existing) === normalized)) {
    return { added: false, muted: current };
  }
  const updated = [...current, trimmed];
  await mkdir(join(mutedCompaniesPath(profile, root), ".."), { recursive: true });
  await writeFile(mutedCompaniesPath(profile, root), JSON.stringify(updated, null, 2) + "\n", "utf8");
  return { added: true, muted: updated };
}

export async function removeMutedCompany(
  profile: string,
  root: string,
  name: string,
): Promise<{ removed: boolean; muted: readonly string[] }> {
  const current = await loadMutedCompanies(profile, root);
  const normalized = normalizeCompany(name.trim());
  const updated = current.filter((existing) => normalizeCompany(existing) !== normalized);
  if (updated.length === current.length) return { removed: false, muted: current };
  await writeFile(mutedCompaniesPath(profile, root), JSON.stringify(updated, null, 2) + "\n", "utf8");
  return { removed: true, muted: updated };
}

export function isMuted(company: string, muted: readonly string[]): boolean {
  const normalized = normalizeCompany(company);
  return muted.some((name) => normalizeCompany(name) === normalized);
}

// ---------------------------------------------------------------------------
// LinkedIn sync
// ---------------------------------------------------------------------------

/**
 * The dedupe key for LinkedIn sync: normalized company + normalized title.
 * A LinkedIn application for "Field Marketing Manager @ Eon.io" and a
 * pipeline-tracked application for the same title/company are the same
 * application — the sync never creates both.
 */
export function applicationKey(company: string, title: string): string {
  return `${normalizeCompany(company)}|${title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
}

export interface LinkedInSyncInput {
  readonly existing: readonly ApplicationRecord[];
  readonly history: readonly AppliedHistoryEntry[];
  readonly savedJobs: readonly SavedJobEntry[];
  /** Pipeline job records, for linking a LinkedIn application to a tracked posting. */
  readonly jobs: readonly JobRecord[];
  readonly now?: Date;
}

export interface LinkedInSyncResult {
  readonly created: ApplicationRecord[];
  readonly skipped: readonly { readonly key: string; readonly reason: string }[];
}

/**
 * Maps LinkedIn applied-job statuses onto CRM stages. Anything that says she
 * applied (or was in progress) becomes `applied`. Anything else — including
 * "no longer accepting" or an empty status — still becomes `applied`: the
 * posting closing is not a rejection of her, and LinkedIn silence is never
 * read as a rejection. The raw status travels in notes so the nuance survives.
 */
function appliedStatusFor(linkedinStatus: string | null): { status: ApplicationStatus; note: string | null } {
  const normalized = (linkedinStatus ?? "").toLowerCase();
  if (normalized.includes("in progress") || normalized.includes("applied")) {
    return { status: "applied", note: null };
  }
  return {
    status: "applied",
    note: `LinkedIn status was "${linkedinStatus ?? "unknown"}" — recorded as applied; never infer rejection from LinkedIn.`,
  };
}

function jobIdFor(entry: { title: string; company: string }, jobs: readonly JobRecord[]): string {
  const key = applicationKey(entry.company, entry.title);
  const match = jobs.find((job) => applicationKey(job.company, job.title) === key);
  if (match) return match.id;
  // The dedupe key rides along in the jobId so a re-run of the sync can
  // recognize its own records — LinkedIn-only applications have no job
  // record to look up.
  return `linkedin:${key}`;
}

/** Recovers the dedupe key for an existing application, including LinkedIn-synced ones. */
function existingApplicationKey(app: ApplicationRecord, jobs: readonly JobRecord[]): string {
  if (app.jobId.startsWith("linkedin:")) return app.jobId.slice("linkedin:".length);
  const job = jobs.find((record) => record.id === app.jobId);
  return applicationKey(job?.company ?? "", job?.title ?? "");
}

/**
 * Syncs the LinkedIn pull's appliedHistory and savedJobs into application
 * records source-tagged `linkedin`. Idempotent: entries whose
 * company+title already appear in existing applications are skipped, and
 * re-running after the first sync creates nothing new. Creates nothing for
 * rejections — ever.
 */
export function syncLinkedInApplications(input: LinkedInSyncInput): LinkedInSyncResult {
  const now = input.now ?? new Date();
  const stamp = now.toISOString();
  const seen = new Set(input.existing.map((app) => existingApplicationKey(app, input.jobs)));
  const created: ApplicationRecord[] = [];
  const skipped: { key: string; reason: string }[] = [];

  for (const entry of input.history) {
    const key = applicationKey(entry.company, entry.title);
    if (seen.has(key)) {
      skipped.push({ key, reason: "already tracked as an application" });
      continue;
    }
    seen.add(key);
    const mapped = appliedStatusFor(entry.status);
    created.push({
      id: randomUUID(),
      jobId: jobIdFor(entry, input.jobs),
      status: mapped.status,
      appliedAt: entry.dateApplied ?? stamp,
      resumeVariantPath: null,
      coverLetterPath: null,
      followUpDueAt: addDays(stamp, FOLLOW_UP_AFTER_DAYS),
      outcome: null,
      rejectionReason: null,
      notes: [
        `Synced from LinkedIn applied history (${chicagoDateStamp(now)} pull).`,
        ...(mapped.note ? [mapped.note] : []),
      ],
      source: "linkedin",
    });
  }

  for (const entry of input.savedJobs) {
    const key = applicationKey(entry.company, entry.title);
    if (seen.has(key)) {
      skipped.push({ key, reason: "already tracked as an application" });
      continue;
    }
    seen.add(key);
    created.push({
      id: randomUUID(),
      jobId: jobIdFor(entry, input.jobs),
      status: "saved",
      appliedAt: null,
      resumeVariantPath: null,
      coverLetterPath: null,
      followUpDueAt: null,
      outcome: null,
      rejectionReason: null,
      notes: [`Saved on LinkedIn (${chicagoDateStamp(now)} pull) — a lead, not an application yet.`],
      source: "linkedin",
    });
  }

  return { created, skipped };
}
