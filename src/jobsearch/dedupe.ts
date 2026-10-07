import type { JobRecord } from "./records";

/**
 * Stage 5: the same role cross-posted to four sites becomes one record
 * carrying four links.
 *
 * Merging keeps the record that was seen first — its id, its state, and any
 * score it already earned all survive — and unions the new sighting into it.
 * That ordering matters: a role rediscovered on a second board must not
 * reset to `seen` and get re-scored, which is exactly the kind of quiet
 * re-processing the content hash exists to prevent.
 */

export interface DedupeResult {
  /** Records that are genuinely new, ready for filtering and scoring. */
  readonly fresh: readonly JobRecord[];
  /** Existing records that gained a new source link or a newer `lastSeenAt`. */
  readonly merged: readonly JobRecord[];
  /** Postings dropped because their content hash was already known. */
  readonly duplicateCount: number;
}

/** Merges one incoming sighting into an existing record. */
export function mergeSighting(existing: JobRecord, incoming: JobRecord): JobRecord {
  // Dedupe the union through a Set: the same posting re-crawled must not
  // append a duplicate link, whether the duplicate comes from the stored
  // record or from within the incoming sighting's own source list.
  const knownUrls = new Set(existing.sources.map((source) => source.url));
  const addedSources = incoming.sources.filter((source) => {
    if (knownUrls.has(source.url)) return false;
    knownUrls.add(source.url);
    return true;
  });

  return {
    ...existing,
    lastSeenAt: incoming.lastSeenAt > existing.lastSeenAt ? incoming.lastSeenAt : existing.lastSeenAt,
    sources: [...existing.sources, ...addedSources],
    // Same "prefer the more specific answer" rule as salary: a board that
    // stated no country and one that named "Remote - US" describe the same
    // role, and the specific answer wins regardless of which sighting arrived
    // first.
    remoteRegion: existing.remoteRegion !== "unspecified" ? existing.remoteRegion : incoming.remoteRegion,
    // A posting that first appeared without a salary and later states one is
    // new information worth keeping. The reverse — a stated salary being
    // replaced by null — is not, so nulls never overwrite a real figure.
    salaryMin: existing.salaryMin ?? incoming.salaryMin,
    salaryMax: existing.salaryMax ?? incoming.salaryMax,
    salaryCurrency: existing.salaryCurrency ?? incoming.salaryCurrency,
    postedAt: existing.postedAt ?? incoming.postedAt,
    // Applicant counts only grow, so the newer sighting's figure wins; a null never overwrites a known one.
    applicantCount: incoming.applicantCount ?? existing.applicantCount ?? null,
  };
}

/**
 * Splits a run's normalized postings into what is new and what we already
 * had. `known` is everything the store holds; callers pass the whole set
 * because both keys must be checked — the content hash catches the identical
 * posting, the identity key catches the same role worded differently
 * elsewhere.
 */
export function dedupe(
  incoming: readonly JobRecord[],
  known: readonly JobRecord[],
  filterVersion?: string,
): DedupeResult {
  const byHash = new Map<string, JobRecord>();
  const byIdentity = new Map<string, JobRecord>();
  for (const record of known) {
    byHash.set(record.contentHash, record);
    byIdentity.set(record.identityKey, record);
  }

  const freshById = new Map<string, JobRecord>();
  const mergedById = new Map<string, JobRecord>();
  // Roles first seen during THIS run are indexed separately from stored ones.
  // Folding them into byHash/byIdentity would send the second sighting down
  // the "merge into a stored record" path, writing a second, divergent record
  // for a role that has only ever been seen in this run.
  const freshByHash = new Map<string, string>();
  const freshByIdentity = new Map<string, string>();
  let duplicateCount = 0;

  for (const record of incoming) {
    const freshId = freshByHash.get(record.contentHash) ?? freshByIdentity.get(record.identityKey);
    if (freshId) {
      duplicateCount += 1;
      const base = freshById.get(freshId) as JobRecord;
      const combined = mergeSighting(base, record);
      freshById.set(freshId, combined);
      // The new sighting's own keys must also point at the surviving record,
      // or a third sighting matching only the second one starts a duplicate.
      freshByHash.set(record.contentHash, freshId);
      freshByIdentity.set(record.identityKey, freshId);
      continue;
    }

    const existing = byHash.get(record.contentHash) ?? byIdentity.get(record.identityKey);
    if (existing) {
      const base = mergedById.get(existing.id) ?? existing;
      const combined = mergeSighting(base, record);
      const staleFiltered =
        existing.state === "filtered" && filterVersion !== undefined && existing.filterVersion !== filterVersion;
      if (existing.state === "seen" || staleFiltered) {
        // Never scored (scoring unavailable/failed that run), or filtered under
        // an older title list: re-enter the pipeline under the stored id
        // instead of merging away. saveJobs upserts by id, so no duplicate.
        freshById.set(existing.id, { ...combined, id: existing.id, state: "seen", filterReason: null });
        freshByHash.set(record.contentHash, existing.id);
        freshByIdentity.set(record.identityKey, existing.id);
      } else {
        duplicateCount += 1;
        mergedById.set(existing.id, combined);
      }
      continue;
    }

    freshById.set(record.id, record);
    freshByHash.set(record.contentHash, record.id);
    freshByIdentity.set(record.identityKey, record.id);
  }

  return { fresh: [...freshById.values()], merged: [...mergedById.values()], duplicateCount };
}
