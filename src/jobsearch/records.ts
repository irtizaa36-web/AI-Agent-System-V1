/**
 * The three record types the job-search pipeline persists, plus the
 * preferences that drive its deterministic filters.
 *
 * Everything here is pure data. The rules that matter, encoded as types:
 * a salary that was never published is `null`, never a guess; a location we
 * could not classify is `"unknown"`, never optimistically `"remote"`; and a
 * requirement the candidate's resume does not support becomes a named `gap`
 * rather than quietly disappearing.
 */

/** What a Source hands back before any normalization. One posting, as published. */
export interface RawPosting {
  readonly sourceId: string;
  readonly url: string;
  readonly title: string;
  readonly company: string;
  readonly location: string;
  /** HTML or plain text, exactly as the source returned it. */
  readonly body: string;
  /** ISO date when the source says it was posted, when the source says at all. */
  readonly postedAt: string | null;
  /**
   * How many people have applied, when the source publishes it. Absent or
   * `null` means the source does not say — never zero, never guessed.
   */
  readonly applicantCount?: number | null;
  readonly fetchedAt: string;
}

export type LocationClass = "remote" | "hybrid" | "onsite" | "unknown";

/**
 * Which country a *remote* seat has to sit in, when the posting says. Only
 * meaningful when `locationClass` is `"remote"` — an onsite role's country is
 * just its location. `"unspecified"` means the posting named no country at
 * all (a bare "Remote"); it is never treated as `"us"` by assumption, the
 * same way an unpublished salary is never treated as adequate.
 */
export type RemoteRegion = "us" | "non-us" | "unspecified";

/**
 * Where a posting is in the pipeline. Transitions are made by code, never by
 * a model: `seen` on first sight, `filtered` when a deterministic rule
 * rejected it, `scored` once a model has judged it, `shortlisted` above the
 * cutoff. `applied` is only ever set by an explicit human action.
 */
export type JobState = "seen" | "filtered" | "scored" | "shortlisted" | "rejected" | "applied" | "closed";

export type Confidence = "low" | "medium" | "high";

/**
 * The six scoring dimensions (Stage 12). Each is the model's 0-100 judgment
 * on one axis: title/level fit, experience fit, skills coverage, location
 * fit, salary fit, and recency. Stored beside the composite `score`, never
 * instead of it — rank/cut read the composite by default, and the dimensions
 * exist so the digest can show the breakdown and a human can re-weight.
 * All-or-nothing: a partial set would mislead weighting, so a response that
 * doesn't carry all six valid numbers stores null here.
 */
export interface ScoreDimensions {
  readonly title: number;
  readonly experience: number;
  readonly skills: number;
  readonly location: number;
  readonly salary: number;
  readonly recency: number;
}

/** Human re-weighting for the six dimensions. Null (default) means the model's composite rules, unchanged. */
export interface ScoreWeights {
  readonly title: number;
  readonly experience: number;
  readonly skills: number;
  readonly location: number;
  readonly salary: number;
  readonly recency: number;
}

export const SCORE_DIMENSION_KEYS: ReadonlyArray<keyof ScoreDimensions> = [
  "title",
  "experience",
  "skills",
  "location",
  "salary",
  "recency",
];

export interface JobSource {
  readonly sourceId: string;
  readonly url: string;
  readonly fetchedAt: string;
}

export interface JobRecord {
  readonly id: string;
  /** SHA-256 over normalized content. The "never re-process a posting" key. */
  readonly contentHash: string;
  /** company + title + location class. The cross-source dedupe key. */
  readonly identityKey: string;
  readonly title: string;
  readonly company: string;
  readonly rawLocation: string;
  readonly locationClass: LocationClass;
  /** Only meaningful when `locationClass` is `"remote"`. See `RemoteRegion`. */
  readonly remoteRegion: RemoteRegion;
  /** `null` means the posting did not state it. Never inferred, never averaged. */
  readonly salaryMin: number | null;
  readonly salaryMax: number | null;
  readonly salaryCurrency: string | null;
  readonly postedAt: string | null;
  /**
   * Applicants so far, when a source publishes it. `null`/absent means unknown
   * (optional so records stored before this field existed still type-check).
   * Only ever used as a soft ranking boost — see `rank.ts`.
   */
  readonly applicantCount?: number | null;
  /** Years of experience the posting states it wants. `null` on either side means that bound was not stated — never guessed. */
  readonly experienceYearsMin: number | null;
  readonly experienceYearsMax: number | null;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** Every place this one role was found. Four entries here means one record, four links. */
  readonly sources: readonly JobSource[];
  readonly applyUrl: string;
  /** Path to the raw body on disk. Deliberately not inlined — raw HTML never enters a prompt. */
  readonly descriptionPath: string;
  /** The trimmed, signal-dense text the scorer actually sees. */
  readonly summary: string;
  readonly state: JobState;
  /** Which deterministic rule rejected it, when one did. */
  readonly filterReason: string | null;
  /**
   * Hash of the title rules in force when this record was filtered. A stored
   * `filtered` record whose version differs from the current one is
   * re-processed, so broadening the title list rescues old rejections.
   */
  readonly filterVersion?: string;
  readonly score: number | null;
  readonly confidence: Confidence | null;
  readonly rationale: string | null;
  /** Requirements the resume does not support. Stated plainly, never papered over. */
  readonly gaps: readonly string[];
  /**
   * The six per-axis scores beside the composite. `null` when the scoring
   * response didn't carry a valid full set (older runs, malformed
   * dimensions). Rank/cut use `effectiveScore` (score.ts), which reads the
   * composite unless the human set `scoreWeights` — so a null here never
   * changes behavior.
   */
  readonly scoreDimensions: ScoreDimensions | null;
}

