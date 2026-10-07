import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPipeline } from "../jobsearch/pipeline";
import { renderDigest, digestPayload, type DigestPayload, type RunSummary } from "../jobsearch/digest";
import { sourcesFromWatchlist } from "../jobsearch/sources/registry";
import { JsonFileJobStore } from "../store/job-store";
import { createScoringClientFromEnv } from "../jobsearch/scoring-client";
import {
  draftTailoredResume,
  estimateTailorCost,
  gapAnalysisCompletionRequest,
  TAILORED_DIR,
  TAILOR_MODEL,
  TAILOR_SONNET_MODEL,
  tailorCompletionRequest,
} from "../jobsearch/tailor";
import {
  approveLedger,
  buildLedger,
  ledgerPathFor,
  readLedger as readTailorLedger,
  renderResumeDiff,
  writeLedger as writeTailorLedger,
} from "../jobsearch/tailor-ledger";
import { CostLedger, readLedger } from "../jobsearch/cost";
import { createJobsDashboardServer } from "../jobsearch/dashboard";
import { createAlertMailSource } from "../jobsearch/sources/alert-mail";
import { createPublicBoardSources } from "../jobsearch/sources/public-boards";
import { LINKEDIN_GUEST_SOURCE_ID } from "../jobsearch/sources/linkedin-guest";
import { createLinkedInPullSource, readAppliedHistory, readSavedJobs, chicagoDateStamp } from "../jobsearch/sources/linkedin-pull";
import {
  addMutedCompany,
  APPLICATION_TRANSITIONS,
  dueFollowUps,
  FOLLOW_UP_AFTER_DAYS,
  loadMutedCompanies,
  rejectPostingForJob,
  removeMutedCompany,
  syncLinkedInApplications,
  transitionApplication,
} from "../jobsearch/crm";
import type { ApplicationStatus } from "../jobsearch/records";
import { JsonFileMailReader, proposeMailLinks, renderMailScanReport } from "../jobsearch/mail-scan";
import { renderFollowUpsSection } from "../jobsearch/digest";
import { buildAffinity } from "../jobsearch/affinity";
import { httpLivenessFetcher } from "../jobsearch/liveness";
import { createInkboxClientFromEnv } from "../integrations/inkbox/real-client";
import type { Source } from "../jobsearch/sources/source";
import { writeChatPackage } from "../jobsearch/chat-package";
import { reconcileFiltered } from "../jobsearch/reconcile";
import { scoreRecords } from "../jobsearch/score";
import { sortByRank } from "../jobsearch/rank";
import { summarizeRejections } from "../jobsearch/filter";
import type { JobRecord } from "../jobsearch/records";
import {
  assertValidProfile,
  CONFIG_ROOT,
  configDirFor,
  COST_LOG_PATH,
  dataDirFor,
  listProfiles,
  loadPreferences,
  loadProfile,
  loadWatchlist,
  MissingProfileError,
  profileDirFor,
  savePreferences,
} from "../jobsearch/config";
import type { CandidateProfile } from "../jobsearch/score";
import {
  applyFeedbackPatch,
  buildConversationHistory,
  buildFeedbackReplyBody,
  buildRunContext,
  classifyFeedback,
  looksLikeDirectMessage,
  looksLikeDirectText,
  normalizePhone,
  type ConversationTurn,
  type PatchEntry,
} from "../jobsearch/feedback";
import { JsonFileFeedbackLog, type FeedbackRecord } from "../jobsearch/feedback-log";
import { createImessageClientFromEnv } from "../jobsearch/imessage-client";
import { commitAndPush } from "../integrations/git/auto-commit";
import { createContactClientFromEnv, type Contact } from "../integrations/inkbox/contact-client";

/**
 * `orchestrator jobs ...` — the pipeline's command surface, and the single
 * entrypoint the scheduled run invokes. Nothing here is interactive: a
 * launchd job runs `jobs run` and everything it needs comes from config files
 * and the environment.
 */

export interface JobsCommandDeps {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly root?: string;
}

const USAGE = [
  "jobs subcommands (every one takes --profile <name>, or --all where noted):",
  "  run --profile <name>|--all   Fetch, dedupe, filter, score, and write today's digest",
  "  reconcile --profile <name>   Re-check already-filtered postings against today's rules (after a prefs/filter change) and score any that now pass",
  "  check-feedback --profile <name>|--all   Read new direct replies from the candidate (email and, if DIGEST_IMESSAGE_TO is set, iMessage) and auto-apply any preference changes (FEEDBACK_LOOP_ENABLED=true required). Never sends a reply — the standing NO-EMAILS rule.",
  "  tailor --profile <name> --job <record-id> [--dry-run]   Draft a tailored resume variant for one job (draft-only; never sends, never submits)",
  "  tailor --profile <name> --job <record-id> --approve [--confirm]",
  "                                                     Review a tailored draft (diff + claim check); --confirm marks it ready",
  "  enrich-contact --profile <name>|--all   Link DIGEST_IMESSAGE_TO's phone to the candidate's Inkbox contact record (found via DIGEST_EMAIL_TO) and tag it with this profile. Idempotent; safe to re-run.",
  "  tailor --profile <name> --job <record-id> [--dry-run]   Draft a tailored resume variant for one job (draft-only; never sends, never submits)",
  "  tailor --profile <name> --job <record-id> --approve [--confirm]",
  "                                                     Review a tailored draft (diff + claim check); --confirm marks it ready",
  "  digest --profile <name>      Print the most recent digest without running the pipeline",
  "  applied --profile <name> --job <record-id>   Record that SHE applied to a posting (explicit tap; starts the follow-up nudge)",
  "  stage --profile <name> <job-or-application-id> <stage>   Move an application through the funnel (applied|screening|interview|offer|rejected|withdrawn|...)",
  "  reject --profile <name> --job <record-id>   Reject one posting (never mutes the company)",
  "  mute-company --profile <name> <company>   Stop showing a company entirely (explicit company-level action)",
  "  unmute-company --profile <name> <company>   Reverse a mute",
  "  linkedin-sync --profile <name>   Sync the morning LinkedIn pull's applied/saved jobs into tracked applications (idempotent, never infers rejection)",
  "  mail-scan --profile <name> --dry-run --mbox <messages.json>   Read-only scan of exported recruiting mail; proposes links, changes nothing",
  "  sources --profile <name>     List the configured sources and check each one's health",
  "  costs                        Show what recent runs have cost (shared ledger)",
  "  profiles                     List every configured profile",
  "  dashboard --profile <name>   Serve the local review queue (default port 8899)",
  "",
  "Two people search through this one pipeline and their data never mixes —",
  "there is no default profile on purpose. See ADR 0017.",
].join("\n");

