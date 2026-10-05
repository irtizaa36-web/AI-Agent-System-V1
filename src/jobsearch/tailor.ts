import type { JobRecord } from "./records";
import type { CompletionRequest, ScoringClient } from "./scoring-client";
import { costOf } from "./cost";

/**
 * Drafts a tailored resume variant for one scored job posting — in two
 * rounds (Stage 12). Round 1 (Haiku) analyzes the posting against the base
 * resume and returns a gap analysis + tailoring plan as structured JSON;
 * round 2 executes that plan (Haiku by default, Sonnet when
 * `tailorSonnetExecution` is set).
 *
 * This fills the `ApplicationRecord.resumeVariantPath` field (records.ts) that
 * the records layer declared but nothing generated — until this module, there
 * was a slot for a tailored resume and no way to produce one.
 *
 * The port is the same `ScoringClient` the scoring path uses (same client
 * setup, same Claude Code CLI, same error handling in scoring-client.ts) —
 * no new client class, because drafting needs nothing scoring's port doesn't
 * already provide. Round 1 is always the cheapest capable model; round 2
 * defaults there too, per the standing policy for drafting work.
 */

export const TAILOR_MODEL = "claude-haiku-4-5";

/** Round-2 execution model when the human gates the upgrade on (`tailorSonnetExecution`). */
export const TAILOR_SONNET_MODEL = "claude-sonnet-5";

/** Round 1 (gap analysis + plan) is always Haiku: analysis is cheap, judgment-light work. */
export const TAILOR_PLAN_MODEL = TAILOR_MODEL;

/** Output budget for one resume draft. A resume is long-form prose, not a scored JSON row. */
export const TAILOR_MAX_TOKENS = 4000;

/**
 * Rough chars-per-token for pre-call cost estimates. It is an estimate,
 * stated as one — never a number a ledger is built from.
 */
const ESTIMATED_CHARS_PER_TOKEN = 4;

/** Subdirectory under the profile dir where drafts are written. */
export const TAILORED_DIR = "tailored";

export interface TailorDraft {
  /** The model's text with the draft stamp header prepended. */
  readonly markdown: string;
  /** The round-2 execution model (Haiku default, Sonnet when pref-gated). */
  readonly model: string;
  /** Totals across both rounds. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Dollars for both calls, from the same pricing table as the scoring ledger. */
  readonly costUsd: number;
  /** The round-1 plan the draft was executed from — kept for the ledger and --dry-run. */
  readonly plan: TailoringPlan;
  /** Per-round usage, so the cost ledger records each call honestly. */
  readonly rounds: readonly TailorRoundUsage[];
}

export interface TailorRoundUsage {
  readonly stage: "gap-analysis" | "execute";
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
}

/** Round 1's output: what the resume doesn't cover, and the concrete plan for round 2. */
export interface TailoringPlan {
  /** Posting requirements the base resume does not support, stated plainly. */
  readonly gaps: readonly string[];
  /** Concrete tailoring steps (reorder / reword / emphasize), each referencing real resume content. */
  readonly plan: readonly string[];
}

/**
 * The stable rules half of the prompt. Hard no-fabrication rules live here,
 * in the cached system block, so they cannot drift between drafts and cannot
 * be diluted by a long user turn: the model is told, every time, what it may
 * not invent and what it must say plainly.
 */
export function buildTailorSystemPrompt(): string {
  return [
    "You are drafting a tailored resume variant from a candidate's REAL base resume and one job posting.",
    "",
    "Rules — these are absolute:",
    "- NEVER invent experience, employers, titles, dates, metrics, degrees, certifications, or skills. Every single bullet must be traceable to something written in the base resume.",
    "- What you MAY do: reorder sections and bullets, reword phrasing, and emphasize or expand the parts of the resume most relevant to this posting.",
    "- Keep the name, contact info, and every employer/title/date exactly as written in the base resume. Do not merge or split roles.",
    "- If the posting's level or title implies scope the resume does not show, say so in Gaps — do not inflate the resume to match.",
    "- End with a \"## Gaps\" section naming each requirement the posting states that the resume does not cover. If the resume genuinely covers everything stated, say so plainly instead.",
    "- This output is a DRAFT for the candidate's own review before any submission. It is never auto-submitted and never sent anywhere.",
    "",
    "Format: the full resume in Markdown, mirroring the base resume's structure (summary, experience, skills, education), followed by \"## Gaps\" as the final section. Return ONLY the resume markdown — no preamble, no commentary.",
  ].join("\n");
}

