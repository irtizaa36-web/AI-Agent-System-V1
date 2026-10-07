import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PREFERENCES, type Preferences, type WatchlistEntry } from "./records";
import type { CandidateProfile } from "./score";
import { validatePreferenceValue } from "./feedback";
import { isNotFoundError } from "../store/run-store";

/**
 * Loads one person's pipeline configuration from disk.
 *
 * The engine is shared; the data never is. Two people are searching through
 * this pipeline — Shivani (marketing/ops roles via ATS boards) and Irtiza
 * (clinical-expertise gig platforms) — and everything identifying stays in
 * its own namespace: `config/job-search/<profile>/`, `profile/<profile>/`,
 * `.orchestrator/jobs/<profile>/`. There is deliberately no shared default
 * path any more, so a mis-specified profile fails loudly rather than
 * quietly reading or writing the wrong person's search (ADR 0017).
 *
 * Preferences and the watchlist are committed config — the person who knows
 * which titles and which employers matter edits JSON, never TypeScript. The
 * candidate profile is the opposite: it is a real resume, so it lives under
 * `profile/`, which is gitignored, and a missing one is a loud, explained
 * failure rather than a run that quietly scores against nothing.
 */

export const CONFIG_ROOT = "config/job-search";
export const PROFILE_ROOT = "profile";
export const DATA_ROOT = ".orchestrator/jobs";
export const COST_LOG_PATH = "logs/costs.jsonl";

/** A profile key is a directory name — keep it boring so it can't escape its own namespace. */
const VALID_PROFILE = /^[a-z0-9][a-z0-9-]*$/;

export class UnknownProfileError extends Error {}

export function assertValidProfile(profile: string): void {
  if (!VALID_PROFILE.test(profile)) {
    throw new UnknownProfileError(
      `"${profile}" is not a valid profile name — use lowercase letters, digits and hyphens (e.g. "shivani").`,
    );
  }
}

export function configDirFor(profile: string): string {
  assertValidProfile(profile);
  return join(CONFIG_ROOT, profile);
}

export function profileDirFor(profile: string): string {
  assertValidProfile(profile);
  return join(PROFILE_ROOT, profile);
}

export function dataDirFor(profile: string): string {
  assertValidProfile(profile);
  return join(DATA_ROOT, profile);
}

/**
 * Every profile that has a committed config directory. This is what `--all`
 * iterates and what the CLI lists — a profile with no config isn't a
 * profile, it's a typo.
 */
export async function listProfiles(root = "."): Promise<readonly string[]> {
  try {
    const entries = await readdir(join(root, CONFIG_ROOT), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && VALID_PROFILE.test(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isNotFoundError(error)) return [];
    throw error;
  }
}

async function readJsonIfPresent<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw new Error(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Merges the file over the defaults, so a config missing a key still runs. */
export async function loadPreferences(profile: string, root = "."): Promise<Preferences> {
  const fromFile = await readJsonIfPresent<Partial<Preferences>>(join(root, configDirFor(profile), "preferences.json"));
  return { ...DEFAULT_PREFERENCES, ...(fromFile ?? {}) };
}

/**
 * Writes a partial update onto the raw preferences.json file — merged over
 * whatever is already there, not over `DEFAULT_PREFERENCES`, and not
 * serialized from a typed `Preferences` object. Both distinctions matter:
 * a merge over defaults would silently write every default value into the
 * file the first time anything changes, and serializing a typed object
 * would delete every "_titles"/"_salaryFloor"-style documentary comment
 * this project's own preferences.json files rely on (see any of them) —
 * those aren't part of the `Preferences` type, so a naive round-trip
 * through it is how they'd quietly disappear.
 *
 * Every patch key passes the same field-type gate the feedback loop uses
 * before it merges: a type-invalid value rejects that one key (named in
 * the returned `rejectedKeys`, never written) while the rest still apply —
 * rejections are per-key and surfaced, never partial or silent.
 */
export async function savePreferences(
  profile: string,
  patch: Readonly<Record<string, unknown>>,
  root = ".",
): Promise<{ readonly rejectedKeys: readonly string[] }> {
  const path = join(root, configDirFor(profile), "preferences.json");
  const raw = (await readJsonIfPresent<Record<string, unknown>>(path)) ?? {};
  const rejectedKeys: string[] = [];
  const safePatch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!validatePreferenceValue(key, value)) {
      rejectedKeys.push(key);
      continue;
    }
    safePatch[key] = value;
  }
  const merged = { ...raw, ...safePatch };
  await writeFile(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  return { rejectedKeys };
}

export async function loadWatchlist(profile: string, root = "."): Promise<readonly WatchlistEntry[]> {
  const entries = await readJsonIfPresent<readonly WatchlistEntry[]>(join(root, configDirFor(profile), "watchlist.json"));
  return entries ?? [];
}

export class MissingProfileError extends Error {}

/**
 * The resume, converted to text once and cached. Absent means the pipeline
 * cannot score honestly, so it says so by name instead of scoring against an
 * empty string and producing confident nonsense.
 */
export async function loadProfile(profile: string, root = "."): Promise<CandidateProfile> {
  const dir = join(root, profileDirFor(profile));
  let resumeText: string;
  try {
    resumeText = await readFile(join(dir, "resume.md"), "utf8");
  } catch (error) {
    if (isNotFoundError(error)) {
      throw new MissingProfileError(
        `No resume found at ${join(dir, "resume.md")}. ` +
          "Convert the base resume to Markdown once and save it there — the pipeline caches it and never re-parses. " +
          "Scoring is skipped until it exists; discovery and filtering still run.",
      );
    }
    throw error;
  }

  const notes = (await readFileIfPresent(join(dir, "notes.md"))) ?? "";
  return { resume: resumeText.trim(), notes: notes.trim() };
}

async function readFileIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}
