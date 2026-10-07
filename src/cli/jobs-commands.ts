import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runPipeline } from "../jobsearch/pipeline";
import { renderDigest, digestPayload, type DigestPayload, type RunSummary } from "../jobsearch/digest";
import { sourcesFromWatchlist } from "../jobsearch/sources/registry";
import { JsonFileJobStore } from "../store/job-store";
import { createScoringClientFromEnv } from "../jobsearch/scoring-client";
import { CostLedger, readLedger } from "../jobsearch/cost";
import { createJobsDashboardServer } from "../jobsearch/dashboard";
import { createAlertMailSource } from "../jobsearch/sources/alert-mail";
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
  "  enrich-contact --profile <name>|--all   Link DIGEST_IMESSAGE_TO's phone to the candidate's Inkbox contact record (found via DIGEST_EMAIL_TO) and tag it with this profile. Idempotent; safe to re-run.",
  "  digest --profile <name>      Print the most recent digest without running the pipeline",
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
    default:
      deps.stdout(USAGE);
      return subcommand === undefined || subcommand === "help" ? 0 : 1;
  }
}

async function runJobsRun(profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  const prefs = await loadPreferences(profile, root);
  const watchlist = await loadWatchlist(profile, root);
  const inkboxClient = createInkboxClientFromEnv();

  if (watchlist.length === 0 && !inkboxClient) {
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
    deps.stderr("ANTHROPIC_API_KEY is not set — running discovery only, scoring will be skipped.");
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
      ? "no ANTHROPIC_API_KEY configured"
      : undefined;

  // Adds LinkedIn/Indeed coverage via forwarded alert emails (ADR 0013,
  // ADR 0015) when Inkbox is configured. Silently absent otherwise — never
  // a half-configured source, same pattern as the scoring client above.
  const sources: Source[] = [...sourcesFromWatchlist(watchlist)];
  if (inkboxClient) sources.push(createAlertMailSource(inkboxClient));

  const summary = await runPipeline({
    sources,
    store: new JsonFileJobStore(join(root, dataDirFor(profile))),
    prefs,
    profile: candidate,
    scoringClient,
    scoringUnavailableReason,
    costLogPath: join(root, COST_LOG_PATH),
  });

  const markdown = renderDigest(summary);
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
    filterVersion: `${prefs.experienceYearsFloor ?? "?"}-${prefs.experienceYearsCeiling ?? "?"}`,
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
    deps.stderr("ANTHROPIC_API_KEY is not set — rescued postings will be saved unscored.");
  }
  if (profileMissing) deps.stderr(profileMissing);
  const scoringUnavailableReason = profileMissing ? "no resume on file for this profile yet" : "no ANTHROPIC_API_KEY configured";

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

  // Same terminal step as runJobsRun above: chat package, never a send.
  await writeChatPackage(profile, root, summary, deps.stdout, {
    filterVersion: `${prefs.experienceYearsFloor ?? "?"}-${prefs.experienceYearsCeiling ?? "?"}`,
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
 * rule (2026-10-04) means this loop never sends anything itself.
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
    await savePreferences(profile, patch, root);

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
    deps.stderr("FEEDBACK_LOOP_ENABLED is true but ANTHROPIC_API_KEY is not set — cannot classify replies, skipping.");
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
    deps.stderr("FEEDBACK_LOOP_ENABLED is true but ANTHROPIC_API_KEY is not set — cannot classify replies, skipping.");
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
  const watchlist = await loadWatchlist(profile, root);
  const sources: Source[] = [...sourcesFromWatchlist(watchlist)];

  const inkboxClient = createInkboxClientFromEnv();
  if (inkboxClient) {
    sources.push(createAlertMailSource(inkboxClient));
  } else {
    deps.stdout("(LinkedIn/Indeed alert-mail source not checked — INKBOX_API_KEY/INKBOX_MAILBOX_ADDRESS not set)");
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

/** Serves the review queue. Read-only: no endpoint here can act on the outside world. */
async function serveDashboard(args: readonly string[], profile: string, root: string, deps: JobsCommandDeps): Promise<number> {
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? Number.parseInt(args[portIndex + 1] ?? "", 10) : 8899;
  if (!Number.isFinite(port) || port <= 0) {
    deps.stderr("--port must be a positive number.");
    return 1;
  }

  const server = createJobsDashboardServer({ dataDir: join(root, dataDirFor(profile)) });
  await new Promise<void>((resolve) => server.listen(port, resolve));
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