function describeExperience(job: JobRecord): string {
  if (job.experienceYearsMin === null && job.experienceYearsMax === null) return "not stated";
  if (job.experienceYearsMin !== null && job.experienceYearsMax !== null)
    return `${job.experienceYearsMin}–${job.experienceYearsMax} years`;
  if (job.experienceYearsMin !== null) return `${job.experienceYearsMin}+ years`;
  return `up to ${job.experienceYearsMax} years`;
}

function describeSalary(job: JobRecord): string {
  if (job.salaryMin === null && job.salaryMax === null) return "not stated";
  const currency = job.salaryCurrency ?? "USD";
  if (job.salaryMin !== null && job.salaryMax !== null)
    return `${job.salaryMin.toLocaleString()}–${job.salaryMax.toLocaleString()} ${currency}`;
  if (job.salaryMin !== null) return `${job.salaryMin.toLocaleString()}+ ${currency}`;
  return `up to ${job.salaryMax?.toLocaleString()} ${currency}`;
}

/**
 * The varying half of the prompt: the job as data, then the base resume
 * verbatim. The resume is included in full on purpose — the model may only
 * reframe what it can actually read, so the complete source text is the
 * fabrication boundary. Raw posting HTML never enters the prompt; the
 * trimmed `summary` the scorer saw is the input here too.
 */
export function buildTailorUserPrompt(job: JobRecord, resume: string): string {
  return [
    "## The job",
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.rawLocation} (${job.locationClass})`,
    `Compensation: ${describeSalary(job)}`,
    `Experience sought: ${describeExperience(job)}`,
    "",
    "Posting summary:",
    job.summary,
    "",
    "## The base resume (verbatim — reframe it, never invent beyond it)",
    "",
    resume,
  ].join("\n");
}

/** One CompletionRequest for the draft execution. Kept separate so tests can inspect the prompt without a client. */
export function tailorCompletionRequest(job: JobRecord, resume: string, plan: TailoringPlan, model: string): CompletionRequest {
  return {
    model,
    system: buildExecutionSystemPrompt(plan),
    user: buildTailorUserPrompt(job, resume),
    maxTokens: TAILOR_MAX_TOKENS,
  };
}

/**
 * Round 1 (Stage 12): gap analysis + tailoring plan, always Haiku. The
 * analyst reads the posting against the base resume and returns structured
 * JSON — gaps the resume doesn't cover, and a concrete plan for round 2.
 * Separating analysis from drafting is what keeps round 2 honest: the
 * drafter executes a plan grounded in the resume instead of improvising
 * one mid-draft.
 */
export function buildGapAnalysisSystemPrompt(): string {
  return [
    "You are analyzing a job posting against a candidate's REAL base resume. You are NOT writing a resume — you are producing a tailoring plan for a later drafting step.",
    "",
    "Rules — these are absolute:",
    "- NEVER invent experience, employers, titles, dates, metrics, degrees, certifications, or skills. Reference only what is written in the base resume.",
    "- \"gaps\": every requirement the posting states that the base resume does not support. Name each plainly. An empty list means the resume genuinely covers everything stated.",
    "- \"plan\": concrete tailoring steps for the drafter — which sections/bullets to emphasize, reword, or reorder, and why. Every step must reference real resume content. If a gap cannot be closed honestly, the plan must say to leave it in the Gaps section, not to paper over it.",
    "",
    "Return ONLY JSON, no prose and no code fences, shaped exactly:",
    "{\"gaps\":[\"...\"],\"plan\":[\"...\"]}",
  ].join("\n");
}

export function buildGapAnalysisUserPrompt(job: JobRecord, resume: string): string {
  return [
    "## The job",
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.rawLocation} (${job.locationClass})`,
    `Compensation: ${describeSalary(job)}`,
    `Experience sought: ${describeExperience(job)}`,
    "",
    "Posting summary:",
    job.summary,
    "",
    "## The base resume (verbatim)",
    "",
    resume,
  ].join("\n");
}

/** One CompletionRequest for round 1. Kept separate so tests can inspect the prompt without a client. */
export function gapAnalysisCompletionRequest(job: JobRecord, resume: string): CompletionRequest {
  return {
    model: TAILOR_PLAN_MODEL,
    system: buildGapAnalysisSystemPrompt(),
    user: buildGapAnalysisUserPrompt(job, resume),
    maxTokens: 1500,
  };
}

/**
 * Parses round 1's JSON. Strict about the shape — a malformed plan fails the
 * tailor run loudly rather than letting round 2 draft unplanned (an
 * unplanned draft is exactly the one-round behavior Stage 12 retires).
 */