export type ApplicationStatus =
  | "saved"
  | "queued"
  | "pending-approval"
  | "materials_ready"
  | "prefilled"
  | "submitted_by_human"
  | "applied"
  | "screening"
  | "interview"
  | "offer"
  | "responded"
  | "rejected"
  | "withdrawn";

/**
 * Where an application record came from. `"pipeline"` is the default for
 * records the tailoring flow creates (absent on older records means the
 * same); `"linkedin"` marks records synced from the supervised LinkedIn
 * pull's applied/saved history — her real LinkedIn applications, not ours.
 */
export type ApplicationSource = "pipeline" | "linkedin";

export interface ApplicationRecord {
  readonly id: string;
  readonly jobId: string;
  /**
   * Never advances to `submitted_by_human` except by an explicit human
   * action in the dashboard. No code path in this repository sets it.
   */
  readonly status: ApplicationStatus;
  readonly appliedAt: string | null;
  readonly resumeVariantPath: string | null;
  readonly coverLetterPath: string | null;
  readonly followUpDueAt: string | null;
  readonly outcome: string | null;
  readonly rejectionReason: string | null;
  readonly notes: readonly string[];
  /** Absent means `"pipeline"` — older records were all created that way. */
  readonly source?: ApplicationSource;
}

export type AtsType = "greenhouse" | "lever" | "ashby" | "feed";

/** Enrichment cached per company, so a role at a known employer costs nothing to enrich. */
export interface CompanyRecord {
  readonly id: string;
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly domain: string | null;
  readonly atsType: AtsType | null;
  readonly atsBoardToken: string | null;
  readonly sizeBand: string | null;
  readonly fundingStage: string | null;
  readonly remotePolicy: string | null;
  readonly redFlags: readonly string[];
  readonly onWatchlist: boolean;
  readonly enrichedAt: string | null;
  readonly enrichmentTtlDays: number;
}

/** One entry in a profile's config/job-search/<profile>/watchlist.json. */
export interface WatchlistEntry {
  readonly company: string;
  readonly atsType: AtsType;
  /** Greenhouse/Lever/Ashby board token, or the feed URL for `feed`. */
  readonly boardToken: string;
  /**
   * Optional per-board freshness window in days, overriding the global
   * `maxPostingAgeDays` for this entry. Fast boards and slow feeds have
   * different freshness profiles — set this from the board's measured live
   * age distribution, never guessed. Absent means the global default.
   */
  readonly maxAgeDays?: number;
  /**
   * Optional priority flag: this company's roles surface first in the
   * digest under "Priority companies" (a monitored lane on the existing
   * adapters, not a separate source). Absent/false means the normal sweep.
   */
  readonly priority?: boolean;
}

/** config/job-search/<profile>/preferences.json — the deterministic filters, as data. */
export interface Preferences {
  /** The target title cluster. A posting must match one of these to survive stage 6. */
  readonly titles: readonly string[];
  /** Title substrings that reject outright (e.g. "intern", "vp of"). */
  readonly titleExclusions: readonly string[];
  /** Reject a posting whose stated maximum falls below this. A posting that states nothing is flagged, not rejected. */
  readonly salaryFloor: number | null;
  readonly salaryCurrency: string;
  /** When true, only `remote` postings survive. `metros` then re-admits onsite/hybrid roles in named places. */
  readonly remoteOnly: boolean;
  /** Metro names that re-admit non-remote roles. Empty means remote-only, full stop. */
  readonly metros: readonly string[];
  /**
   * Ranks `metros` (and the literal entry `"Remote"`) by preference — a role
   * matching an earlier entry outranks one matching a later entry, even at
   * an equal score. Purely a display-order nudge (see `rank.ts`): it never
   * excludes a role and never changes the stored score. Empty means every
   * matching location ranks the same.
   */
  readonly locationPriority: readonly string[];
  /** Points per priority-list position, applied in `rank.ts`. Kept small on purpose — a real score difference should still win. */
  readonly locationPriorityStep: number;
  /**
   * A posting's stated experience-years requirement must overlap this
   * [floor, ceiling] band to survive stage 6 (an OVERLAP check, not an exact
   * match — a posting asking for "3-8 years" still overlaps a [3,6] band).
   * Either side `null` disables that bound. A posting that states no years
   * requirement at all is NEVER rejected by this — same "don't guess" rule
   * as the salary floor. Named differently from JobRecord's
   * experienceYearsMin/Max on purpose: those are what a POSTING states;
   * these are what SHE wants.
   */
  readonly experienceYearsFloor: number | null;
  readonly experienceYearsCeiling: number | null;
  /**
   * Hard cap on a posting's stated MINIMUM years of experience: a posting
   * whose minimum is strictly greater than this is dropped. `null` disables
   * the cap. A posting that states no years requirement is never dropped.
   * Independent of (and applied alongside) the floor/ceiling overlap band.
   */
  readonly maxRequiredYearsExperience: number | null;
   * Cap on what an open-ended experience floor ("5+ years", read as
   * min=5, max=null) is allowed to imply. A posting that says "5+" really
   * means "5 and up, unbounded", so the normal overlap check treats it as
   * reaching to infinity and a senior 12-year role would pass a [3,6] band.
   * When this is set, an open-ended floor whose stated minimum exceeds it
   * rejects: "8+" against a [3,6] band with a cap of 6 rejects, while "4+"
   * still overlaps. `null` (default) preserves the historical behavior —
   * open floors are never rejected on implied years alone.
   */
  readonly maxImpliedExperienceYears: number | null;