/** Reads `--profile <name>` out of an argument list. Absent is a real answer (undefined), not a guess. */
export function parseProfileFlag(args: readonly string[]): string | undefined {
  const index = args.indexOf("--profile");
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

export function parseJobFlag(args: readonly string[]): string | undefined {
  const index = args.indexOf("--job");
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

/**
 * Resolves which profiles a command should act on. Deliberately refuses to
 * pick one for you: with two real people's searches in one repo, guessing
 * wrong means showing or writing the wrong person's data.
 */
async function resolveProfiles(
  args: readonly string[],
  root: string,
  deps: JobsCommandDeps,
  allowAll: boolean,
): Promise<readonly string[] | undefined> {
  const known = await listProfiles(root);

  if (allowAll && args.includes("--all")) {
    if (known.length === 0) {
      deps.stderr(`No profiles configured. Create ${CONFIG_ROOT}/<name>/preferences.json first.`);
      return undefined;
    }
    return known;
  }

  const requested = parseProfileFlag(args);
  if (!requested) {
    deps.stderr(
      `Which profile? Pass --profile <name>${allowAll ? " or --all" : ""}. ` +
        (known.length > 0 ? `Configured: ${known.join(", ")}.` : `None configured yet under ${CONFIG_ROOT}/.`),
    );
    return undefined;
  }

  try {
    assertValidProfile(requested);
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
    return undefined;
  }

  if (!known.includes(requested)) {
    deps.stderr(
      `No profile named "${requested}". ` +
        (known.length > 0 ? `Configured: ${known.join(", ")}.` : `None configured yet under ${CONFIG_ROOT}/.`),
    );
    return undefined;
  }

  return [requested];
}

export async function runJobsCommand(args: readonly string[], deps: JobsCommandDeps): Promise<number> {
  const root = deps.root ?? ".";
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "run": {
      const profiles = await resolveProfiles(rest, root, deps, true);
      if (!profiles) return 1;
      let worst = 0;
      for (const profile of profiles) {
        if (profiles.length > 1) deps.stdout(`\n===== ${profile} =====\n`);
        worst = Math.max(worst, await runJobsRun(profile, root, deps));
      }
      return worst;
    }
    case "reconcile": {
      const profiles = await resolveProfiles(rest, root, deps, true);
      if (!profiles) return 1;
      let worst = 0;
      for (const profile of profiles) {
        if (profiles.length > 1) deps.stdout(`\n===== ${profile} =====\n`);
        worst = Math.max(worst, await runJobsReconcile(profile, root, deps));
      }
      return worst;
    }
    case "check-feedback": {
      const profiles = await resolveProfiles(rest, root, deps, true);
      if (!profiles) return 1;
      let worst = 0;
      for (const profile of profiles) {
        if (profiles.length > 1) deps.stdout(`\n===== ${profile} =====\n`);
        worst = Math.max(worst, await runJobsCheckFeedback(profile, root, deps));
      }
      return worst;
    }
    case "tailor": {
      const profiles = await resolveProfiles(rest, root, deps, false);
      if (!profiles) return 1;
      return runJobsTailor(profiles[0] as string, root, deps, rest);
    }
    case "enrich-contact": {
      const profiles = await resolveProfiles(rest, root, deps, true);
      if (!profiles) return 1;
      let worst = 0;
      for (const profile of profiles) {
        if (profiles.length > 1) deps.stdout(`\n===== ${profile} =====\n`);
        worst = Math.max(worst, await runJobsEnrichContact(profile, root, deps));
      }
      return worst;
    }
    case "digest": {
      const profiles = await resolveProfiles(rest, root, deps, false);
      if (!profiles) return 1;
      return printLatestDigest(profiles[0] as string, root, deps);
    }
    case "sources": {
      const profiles = await resolveProfiles(rest, root, deps, false);
      if (!profiles) return 1;
      return listSources(profiles[0] as string, root, deps);
    }
    case "costs":
      return printCosts(root, deps);
    case "profiles": {
      const known = await listProfiles(root);
      if (known.length === 0) deps.stdout(`No profiles configured yet under ${CONFIG_ROOT}/.`);
      else for (const profile of known) deps.stdout(profile);
      return 0;
    }
    case "dashboard": {
      const profiles = await resolveProfiles(rest, root, deps, false);
      if (!profiles) return 1;
      return serveDashboard(rest, profiles[0] as string, root, deps);
    }
    case "applied": {
      const profiles = await resolveProfiles(rest, root, deps, false);
      if (!profiles) return 1;
      return runJobsApplied(profiles[0] as string, root, deps, rest);
    }
    case "stage": {
      const profiles = await resolveProfiles(rest, root, deps, false);
      if (!profiles) return 1;
      return runJobsStage(profiles[0] as string, root, deps, rest);
    }
    case "reject": {
      const profiles = await resolveProfiles(rest, root, deps, false);
      if (!profiles) return 1;
      return runJobsReject(profiles[0] as string, root, deps, rest);
    }
    case "mute-company": {
      const profiles = await resolveProfiles(rest, root, deps, false);
      if (!profiles) return 1;
      return runJobsMuteCompany(profiles[0] as string, root, deps, rest, true);
    }
    case "unmute-company": {
      const profiles = await resolveProfiles(rest, root, deps, false);
      if (!profiles) return 1;
      return runJobsMuteCompany(profiles[0] as string, root, deps, rest, false);
    }
    case "linkedin-sync": {
      const profiles = await resolveProfiles(rest, root, deps, false);
      if (!profiles) return 1;
      return runJobsLinkedInSync(profiles[0] as string, root, deps);
    }
    case "mail-scan": {
      const profiles = await resolveProfiles(rest, root, deps, false);
      if (!profiles) return 1;
      return runJobsMailScan(profiles[0] as string, root, deps, rest);
    }
    default:
      deps.stdout(USAGE);
      return subcommand === undefined || subcommand === "help" ? 0 : 1;
  }
}

async function runJobsRun(profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  const loadedPrefs = await loadPreferences(profile, root);
  const watchlist = await loadWatchlist(profile, root);
  const inkboxClient = createInkboxClientFromEnv();
  // Muted companies are a separate explicit action from preference
  // exclusions, but they must behave the same downstream — so the mute
  // list merges into the run's exclusions here, at the one place filters
  // read them. Rejecting a posting never touches this list.
  const muted = await loadMutedCompanies(profile, root);
  const prefs = muted.length > 0
    ? { ...loadedPrefs, companyExclusions: [...loadedPrefs.companyExclusions, ...muted] }
    : loadedPrefs;
  const publicBoards = createPublicBoardSources(profile, prefs.titles, { onWarning: deps.stderr, root });
  if (muted.length > 0) {
    deps.stderr(`Muted companies excluded from this run: ${muted.join(", ")}`);
  }

if (watchlist.length === 0 && !inkboxClient && publicBoards.sources.length === 0) {
    deps.stderr(
      `No sources configured for ${profile}: ${join(configDirFor(profile), "watchlist.json")} is empty and Inkbox (for LinkedIn/Indeed alerts) is not set up. Add at least one.`,
    );
    return 1;
  }

  // A missing resume stops scoring, not the run: discovery and filtering are
  // still worth doing, and the digest says plainly why nothing was scored.
  let candidate: CandidateProfile = { resume: "", notes: "" };
  let profileMissing: string | null = null;
  try {
    candidate = await loadProfile(profile, root);
  } catch (error) {
    if (error instanceof MissingProfileError) {
      profileMissing = error.message;
    } else {
      throw error;
    }
  }

  const scoringClient = profileMissing ? undefined : createScoringClientFromEnv();
  if (!profileMissing && !scoringClient) {
    deps.stderr("Claude Code CLI not found — running discovery only, scoring will be skipped. (Log in the claude CLI on this Mac to enable scoring.)");
  }
  if (profileMissing) deps.stderr(profileMissing);
  // The digest's own failure line needs the real cause, not an assumption:
  // scoringClient can be undefined for two different reasons, and confusing
  // them sends whoever reads it chasing the wrong fix (confirmed in
  // production Sep 14 — a run with a perfectly good ANTHROPIC_API_KEY still
  // said "no ANTHROPIC_API_KEY configured" because the real cause was a
  // missing resume).
  const scoringUnavailableReason = profileMissing
    ? "no resume on file for this profile yet"
    : !scoringClient
      ? "Claude Code CLI not found on this Mac"
      : undefined;

  // Adds LinkedIn/Indeed coverage via forwarded alert emails (ADR 0013,
  // ADR 0015) when Inkbox is configured. Silently absent otherwise — never
  // a half-configured source, same pattern as the scoring client above.
  const sources: Source[] = [...sourcesFromWatchlist(watchlist)];
  if (inkboxClient) sources.push(createAlertMailSource(inkboxClient));
  sources.push(...publicBoards.sources);
  if (publicBoards.adzunaSkipped) {
    deps.stderr("Adzuna job board skipped: set ADZUNA_APP_ID and ADZUNA_APP_KEY to enable it.");
  }
  // The supervised morning LinkedIn pull (ADR 0020): pure local-file
  // ingestion, yields nothing when the pull file is absent. The pipeline
  // never touches linkedin.com itself.
  sources.push(createLinkedInPullSource(profile, root));

  // Applied-history revealed preferences: her applied-jobs history from the
  // same pull file feeds a deterministic, capped affinity bonus in scoring.
  // Absent/empty history means no signal — scoring is unchanged.
  const pullDate = chicagoDateStamp(new Date());
  const affinityModel = buildAffinity(await readAppliedHistory(profile, pullDate, root));

  const store = new JsonFileJobStore(join(root, dataDirFor(profile)));
  const summary = await runPipeline({
    sources,
    store,
    prefs,
    profile: candidate,
    scoringClient,
    scoringUnavailableReason,
    costLogPath: join(root, COST_LOG_PATH),
    affinityModel,
    // Stage 13: real HEAD/GET liveness checks on shortlisted apply URLs.
    // Fail-open — a dead posting is excluded, a check that errors out is
    // treated as ambiguous and stays in the digest.
    livenessFetcher: httpLivenessFetcher,
  });

  let markdown = renderDigest(summary);

  // CRM LinkedIn sync (Stage 14): the pull's applied/saved history becomes
  // source-tagged application records, deduped by company+title against
  // pipeline-tracked applications. Runs inside `jobs run` because it is
  // read-only ingestion of her own actions — the same way the pull source
  // ingests postings. `jobs linkedin-sync` re-runs it on demand.
  const syncResult = await syncLinkedInForProfile(profile, root, store, deps);

  // Follow-up reminders are a readout, never a sender: the digest lists the
  // applications whose nudge date has passed so she can follow up herself.
  const followUps = dueFollowUps(await store.listApplications(), new Date());
  if (followUps.length > 0) {
    markdown += `\n\n${renderFollowUpsSection(followUps, await store.listJobs())}`;
  }

  const digestDir = join(root, dataDirFor(profile), "digests");
  await mkdir(digestDir, { recursive: true });
  const stamp = summary.startedAt.replace(/[:.]/g, "-");
  await writeFile(join(digestDir, `${stamp}.md`), markdown, "utf8");
  await writeFile(join(digestDir, "latest.md"), markdown, "utf8");
  await writeFile(join(digestDir, "latest.json"), JSON.stringify(digestPayload(summary), null, 2), "utf8");

  deps.stdout(markdown);
  deps.stdout("");
  deps.stdout(`Digest written to ${join(digestDir, "latest.md")}`);

  // Terminal step, per the standing NO-EMAILS rule (2026-10-04): the run
  // writes a chat package for the supervising agent to relay. It sends
  // nothing — no email, no SMS, no iMessage — and builds no tailored
  // resumes; those happen later, on the human's tap, outside this run.
  await writeChatPackage(profile, root, summary, deps.stdout, {
    filterVersion: `${prefs.experienceYearsFloor ?? "?"}-${prefs.experienceYearsCeiling ?? "?"}`
  });

  // Piggybacks on the same daily schedule as the pipeline itself, so the
  // feedback loop gets at least one pass a day with no separate scheduling
  // required. Self-gated on FEEDBACK_LOOP_ENABLED like every other optional
  // step above — a no-op unless explicitly turned on. Run `jobs check-feedback`
  // directly (or on its own more frequent schedule) for faster turnaround.
  await runJobsCheckFeedback(profile, root, deps);

  // A run where every source broke is a failure worth a non-zero exit, so a
  // scheduled job surfaces it rather than looking like a quiet success.
  const allBroken = summary.health.length > 0 && summary.health.every((entry) => entry.state === "degraded");
  return allBroken ? 1 : 0;
}

/**

 * Re-checks every currently `filtered` posting against today's prefs and
 * scores whatever now passes. Exists because dedupe treats anything already
 * in the store as known forever — see reconcile.ts — so a prefs or filter
 * logic change only ever affects postings discovered after the change
 * unless something explicitly replays the old ones too. Fetches nothing new;
 * it only re-judges what the store already has.
 */
async function runJobsReconcile(profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  const prefs = await loadPreferences(profile, root);
  const store = new JsonFileJobStore(join(root, dataDirFor(profile)));
  const all = await store.listJobs();
  const { rescued, stillFiltered } = reconcileFiltered(all, prefs);

  deps.stdout(`${all.filter((r) => r.state === "filtered").length} previously-filtered posting(s) checked against current rules.`);

  if (rescued.length === 0) {
    deps.stdout("None now pass. Nothing to score, nothing written.");
    return 0;
  }

  let candidate: CandidateProfile = { resume: "", notes: "" };
  let profileMissing: string | null = null;
  try {
    candidate = await loadProfile(profile, root);
  } catch (error) {
    if (error instanceof MissingProfileError) {
      profileMissing = error.message;
    } else {
      throw error;
    }
  }

  const scoringClient = profileMissing ? undefined : createScoringClientFromEnv();
  if (!profileMissing && !scoringClient) {
    deps.stderr("Claude Code CLI not found — rescued postings will be saved unscored.");
  }
  if (profileMissing) deps.stderr(profileMissing);
  const scoringUnavailableReason = profileMissing ? "no resume on file for this profile yet" : "Claude Code CLI not found on this Mac";

  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const ledger = new CostLedger(runId, join(root, COST_LOG_PATH));

  let scored: readonly JobRecord[] = [];
  let failures: readonly string[] = [];
  if (scoringClient) {
    const result = await scoreRecords(rescued, candidate, prefs, scoringClient, ledger);
    scored = result.scored;
    failures = result.failures;
  } else {
    failures = [`${rescued.length} rescued posting(s) not scored: ${scoringUnavailableReason}.`];
  }

  const scoredIds = new Set(scored.map((record) => record.id));
  const unscored = rescued.filter((record) => !scoredIds.has(record.id));
  await store.saveJobs([...scored, ...unscored, ...stillFiltered]);

  const ranked = sortByRank(scored, prefs);
  const aboveCutoff = ranked.filter((record) => (record.score ?? 0) >= prefs.scoreCutoff);
  const shortlisted = aboveCutoff.slice(0, prefs.digestLimit);
  const alsoSeen = ranked.filter((record) => !shortlisted.includes(record));
  const tokens = ledger.totalTokens();

  const summary: RunSummary = {
    runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    fetchedCount: 0,
    newCount: rescued.length,
    duplicateCount: 0,
    filteredCount: stillFiltered.length,
    filterReasons: summarizeRejections(stillFiltered),
    scoredCount: scored.length,
    shortlisted,
    alsoSeen,
    health: [],
    failures,
    costUsd: ledger.total(),
    inputTokens: tokens.input,
    outputTokens: tokens.output,
  };

  const markdown = renderDigest(summary).replace(
    "# Job digest",
    "# Job digest (reconciliation — re-checked previously-filtered postings, fetched nothing new)",
  );
  const digestDir = join(root, dataDirFor(profile), "digests");
  await mkdir(digestDir, { recursive: true });
  const stamp = summary.startedAt.replace(/[:.]/g, "-");
  await writeFile(join(digestDir, `reconcile-${stamp}.md`), markdown, "utf8");
  await writeFile(join(digestDir, "latest.md"), markdown, "utf8");
  await writeFile(join(digestDir, "latest.json"), JSON.stringify(digestPayload(summary), null, 2), "utf8");

  deps.stdout(markdown);
  deps.stdout("");
  deps.stdout(`${rescued.length} rescued, ${scored.length} scored, ${shortlisted.length} clear the cutoff.`);

  // Terminal step, per the standing NO-EMAILS rule (2026-10-04): the run
  // writes a chat package for the supervising agent to relay. It sends
  // nothing — no email, no SMS, no iMessage — and builds no tailored
  // resumes; those happen later, on the human's tap, outside this run.
  await writeChatPackage(profile, root, summary, deps.stdout, {
    filterVersion: `${prefs.experienceYearsFloor ?? "?"}-${prefs.experienceYearsCeiling ?? "?"}`
  });

  return 0;
}

/**
 * The feedback loop: reads whatever's new on either channel — email and
 * iMessage both — picks out messages that are genuinely the candidate
 * writing directly to us (see feedback.ts's looksLikeDirectMessage and
 * looksLikeDirectText — deliberately narrow, the same distinction
 * owner-forwarding.ts had to make once her full inbox started
 * auto-forwarding through this same mailbox), and for each one: applies any
 * preference change she asked for. The reply it would have sent is composed
 * and logged for the supervising agent to relay — the standing NO-EMAILS
 * rule (2026-10-04) means this loop never sends anything itself. Applied per Irtiza's
 * explicit Sep 16 call — no approval step — but "no approval step" and
 * "no guessing" are different rules: an ambiguous ask is reported back to
 * her as something to clarify, never silently guessed at (see feedback.ts's
 * own doc comment for why that distinction is load-bearing here).
 *
 * Config changes are committed and pushed immediately (commitAndPush) —
 * necessary because the scheduled pipeline run never runs `git pull`
 * first (see scripts/com.mobyai.jobsearch.plist), so an applied-but-
 * uncommitted change would vanish the moment anything else pulls or the
 * worktree is recreated. Both channels share this same apply-and-commit
 * step (applyFeedbackChanges below), since which channel she happened to
 * use has no bearing on how a change to preferences.json gets made durable.
 */
export async function runJobsCheckFeedback(profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  if (process.env["FEEDBACK_LOOP_ENABLED"] !== "true") return 0;

  const emailResult = await checkEmailFeedback(profile, root, deps);
  const imessageResult = await checkImessageFeedback(profile, root, deps);
  return Math.max(emailResult, imessageResult);
}

/**
 * Applies whichever of `changes` are well-typed and allow-listed, and —
 * only when at least one actually applied — writes preferences.json and
 * commits+pushes it. Shared by both feedback channels below so the
 * write/commit path (and its failure handling) exists in exactly one place.
 */
async function applyFeedbackChanges(
  profile: string,
  root: string,
  changes: readonly PatchEntry[],
  prefs: Awaited<ReturnType<typeof loadPreferences>>,
  deps: JobsCommandDeps,
): Promise<{ readonly applied: readonly PatchEntry[]; readonly rejected: readonly PatchEntry[] }> {
  if (changes.length === 0) return { applied: [], rejected: [] };

  const patchResult = applyFeedbackPatch(prefs, changes);
  if (patchResult.applied.length > 0) {
    const patch = Object.fromEntries(patchResult.applied.map((c) => [c.field, c.value]));
    const { rejectedKeys } = await savePreferences(profile, patch, root);
    if (rejectedKeys.length > 0) {
      deps.stderr(`Refused ${rejectedKeys.length} type-invalid preference ${rejectedKeys.length === 1 ? "key" : "keys"} (not written): ${rejectedKeys.join(", ")}`);
    }

    const commitMessage = `feedback(${profile}): ${patchResult.applied.map((c) => `${c.field} — "${c.quote}"`).join("; ")}`;
    const gitResult = commitAndPush(join(configDirFor(profile), "preferences.json"), commitMessage, root);
    if (gitResult.error) {
      deps.stderr(`Applied a preference change locally but git failed (${gitResult.error}) — it will not survive a re-pull until this is fixed.`);
    } else if (gitResult.committed) {
      deps.stdout(`Committed and pushed: ${commitMessage}`);
    }
  }

  return { applied: patchResult.applied, rejected: patchResult.rejected };
}

/**
 * Reads `digests/latest.json` — the structured payload `jobs run` and
 * `jobs reconcile` already write on every pass — so the feedback loop can
 * answer "what did you find today" and "why was X filtered out" from real
 * data instead of the four static facts it used to be limited to. Missing
 * or unparseable is treated as "no recent run data", never a guess.
 */
async function loadLatestDigestPayload(profile: string, root: string): Promise<DigestPayload | undefined> {
  try {
    const raw = await readFile(join(root, dataDirFor(profile), "digests", "latest.json"), "utf8");
    return JSON.parse(raw) as DigestPayload;
  } catch {
    // Missing file, or malformed JSON — either way, honest "no recent run
    // data" rather than a guess. isNotFoundError isn't needed to
    // distinguish the two cases since both are handled identically here.
    return undefined;
  }
}

/**
 * Merges both channel logs (email + iMessage) into one chronological
 * conversation, because she can text one day and email the next and a
 * reference like "make it higher" needs to resolve regardless of which
 * channel carried the turn it refers to. A record from before either log
 * carried messageText/replyBody (pre-dates this feature) is filtered out by
 * buildConversationHistory itself, not here.
 */
async function loadConversationHistory(profile: string, root: string, limit = 5): Promise<string> {
  const emailLog = new JsonFileFeedbackLog(join(root, dataDirFor(profile), "feedback"));
  const imessageLog = new JsonFileFeedbackLog(join(root, dataDirFor(profile), "feedback-imessage"));
  const [emailRecords, imessageRecords] = await Promise.all([emailLog.list(), imessageLog.list()]);

  const toTurn = (record: FeedbackRecord): ConversationTurn => ({
    processedAt: record.processedAt,
    messageText: record.messageText ?? "",
    appliedChanges: record.appliedChanges ?? [],
    replyBody: record.replyBody ?? "",
  });

  const turns = [...emailRecords, ...imessageRecords].map(toTurn).sort((a, b) => a.processedAt.localeCompare(b.processedAt));

  return buildConversationHistory(turns, limit);
}

async function checkEmailFeedback(profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  // The same address her digest goes to is the address whose direct
  // replies count as her own feedback — one identity, not a second env var
  // that could quietly drift from the first.
  const candidateEmail = process.env["DIGEST_EMAIL_TO"];
  if (!candidateEmail) {
    deps.stderr("FEEDBACK_LOOP_ENABLED is true but DIGEST_EMAIL_TO is not set — skipping the email feedback channel (no address to treat as her own).");
    return 1;
  }

  const inkboxClient = createInkboxClientFromEnv();
  if (!inkboxClient) {
    deps.stderr("FEEDBACK_LOOP_ENABLED is true but Inkbox is not configured — skipping the email feedback channel.");
    return 1;
  }

  const scoringClient = createScoringClientFromEnv();
  if (!scoringClient) {
    deps.stderr("FEEDBACK_LOOP_ENABLED is true but the Claude Code CLI was not found — cannot classify replies, skipping.");
    return 1;
  }

  const prefs = await loadPreferences(profile, root);
  const feedbackLog = new JsonFileFeedbackLog(join(root, dataDirFor(profile), "feedback"));
  const ledger = new CostLedger(randomUUID(), join(root, COST_LOG_PATH));
  const latestRun = await loadLatestDigestPayload(profile, root);
  const runContext = buildRunContext(prefs, latestRun);

  // searchMail can return snippet-level messages (confirmed Sep 14 — the
  // same characteristic alert-mail.ts had to work around) — every candidate
  // here gets re-fetched in full via getMessage before classification, never
  // classified off a truncated snippet.
  const candidates = await inkboxClient.searchMail();
  let processed = 0;

  for (const summary of candidates) {
    if (await feedbackLog.hasProcessed(summary.id)) continue;
    if (!looksLikeDirectMessage(summary, candidateEmail, inkboxClient.mailboxAddress)) continue;

    const full = (await inkboxClient.getMessage(summary.id)) ?? summary;
    // Reloaded per message, not once before the loop: if she sent more than
    // one message since the last check, an earlier one in this same pass
    // needs to already be in history by the time the next one is classified.
    const conversationHistory = await loadConversationHistory(profile, root);
    const classification = await classifyFeedback(full.body, prefs, runContext, scoringClient, prefs.scoringModel, ledger, conversationHistory);
    const { applied, rejected } = await applyFeedbackChanges(profile, root, classification.changes, prefs, deps);
    if (applied.length > 0) {
      deps.stdout(`Applied feedback from ${full.from.address}: ${applied.map((c) => `${c.field} -> ${JSON.stringify(c.value)}`).join(", ")}`);
    }

    const replyBody = buildFeedbackReplyBody(classification, applied, rejected, latestRun);
    // Standing NO-EMAILS rule (2026-10-04): the reply is composed and logged
    // for the supervising agent to relay — never sent.
    const replied = false;
    if (replyBody.length > 0) {
      deps.stdout(`Reply NOT sent to ${full.from.address} (standing NO-EMAILS rule) — logged for relay: ${replyBody.slice(0, 160)}`);
    }

    await feedbackLog.record({
      messageId: full.id,
      fromAddress: full.from.address,
      processedAt: new Date().toISOString(),
      appliedFields: applied.map((c) => c.field),
      messageText: full.body,
      appliedChanges: applied.map((c) => ({ field: c.field, value: c.value })),
      replyBody,
      hadQuestion: classification.hasQuestion,
      replied,
    });
    processed += 1;
  }

  if (processed === 0) deps.stdout("No new direct feedback emails found.");
  return 0;
}

/**
 * The iMessage twin of checkEmailFeedback above. Reuses DIGEST_IMESSAGE_TO
 * as her phone identity — same reasoning as reusing DIGEST_EMAIL_TO for the
 * email channel: one setting, not a second one that could quietly drift out
 * of sync — regardless of whether DIGEST_IMESSAGE_ENABLED (which only
 * controls the outbound daily-digest text) happens to be on; texting in
 * feedback and receiving the digest by text are independent choices.
 * Missing DIGEST_IMESSAGE_TO is treated as "she hasn't opted into texting
 * in feedback," not an error — unlike the email channel, which is the
 * primary channel and always expected to be configured.
 */
async function checkImessageFeedback(profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  const candidatePhone = process.env["DIGEST_IMESSAGE_TO"];
  if (!candidatePhone) return 0;

  const imessageClient = createImessageClientFromEnv();
  if (!imessageClient) {
    deps.stderr("DIGEST_IMESSAGE_TO is set but Inkbox iMessage is not configured (INKBOX_API_KEY/INKBOX_IDENTITY_ID) — skipping the iMessage feedback channel.");
    return 1;
  }

  const scoringClient = createScoringClientFromEnv();
  if (!scoringClient) {
    deps.stderr("FEEDBACK_LOOP_ENABLED is true but the Claude Code CLI was not found — cannot classify replies, skipping.");
    return 1;
  }

  const prefs = await loadPreferences(profile, root);
  const feedbackLog = new JsonFileFeedbackLog(join(root, dataDirFor(profile), "feedback-imessage"));
  const ledger = new CostLedger(randomUUID(), join(root, COST_LOG_PATH));
  const latestRun = await loadLatestDigestPayload(profile, root);
  const runContext = buildRunContext(prefs, latestRun);

  const messages = await imessageClient.listMessages();
  let processed = 0;

  for (const message of messages) {
    if (await feedbackLog.hasProcessed(message.id)) continue;
    if (!looksLikeDirectText(message, candidatePhone)) continue;

    // Reloaded per message, same reasoning as the email channel — and this
    // merges BOTH channel logs, so a change she made by email yesterday is
    // still visible when she texts a follow-up today.
    const conversationHistory = await loadConversationHistory(profile, root);
    const classification = await classifyFeedback(message.content, prefs, runContext, scoringClient, prefs.scoringModel, ledger, conversationHistory);
    const { applied, rejected } = await applyFeedbackChanges(profile, root, classification.changes, prefs, deps);
    if (applied.length > 0) {
      deps.stdout(`Applied feedback (text) from ${message.remoteNumber}: ${applied.map((c) => `${c.field} -> ${JSON.stringify(c.value)}`).join(", ")}`);
    }

    const replyBody = buildFeedbackReplyBody(classification, applied, rejected, latestRun);
    // Standing rule (2026-10-04): no autonomous texts/iMessages to personal
    // contacts. The reply is composed and logged for the supervising agent
    // to relay — never sent.
    const replied = false;
    if (replyBody.length > 0) {
      deps.stdout(`Reply NOT texted to ${candidatePhone} (standing rule: no autonomous texts to personal contacts) — logged for relay: ${replyBody.slice(0, 160)}`);
    }

    await feedbackLog.record({
      messageId: message.id,
      fromAddress: message.remoteNumber ?? candidatePhone,
      processedAt: new Date().toISOString(),
      appliedFields: applied.map((c) => c.field),
      messageText: message.content,
      appliedChanges: applied.map((c) => ({ field: c.field, value: c.value })),
      replyBody,
      hadQuestion: classification.hasQuestion,
      replied,
    });
    processed += 1;
  }

  if (processed === 0) deps.stdout("No new direct feedback texts found.");
  return 0;
}

/**
 * One-time-per-change enrichment, not part of the daily run: finds the
 * candidate's real Inkbox contact record (Inkbox already auto-creates one
 * from her inbound mail — this doesn't create a new one) via DIGEST_EMAIL_TO,
 * links DIGEST_IMESSAGE_TO's phone number onto it if that link doesn't
 * already exist, and tags it with a custom field naming this profile. Both
 * checks are idempotent — a phone already present, or a custom field with
 * the same label+value already present, is left alone rather than
 * duplicated on every re-run.
 *
 * Deliberately does not touch review_status/is_confirmed or try to
 * suppress retail-forwarding noise via contact rules — see
 * contact-client.ts's doc comment for why: neither is writable through
 * Inkbox's documented API today.
 */
async function runJobsEnrichContact(profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  const candidateEmail = process.env["DIGEST_EMAIL_TO"];
  if (!candidateEmail) {
    deps.stderr("DIGEST_EMAIL_TO is not set — no address to look her Inkbox contact up by.");
    return 1;
  }

  const contactClient = createContactClientFromEnv();
  if (!contactClient) {
    deps.stderr("INKBOX_API_KEY is not set — cannot reach Inkbox's contacts API.");
    return 1;
  }

  const matches = await contactClient.lookup({ email: candidateEmail });
  const existing = matches[0];
  if (!existing) {
    deps.stdout(`No Inkbox contact found for ${candidateEmail} yet — nothing to enrich. One is created automatically once mail from her arrives.`);
    return 0;
  }

  const patch: { phones?: Contact["phones"]; customFields?: Contact["customFields"] } = {};

  const candidatePhone = process.env["DIGEST_IMESSAGE_TO"];
  if (candidatePhone && !existing.phones.some((p) => normalizePhone(p.valueE164) === normalizePhone(candidatePhone))) {
    patch.phones = [...existing.phones, { valueE164: candidatePhone, label: "mobile", isPrimary: existing.phones.length === 0 }];
  }

  const tagLabel = "moby-role";
  const tagValue = `job-search-candidate:${profile}`;
  if (!existing.customFields.some((f) => f.label === tagLabel && f.value === tagValue)) {
    patch.customFields = [...existing.customFields, { label: tagLabel, value: tagValue }];
  }

  if (!patch.phones && !patch.customFields) {
    deps.stdout(`${existing.preferredName ?? candidateEmail}'s Inkbox contact (${existing.id}) is already up to date.`);
    return 0;
  }

  const updated = await contactClient.update(existing.id, patch);
  const changes = [patch.phones ? "linked her phone" : null, patch.customFields ? "added the profile tag" : null].filter((c): c is string => c !== null);
  deps.stdout(`Updated Inkbox contact ${updated.id} (${updated.preferredName ?? candidateEmail}): ${changes.join(", ")}.`);
  return 0;
}

async function printLatestDigest(profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  try {
    deps.stdout(await readFile(join(root, dataDirFor(profile), "digests", "latest.md"), "utf8"));
    return 0;
  } catch {
    deps.stderr(`No digest yet for ${profile}. Run \`orchestrator jobs run --profile ${profile}\` first.`);
    return 1;
  }
}

async function listSources(profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  const prefs = await loadPreferences(profile, root);
  const watchlist = await loadWatchlist(profile, root);
  const sources: Source[] = [...sourcesFromWatchlist(watchlist)];
  sources.push(createLinkedInPullSource(profile, root));

  const inkboxClient = createInkboxClientFromEnv();
  if (inkboxClient) {
    sources.push(createAlertMailSource(inkboxClient));
  } else {
    deps.stdout("(LinkedIn/Indeed alert-mail source not checked — INKBOX_API_KEY/INKBOX_MAILBOX_ADDRESS not set)");
  }

  const publicBoards = createPublicBoardSources(profile, prefs.titles, { onWarning: deps.stdout, root });
  // ADR 0028: the LinkedIn guest source only ever runs inside the single daily
  // pipeline run. This diagnostic fetches every source, so it must not include it.
  const checkable = publicBoards.sources.filter((source) => source.id !== LINKEDIN_GUEST_SOURCE_ID);
  if (checkable.length !== publicBoards.sources.length) {
    deps.stdout("(LinkedIn guest source not checked — it only runs inside the daily pipeline run, ADR 0028)");
  }
  sources.push(...checkable);
  if (publicBoards.adzunaSkipped) {
    deps.stdout("(Adzuna job board not checked — ADZUNA_APP_ID/ADZUNA_APP_KEY not set)");
  }

  if (sources.length === 0) {
    deps.stderr(`No sources configured in ${join(configDirFor(profile), "watchlist.json")}, and Inkbox is not set up.`);
    return 1;
  }

  deps.stdout(`${sources.length} source(s) configured. Checking each...`);
  let broken = 0;

  for (const source of sources) {
    try {
      const postings = await source.fetch();
      deps.stdout(`  ok        ${source.id} — ${postings.length} posting(s)`);
    } catch (error) {
      broken += 1;
      deps.stdout(`  BROKEN    ${source.id} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return broken > 0 ? 1 : 0;
}

async function printCosts(root: string, deps: JobsCommandDeps): Promise<number> {
  const entries = await readLedger(join(root, COST_LOG_PATH));
  if (entries.length === 0) {
    deps.stdout("No model spend recorded yet.");
    return 0;
  }

  const byRun = new Map<string, { cost: number; ts: string }>();
  for (const entry of entries) {
    const current = byRun.get(entry.runId) ?? { cost: 0, ts: entry.ts };
    byRun.set(entry.runId, { cost: current.cost + entry.costUsd, ts: current.ts });
  }

  const runs = [...byRun.entries()].sort((left, right) => left[1].ts.localeCompare(right[1].ts));
  for (const [runId, run] of runs.slice(-20)) {
    deps.stdout(`  ${run.ts.slice(0, 16).replace("T", " ")}  $${run.cost.toFixed(4)}  ${runId.slice(0, 8)}`);
  }

  const total = runs.reduce((sum, [, run]) => sum + run.cost, 0);
  deps.stdout("");
  deps.stdout(`${runs.length} run(s), $${total.toFixed(2)} total.`);
  return 0;
}

/**
 * The single kill-switch for every outbound send in this pipeline. Returns
 * false unconditionally: the standing NO-EMAILS rule (2026-10-04) bans all
 * autonomous outbound messages — email, SMS, iMessage — to anyone, and the
 * texting-lane rule bans autonomous texts/iMessages to personal contacts
 * (the candidate included). Exported so the test suite can pin it closed:
 * flipping this must be a deliberate, reviewed change, never an accident.
 */
export function outboundSendsPermitted(): boolean {
  return false;
}

/**
 * Digest SMS delivery — DISABLED by standing rule. The recipient
 * (DIGEST_SMS_TO) is the candidate's own phone (ADR 0016: "per Shivani's
 * own stated preference"), and autonomous texts to personal contacts are
 * banned. The pure formatter (formatDigestSms) is untouched — it still
 * describes the message that would have gone out. Exported so the test
 * suite can assert that even DIGEST_SMS_ENABLED=true fires nothing.
 */
export async function sendDigestSmsIfConfigured(summary: RunSummary, deps: JobsCommandDeps): Promise<void> {
  if (outboundSendsPermitted()) return;
  deps.stdout(
    `Digest SMS not sent to ${process.env["DIGEST_SMS_TO"] ?? "(unset)"} ` +
      `(standing rule: no autonomous texts to personal contacts) — ${summary.shortlisted.length} role(s) are in the chat package instead.`,
  );
}

/**
 * Digest iMessage delivery — DISABLED by standing rule. DIGEST_IMESSAGE_TO
 * is the candidate's own phone ("her phone identity"), and autonomous
 * iMessages to personal contacts are banned. Exported so the test suite can
 * assert that even DIGEST_IMESSAGE_ENABLED=true fires nothing.
 */
export async function sendDigestImessageIfConfigured(summary: RunSummary, deps: JobsCommandDeps): Promise<void> {
  if (outboundSendsPermitted()) return;
  deps.stdout(
    `Digest iMessage not sent to ${process.env["DIGEST_IMESSAGE_TO"] ?? "(unset)"} ` +
      `(standing rule: no autonomous texts to personal contacts) — ${summary.shortlisted.length} role(s) are in the chat package instead.`,
  );
}

/**
 * Digest email delivery — DISABLED by standing rule. NO outbound emails
 * from anyone, ever — full stop. The pure formatters
 * (formatDigestEmailSubject/Body) live on: the chat package reuses them for
 * shortlist.txt. Exported so the test suite can assert that even
 * DIGEST_EMAIL_ENABLED=true fires nothing.
 */
export async function sendDigestEmailIfConfigured(summary: RunSummary, deps: JobsCommandDeps): Promise<void> {
  if (outboundSendsPermitted()) return;
  deps.stdout(
    `Digest email not sent to ${process.env["DIGEST_EMAIL_TO"] ?? "(unset)"} ` +
      `(standing NO-EMAILS rule) — ${summary.shortlisted.length} role(s) are in the chat package instead.`,
  );
}

/**
 * Drafts a tailored resume variant for one job record and writes it to
 * `profile/<name>/tailored/<job-id>.md`. Draft-only: nothing here sends,
 * submits, or applies anywhere.
 *
 * Stage 11: every draft is born with an evidence ledger
 * (`profile/<name>/tailored/<job-id>.ledger.json`, status `pending-approval`)
 * that classifies each draft claim against the base resume
 * (confirmed / supportable / unsupported), and the application record starts
 * at `pending-approval`. Nothing becomes exportable/ready before
 * `jobs tailor --approve --job <id> --confirm`.
 *
 * `--approve --job <id>` renders the base-vs-tailored diff and flags the
 * unsupported claims for review; without `--confirm` it only renders.
 * `--confirm` is the explicit tap that marks the ledger (and the
 * application) ready.
 *
 * `--dry-run` prints the prompt and a cost estimate without touching the
 * API, so the prompt itself can be reviewed (and the spend sanity-checked)
 * before any money moves.
 */
async function runJobsTailor(
  profile: string,
  root: string,
  deps: JobsCommandDeps,
  args: readonly string[],
): Promise<number> {
  const jobId = parseJobFlag(args);
  if (!jobId) {
    deps.stderr("Which job? Pass --job <record-id> — the id of a job record under .orchestrator/jobs/<profile>/jobs/.");
    return 1;
  }

  if (args.includes("--approve")) {
    return runJobsTailorApprove(profile, root, deps, jobId, args.includes("--confirm"));
  }

  const dryRun = args.includes("--dry-run");

  const store = new JsonFileJobStore(join(root, dataDirFor(profile)));
  const job = (await store.listJobs()).find((record) => record.id === jobId);
  if (!job) {
    deps.stderr(`No job record with id "${jobId}" under ${join(dataDirFor(profile), "jobs")}/.`);
    return 1;
  }

  let resume: string;
  try {
    resume = (await loadProfile(profile, root)).resume;
  } catch (error) {
    if (error instanceof MissingProfileError) {
      deps.stderr(error.message);
      return 1;
    }
    throw error;
  }

  const prefs = await loadPreferences(profile, root);
  const executionModel = prefs.tailorSonnetExecution ? TAILOR_SONNET_MODEL : TAILOR_MODEL;

  if (dryRun) {
    // Round 1 (gap analysis) can be shown without a plan; round 2 needs one,
    // so the dry run shows its shape with a placeholder plan.
    const planRequest = gapAnalysisCompletionRequest(job, resume);
    deps.stdout("--- round 1 (gap analysis) system prompt ---");
    deps.stdout(planRequest.system);
    deps.stdout("--- round 1 user prompt ---");
    deps.stdout(planRequest.user);
    deps.stdout(
      `--- round 1 estimate: ~$${estimateTailorCost(planRequest, 400).toFixed(4)} ` +
        `(input tokens estimated from character count; no API call made)`,
    );
    const placeholderPlan = { gaps: ["<from round 1>"], plan: ["<from round 1>"] };
    const executeRequest = tailorCompletionRequest(job, resume, placeholderPlan, executionModel);
    deps.stdout("--- round 2 (execute plan) system prompt ---");
    deps.stdout(executeRequest.system);
    deps.stdout("--- round 2 user prompt ---");
    deps.stdout(executeRequest.user);
    deps.stdout(
      `--- round 2 estimate: ~$${estimateTailorCost(executeRequest).toFixed(4)} ` +
        `(input tokens estimated from character count, typical resume-length output assumed; no API call made)`,
    );
    deps.stdout(`--- execution model: ${executionModel}${prefs.tailorSonnetExecution ? " (tailorSonnetExecution is on)" : " (Haiku default; set tailorSonnetExecution to use Sonnet)"}`);
    return 0;
  }

  // Never a half-configured client: no key means no draft, not a quiet no-op.
  const client = createScoringClientFromEnv();
  if (!client) {
    deps.stderr("Claude Code CLI not found — tailoring needs a model to draft with.");
    return 1;
  }

  const draft = await draftTailoredResume(job, resume, client, { tailorSonnetExecution: prefs.tailorSonnetExecution });

  // Record ids are machine-generated, but treat them as filenames with
  // suspicion anyway — one unsanitized id must not escape the tailored dir.
  const safeId = jobId.replace(/[^a-zA-Z0-9-_.]/g, "_");
  const tailoredDir = join(root, profileDirFor(profile), TAILORED_DIR);
  await mkdir(tailoredDir, { recursive: true });
  const variantPath = join(tailoredDir, `${safeId}.md`);
  await writeFile(variantPath, draft.markdown, "utf8");

  // Stage 11: the evidence ledger is written with the draft and is born
  // pending-approval. Every claim in the draft is classified against the
  // exact base resume text the draft was made from — deterministically, no
  // model, no cost.
  const tailorLedger = buildLedger({
    jobId: job.id,
    jobTitle: job.title,
    company: job.company,
    resume,
    draftMarkdown: draft.markdown,
    draftPath: variantPath,
  });
  await writeTailorLedger(ledgerPathFor(tailoredDir, safeId), tailorLedger);
  if (tailorLedger.unsupportedCount > 0) {
    deps.stderr(
      `Heads up: ${tailorLedger.unsupportedCount} draft claim(s) could not be traced to the base resume — ` +
        `review them with \`jobs tailor --approve --job ${jobId}\` before approving.`,
    );
  }

  // Fills the records.ts slot this command exists for. A fresh draft always
  // (re)sets the application to pending-approval — fail closed: a new,
  // unreviewed draft must never inherit a previous approval.
  const existing = (await store.listApplications()).find((record) => record.jobId === job.id);
  if (existing) {
    await store.saveApplication({ ...existing, status: "pending-approval", resumeVariantPath: variantPath });
  } else {
    await store.saveApplication({
      id: randomUUID(),
      jobId: job.id,
      status: "pending-approval",
      appliedAt: null,
      resumeVariantPath: variantPath,
      coverLetterPath: null,
      followUpDueAt: null,
      outcome: null,
      rejectionReason: null,
      notes: [],
    });
  }

  const costLedger = new CostLedger(`tailor-${job.id}`, join(root, COST_LOG_PATH));
  for (const round of draft.rounds) {
    await costLedger.record(`tailor-${round.stage}`, round.model, {
      inputTokens: round.inputTokens,
      outputTokens: round.outputTokens,
    });
  }

  deps.stdout(`Wrote tailored draft to ${variantPath}`);
  deps.stdout(`Cost: $${draft.costUsd.toFixed(4)} (${draft.inputTokens} input / ${draft.outputTokens} output tokens)`);
  return 0;
}

/**
 * Stage 11 approval: renders the base-vs-tailored diff, flags every
 * unsupported claim from the evidence ledger, and — only with the explicit
 * `--confirm` tap — marks the ledger and the application ready. Without
 * `--confirm` this is review-only and changes nothing.
 */
export async function runJobsTailorApprove(
  profile: string,
  root: string,
  deps: JobsCommandDeps,
  jobId: string,
  confirm: boolean,
): Promise<number> {
  const safeId = jobId.replace(/[^a-zA-Z0-9-_.]/g, "_");
  const tailoredDir = join(root, profileDirFor(profile), TAILORED_DIR);
  const ledgerPath = ledgerPathFor(tailoredDir, safeId);

  let ledger;
  try {
    ledger = await readTailorLedger(ledgerPath);
  } catch {
    deps.stderr(`No evidence ledger at ${ledgerPath} — run \`jobs tailor --job ${jobId}\` first.`);
    return 1;
  }

  let resume: string;
  try {
    resume = (await loadProfile(profile, root)).resume;
  } catch (error) {
    if (error instanceof MissingProfileError) {
      deps.stderr(error.message);
      return 1;
    }
    throw error;
  }

  let draftMarkdown: string;
  try {
    draftMarkdown = await readFile(join(tailoredDir, `${safeId}.md`), "utf8");
  } catch {
    deps.stderr(`No draft at ${join(tailoredDir, `${safeId}.md`)} — run \`jobs tailor --job ${jobId}\` first.`);
    return 1;
  }

  deps.stdout(`## Review: tailored draft for "${ledger.jobTitle}" at ${ledger.company}`);
  deps.stdout(`Ledger: ${ledger.status}${ledger.approvedAt ? ` (approved ${ledger.approvedAt})` : ""}`);
  deps.stdout("");
  deps.stdout("### Base resume vs tailored draft");
  deps.stdout(renderResumeDiff(resume, draftMarkdown));
  deps.stdout("");

  const unsupported = ledger.claims.filter((claim) => claim.verdict === "unsupported");
  const supportable = ledger.claims.filter((claim) => claim.verdict === "supportable");
  deps.stdout(`### Claim check: ${ledger.claims.length} claims — ${ledger.claims.length - unsupported.length - supportable.length} confirmed, ${supportable.length} supportable, ${unsupported.length} unsupported`);
  if (unsupported.length > 0) {
    deps.stdout("");
    deps.stdout("⚠ UNSUPPORTED — these draft claims could not be traced to the base resume:");
    for (const claim of unsupported) {
      deps.stdout(`- "${claim.text}"${claim.evidence.length > 0 ? ` (${claim.evidence.join("; ")})` : ""}`);
    }
    deps.stdout("Fix or remove them before approving — an unsupported claim in a submitted resume is a fabrication.");
  } else {
    deps.stdout("Every claim traced to the base resume. Nothing unsupported.");
  }

  if (!confirm) {
    deps.stdout("");
    deps.stdout(`Review above. Re-run with \`--confirm\` to mark this draft ready — nothing changes until then.`);
    return 0;
  }

  if (ledger.status !== "pending-approval") {
    deps.stdout(`Already ${ledger.status}${ledger.approvedAt ? ` (approved ${ledger.approvedAt})` : ""} — nothing to do.`);
    return 0;
  }

  await writeTailorLedger(ledgerPath, approveLedger(ledger));

  const store = new JsonFileJobStore(join(root, dataDirFor(profile)));
  const application = (await store.listApplications()).find((record) => record.jobId === ledger.jobId);
  if (application && application.status === "pending-approval") {
    await store.saveApplication({ ...application, status: "materials_ready" });
    deps.stdout(`Application for "${ledger.jobTitle}" marked materials_ready.`);
  } else if (application) {
    deps.stdout(`Application status left at "${application.status}" — only a pending-approval application advances on this tap.`);
  } else {
    deps.stdout("No application record found; ledger marked ready, nothing else to advance.");
  }

  deps.stdout("Draft approved and marked ready.");
  return 0;
}

/** Serves the review queue. Read-only: no endpoint here can act on the outside world. */
async function serveDashboard(args: readonly string[], profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? Number.parseInt(args[portIndex + 1] ?? "", 10) : 8899;
  if (!Number.isFinite(port) || port <= 0) {
    deps.stderr("--port must be a positive number.");
    return 1;
  }

  const server = createJobsDashboardServer({ dataDir: join(root, dataDirFor(profile)) });
  // Bind localhost explicitly: this server has no auth, so a PORT/HOST
  // mis-set must never be able to expose it beyond this machine.
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  deps.stdout(`Job queue for ${profile}: http://localhost:${port}  (ctrl-c to stop)`);

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      server.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

/**
 * Stage 14 CRM commands. Every one of these is an explicit human tap that
 * records what SHE did — none of them sends, submits, or reaches the
 * network. See ADR 0021 for the boundary.
 */

/** Positional args with `--flag value` pairs stripped out. */
function positionalArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--profile" || arg === "--job" || arg === "--mbox") {
      i++;
      continue;
    }
    if (arg.startsWith("--")) continue;
    out.push(arg);
  }
  return out;
}