export function parseGapAnalysisResponse(text: string): TailoringPlan {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`gap analysis did not return JSON: ${cleaned.slice(0, 200)}`);
  }
  const obj = parsed as Record<string, unknown>;
  const gaps = Array.isArray(obj["gaps"]) ? obj["gaps"].filter((g): g is string => typeof g === "string") : null;
  const plan = Array.isArray(obj["plan"]) ? obj["plan"].filter((p): p is string => typeof p === "string") : null;
  if (!gaps || !plan || plan.length === 0) {
    throw new Error("gap analysis returned no usable plan — refusing to draft unplanned");
  }
  return { gaps, plan };
}

/**
 * Round 2's system prompt: the standing no-fabrication rules plus the
 * round-1 plan to execute. The drafter follows the plan; the plan was built
 * from the resume, so the draft stays inside the fabrication boundary.
 */
export function buildExecutionSystemPrompt(plan: TailoringPlan): string {
  return [
    buildTailorSystemPrompt(),
    "",
    "## The tailoring plan (from the gap analysis — execute it)",
    "",
    ...plan.plan.map((step, index) => `${index + 1}. ${step}`),
    "",
    "Gaps the analysis found (these belong in the draft's ## Gaps section, not papered over):",
    ...(plan.gaps.length > 0 ? plan.gaps.map((gap) => `- ${gap}`) : ["- (none — the resume covers the stated requirements)"]),
  ].join("\n");
}

/**
 * The header stamped onto every draft. It says what the file is (a draft),
 * what it is for (her review), and what it must never be (submitted) — so a
 * file found out of context cannot be mistaken for a finished resume.
 */
export function stampDraftHeader(job: JobRecord, draftBody: string, now = new Date()): string {
  return [
    `# DRAFT — tailored resume for "${job.title}" at ${job.company}`,
    "",
    `> **Draft for the candidate's review — do not submit.** Generated ${now.toISOString()} from the base resume on file against job record \`${job.id}\`. Every bullet traces to the base resume; uncovered requirements are named in the "## Gaps" section.`,
    "",
    draftBody.trim(),
    "",
  ].join("\n");
}

/**
 * Pre-call cost estimate for `--dry-run`: approximate the input tokens from
 * character count, assume a typical resume-length output, and price it with
 * the same table the ledger uses. Labeled an estimate everywhere it appears.
 */
export function estimateTailorCost(request: CompletionRequest, assumedOutputTokens = 2000): number {
  const inputTokens = Math.ceil((request.system.length + request.user.length) / ESTIMATED_CHARS_PER_TOKEN);
  return costOf(request.model, { inputTokens, outputTokens: assumedOutputTokens });
}

/** Draft one tailored resume variant in two rounds. Throws exactly how the client's API errors say it throws. */
export async function draftTailoredResume(
  job: JobRecord,
  resume: string,
  client: ScoringClient,
  options: { readonly now?: Date; readonly tailorSonnetExecution?: boolean } = {},
): Promise<TailorDraft> {
  const now = options.now ?? new Date();

  // Round 1: Haiku analyzes the posting against the resume and plans the tailoring.
  const planRequest = gapAnalysisCompletionRequest(job, resume);
  const planResult = await client.complete(planRequest);
  const plan = parseGapAnalysisResponse(planResult.text);
  const planRound: TailorRoundUsage = {
    stage: "gap-analysis",
    model: planRequest.model,
    inputTokens: planResult.usage.inputTokens,
    outputTokens: planResult.usage.outputTokens,
    costUsd: costOf(planRequest.model, planResult.usage),
  };

  // Round 2: execute the plan. Haiku by default; Sonnet only behind the preference flag.
  const executionModel = options.tailorSonnetExecution ? TAILOR_SONNET_MODEL : TAILOR_MODEL;
  const executeRequest = tailorCompletionRequest(job, resume, plan, executionModel);
  const executeResult = await client.complete(executeRequest);
  const executeRound: TailorRoundUsage = {
    stage: "execute",
    model: executeRequest.model,
    inputTokens: executeResult.usage.inputTokens,
    outputTokens: executeResult.usage.outputTokens,
    costUsd: costOf(executeRequest.model, executeResult.usage),
  };

  const inputTokens = planRound.inputTokens + executeRound.inputTokens;
  const outputTokens = planRound.outputTokens + executeRound.outputTokens;
  return {
    markdown: stampDraftHeader(job, executeResult.text, now),
    model: executionModel,
    inputTokens,
    outputTokens,
    costUsd: planRound.costUsd + executeRound.costUsd,
    plan,
    rounds: [planRound, executeRound],
  };
}