  /**
   * Reject a posting whose stated post date is older than this many days.
   * `null` disables the check. A posting with no stated date at all is
   * never rejected by this — same "don't guess" rule as everywhere else.
   */
  readonly maxPostingAgeDays: number | null;
  /**
   * A posting with a known applicant count BELOW this gets `lowApplicantRankBonus`
   * added to its display-order rank. A soft preference only: an unknown count
   * (the usual case) is never excluded and never penalized.
   */
  readonly lowApplicantThreshold: number;
  /** Points added to the display-order rank for a low-applicant posting. 0 disables. */
  readonly lowApplicantRankBonus: number;
  /**
   * When true, a `remote` posting is rejected if it names a specific
   * non-US country and no US option (`RemoteRegion` `"non-us"`) — e.g.
   * "Remote - India" or "Remote - Netherlands". A posting naming no country
   * at all (`"unspecified"`) is never rejected on this alone: the same
   * "don't guess" rule that applies to an unstated salary applies here.
   * Meaningless when `remoteOnly` is false.
   */
  readonly usRemoteOnly: boolean;
  readonly industryExclusions: readonly string[];
  readonly companyExclusions: readonly string[];
  /** Minimum score to reach the digest's main list. */
  readonly scoreCutoff: number;
  /**
   * Human re-weighting for the six scoring dimensions (Stage 12). `null`
   * (default) means the model's composite rules and cut/rank behavior is
   * exactly what it was before dimensions existed. When set, the effective
   * score is the weighted average of the stored dimensions (weights are
   * normalized, so they need not sum to 1) — but only for records that
   * actually carry dimensions; anything else falls back to the composite.
   */
  readonly scoreWeights: ScoreWeights | null;
  /**
   * Round-2 tailoring model gate (Stage 12). `false` (default) executes the
   * tailoring plan with Haiku; `true` upgrades round 2 to Sonnet. Round 1
   * (gap analysis + plan) is always Haiku.
   */
  readonly tailorSonnetExecution: boolean;
  /**
   * Points subtracted from a role's DISPLAY-ORDER rank (never from its
   * stored `score`, and never from whether it clears `scoreCutoff`) when it
   * doesn't state a salary. Nudges pay-transparent roles toward the top of
   * the digest without excluding or re-scoring the rest — per Irtiza's
   * "de-prioritize, don't exclude" call.
   */
  readonly unstatedSalaryRankPenalty: number;
  /** How many roles the digest shows before collapsing the rest into "also seen". */
  readonly digestLimit: number;
  /** Token budget per posting handed to the scorer. */
  readonly postingTokenBudget: number;
  /** How many postings go into one batched scoring call. */
  readonly scoringBatchSize: number;
  /** Model used for batch scoring. */
  readonly scoringModel: string;
  /** Round 2 of `jobs tailor` uses Sonnet when true, Haiku (default) when false. Round 1 is always Haiku. */
  readonly tailorSonnetExecution: boolean;
  /** Days to keep raw posting bodies on disk before pruning. The JobRecord is kept forever. */
  readonly rawRetentionDays: number;
}

export const DEFAULT_PREFERENCES: Preferences = {
  titles: [],
  titleExclusions: ["intern", "internship", "co-op", "contractor", "temporary"],
  salaryFloor: null,
  salaryCurrency: "USD",
  remoteOnly: true,
  metros: [],
  locationPriority: [],
  locationPriorityStep: 2,
  experienceYearsFloor: null,
  experienceYearsCeiling: null,
  maxRequiredYearsExperience: null,
  maxImpliedExperienceYears: null,

  maxPostingAgeDays: null,
  lowApplicantThreshold: 200,
  lowApplicantRankBonus: 3,
  usRemoteOnly: false,
  industryExclusions: [],
  companyExclusions: [],
  scoreCutoff: 65,
  scoreWeights: null,
  tailorSonnetExecution: false,
  unstatedSalaryRankPenalty: 3,
  digestLimit: 8,
  postingTokenBudget: 600,
  scoringBatchSize: 15,
  scoringModel: "claude-haiku-4-5",
  tailorSonnetExecution: false,
  rawRetentionDays: 90,
};