function parseMboxFlag(args: readonly string[]): string | undefined {
  const index = args.indexOf("--mbox");
  if (index === -1) return undefined;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

/**
 * `jobs applied --job <record-id>` — the explicit tap she makes after she
 * applied on the employer's own site. Creates (or advances) the application
 * record to `applied`, stamps the date, and schedules the first follow-up
 * nudge. The job record's state moves to `applied` alongside.
 */
async function runJobsApplied(
  profile: string,
  root: string,
  deps: JobsCommandDeps,
  args: readonly string[],
): Promise<number> {
  const jobId = parseJobFlag(args);
  if (!jobId) {
    deps.stderr("Which job? Pass --job <record-id> — the id of a job record under .orchestrator/jobs/<profile>/jobs/.");
    return 1;
  }
  const store = new JsonFileJobStore(join(root, dataDirFor(profile)));
  const jobRecord = (await store.listJobs()).find((record) => record.id === jobId);
  if (!jobRecord) {
    deps.stderr(`No job record with id "${jobId}" under ${join(dataDirFor(profile), "jobs")}/.`);
    return 1;
  }

  const now = new Date();
  const existing = (await store.listApplications()).find((record) => record.jobId === jobId);
  if (existing) {
    if (existing.status === "applied") {
      deps.stdout(`Already marked applied: ${jobRecord.title} @ ${jobRecord.company}.`);
      return 0;
    }
    try {
      await store.saveApplication(transitionApplication(existing, "applied", now));
    } catch (error) {
      deps.stderr(error instanceof Error ? error.message : String(error));
      return 1;
    }
  } else {
    const due = new Date(now);
    due.setDate(due.getDate() + FOLLOW_UP_AFTER_DAYS);
    await store.saveApplication({
      id: randomUUID(),
      jobId,
      status: "applied",
      appliedAt: now.toISOString(),
      resumeVariantPath: null,
      coverLetterPath: null,
      followUpDueAt: due.toISOString(),
      outcome: null,
      rejectionReason: null,
      notes: ["Marked applied by explicit tap (`jobs applied`)."],
    });
  }
  await store.saveJobs([{ ...jobRecord, state: "applied" }]);
  deps.stdout(
    `Marked applied: ${jobRecord.title} @ ${jobRecord.company}. ` +
      `Follow-up nudge scheduled in ${FOLLOW_UP_AFTER_DAYS} days (read-only reminder — nothing is sent).`,
  );
  return 0;
}

/**
 * `jobs stage <job-or-application-id> <stage>` — moves an application through
 * the explicit funnel. The id can be an application id or the job record id
 * it tracks. Illegal moves fail loudly with the allowed exits listed.
 */
async function runJobsStage(
  profile: string,
  root: string,
  deps: JobsCommandDeps,
  args: readonly string[],
): Promise<number> {
  const [id, stage] = positionalArgs(args);
  if (!id || !stage) {
    deps.stderr("Usage: jobs stage --profile <name> <job-or-application-id> <stage>");
    return 1;
  }
  const knownStages = Object.keys(APPLICATION_TRANSITIONS);
  if (!knownStages.includes(stage)) {
    deps.stderr(`Unknown stage "${stage}". Known stages: ${knownStages.join(", ")}.`);
    return 1;
  }
  const store = new JsonFileJobStore(join(root, dataDirFor(profile)));
  const applications = await store.listApplications();
  const application =
    applications.find((record) => record.id === id) ??
    applications.find((record) => record.jobId === id);
  if (!application) {
    deps.stderr(`No application with id or job id "${id}".`);
    return 1;
  }
  try {
    const updated = transitionApplication(application, stage as ApplicationStatus, new Date());
    await store.saveApplication(updated);
    // Keep the job record's coarse state in sync for the dashboard.
    const jobRecord = (await store.listJobs()).find((record) => record.id === application.jobId);
    if (jobRecord && (stage === "applied" || stage === "rejected")) {
      await store.saveJobs([{ ...jobRecord, state: stage }]);
    }
    deps.stdout(`Application ${application.id}: ${application.status} -> ${stage}.`);
    return 0;
  } catch (error) {
    deps.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/**
 * `jobs reject --job <record-id>` — rejects one posting. Sets the job
 * record to `rejected` and transitions any tracked application to
 * `rejected`. It does NOT mute the company — that is the separate
 * `jobs mute-company` action, and the output says so plainly.
 */
async function runJobsReject(
  profile: string,
  root: string,
  deps: JobsCommandDeps,
  args: readonly string[],
): Promise<number> {
  const jobId = parseJobFlag(args);
  if (!jobId) {
    deps.stderr("Which job? Pass --job <record-id>.");
    return 1;
  }
  const store = new JsonFileJobStore(join(root, dataDirFor(profile)));
  const jobRecord = (await store.listJobs()).find((record) => record.id === jobId);
  if (!jobRecord) {
    deps.stderr(`No job record with id "${jobId}".`);
    return 1;
  }
  await store.saveJobs([rejectPostingForJob(jobRecord)]);
  const application = (await store.listApplications()).find((record) => record.jobId === jobId);
  if (application && application.status !== "rejected") {
    try {
      await store.saveApplication(transitionApplication(application, "rejected", new Date()));
    } catch (error) {
      deps.stderr(`Posting rejected; application could not transition: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  deps.stdout(
    `Rejected posting: ${jobRecord.title} @ ${jobRecord.company}. ` +
      `The company is NOT muted — use \`jobs mute-company\` for that.`,
  );
  return 0;
}

/**
 * `jobs mute-company <name>` / `jobs unmute-company <name>` — the explicit
 * company-level action. Muted companies are excluded from every future run
 * (merged into the run's company exclusions); muting is stored separately
 * from preferences so it is auditable on its own.
 */
async function runJobsMuteCompany(
  profile: string,
  root: string,
  deps: JobsCommandDeps,
  args: readonly string[],
  mute: boolean,
): Promise<number> {
  const name = positionalArgs(args).join(" ").trim();
  if (!name) {
    deps.stderr(`Which company? Usage: jobs ${mute ? "mute-company" : "unmute-company"} --profile <name> <company>`);
    return 1;
  }
  if (mute) {
    const { added, muted } = await addMutedCompany(profile, root, name);
    deps.stdout(added ? `Muted ${name} — it will be excluded from future runs.` : `${name} was already muted.`);
    if (muted.length > 0) deps.stdout(`Currently muted: ${muted.join(", ")}`);
  } else {
    const { removed, muted } = await removeMutedCompany(profile, root, name);
    deps.stdout(removed ? `Unmuted ${name}.` : `${name} was not muted.`);
    if (muted.length > 0) deps.stdout(`Still muted: ${muted.join(", ")}`);
  }
  return 0;
}

/**
 * Syncs the morning LinkedIn pull's appliedHistory/savedJobs into
 * application records. Shared by `jobs run` (automatic, read-only) and
 * `jobs linkedin-sync` (on demand). Returns null when there is no pull data
 * to sync — not an error, just nothing to do.
 */
async function syncLinkedInForProfile(
  profile: string,
  root: string,
  store: JsonFileJobStore,
  deps: Pick<JobsCommandDeps, "stdout">,
): Promise<{ created: number; skipped: number } | null> {
  const pullDate = chicagoDateStamp(new Date());
  const history = await readAppliedHistory(profile, pullDate, root);
  const savedJobs = await readSavedJobs(profile, pullDate, root);
  if (history.length === 0 && savedJobs.length === 0) return null;
  const result = syncLinkedInApplications({
    existing: await store.listApplications(),
    history,
    savedJobs,
    jobs: await store.listJobs(),
    now: new Date(),
  });
  for (const record of result.created) {
    await store.saveApplication(record);
  }
  deps.stdout(
    `LinkedIn sync: ${result.created.length} application record(s) created from the pull, ` +
      `${result.skipped.length} already tracked. Rejections are never inferred from LinkedIn.`,
  );
  return { created: result.created.length, skipped: result.skipped.length };
}

async function runJobsLinkedInSync(profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  const store = new JsonFileJobStore(join(root, dataDirFor(profile)));
  const result = await syncLinkedInForProfile(profile, root, store, deps);
  if (!result) {
    deps.stdout("No LinkedIn pull data for today — nothing to sync.");
  }
  return 0;
}

/**
 * `jobs mail-scan --dry-run --mbox <messages.json>` — read-only scan of an
 * exported recruiting mailbox. Classifies messages, proposes links to
 * tracked applications, and prints the proposals. Writes nothing,
 * transitions nothing, sends nothing — --dry-run is required by design.
 */
async function runJobsMailScan(
  profile: string,
  root: string,
  deps: JobsCommandDeps,
  args: readonly string[],
): Promise<number> {
  if (!args.includes("--dry-run")) {
    deps.stderr("Refusing: mail-scan is read-only by design. Re-run with --dry-run --mbox <messages.json>.");
    return 1;
  }
  const mbox = parseMboxFlag(args);
  if (!mbox) {
    deps.stderr("Pass --mbox <messages.json> — the Gmail-side export (array of {id, from, subject, date, snippet}).");
    return 1;
  }
  let messages;
  try {
    messages = await new JsonFileMailReader(mbox).readMessages();
  } catch (error) {
    deps.stderr(`Could not read mail export: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const store = new JsonFileJobStore(join(root, dataDirFor(profile)));
  const proposals = proposeMailLinks(messages, await store.listApplications(), await store.listJobs());
  deps.stdout(renderMailScanReport(proposals));
  return 0;
}
