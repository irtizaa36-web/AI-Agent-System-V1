import { test } from "node:test";
import assert from "node:assert/strict";
import { applicantBonus, locationBonus, rankKey, sortByRank } from "./rank";
import { DEFAULT_PREFERENCES, type JobRecord, type Preferences } from "./records";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    contentHash: "hash-1",
    identityKey: "acme::marketing manager::remote",
    title: "Marketing Manager",
    company: "Acme",
    rawLocation: "Remote - US",
    locationClass: "remote",
    remoteRegion: "us",
    salaryMin: null,
    salaryMax: null,
    salaryCurrency: null,
    postedAt: null,
    experienceYearsMin: null,
    experienceYearsMax: null,
    firstSeenAt: "2026-09-13T08:00:00.000Z",
    lastSeenAt: "2026-09-13T08:00:00.000Z",
    sources: [],
    applyUrl: "https://a.test/1",
    descriptionPath: "/tmp/1.html",
    summary: "Own demand gen.",
    state: "scored",
    filterReason: null,
    score: 70,
    confidence: "high",
    rationale: "Good fit.",
    gaps: [],
    scoreDimensions: null,
    ...overrides,
  };
}

const prefs: Preferences = { ...DEFAULT_PREFERENCES, unstatedSalaryRankPenalty: 8 };

test("rankKey subtracts the penalty only when salary is unstated", () => {
  assert.equal(rankKey(job({ score: 70 }), prefs), 62);
  assert.equal(rankKey(job({ score: 70, salaryMin: 100000, salaryMax: 120000 }), prefs), 70);
});

test("rankKey never changes the record's own score field — only the sort key", () => {
  const record = job({ score: 70 });
  rankKey(record, prefs);
  assert.equal(record.score, 70, "the stored score must stay the model's honest judgment");
});

test("a strong unstated-pay match still beats a weak stated-pay one", () => {
  const strongUnstated = job({ id: "a", score: 78 });
  const weakStated = job({ id: "b", score: 68, salaryMin: 90000, salaryMax: 100000 });

  const [first] = sortByRank([weakStated, strongUnstated], prefs);
  assert.equal(first?.id, "a", "78 - 8 = 70 still beats 68");
});

test("two close scores favor the pay-transparent one", () => {
  const unstated = job({ id: "a", score: 75 });
  const stated = job({ id: "b", score: 72, salaryMin: 130000, salaryMax: 150000 });

  const [first] = sortByRank([unstated, stated], prefs);
  assert.equal(first?.id, "b", "75 - 8 = 67, which is below the stated role's 72");
});

test("the default penalty (3) preserves a real 4-point gap — the Snowflake/Notion case that prompted weakening it", () => {
  // First live run used penalty 8: Snowflake's GTM & Enablement PM (82,
  // unstated) got outranked by Notion's Partner Marketing Manager (78,
  // $235k-260k stated) — an 82 vs 78 gap is real signal, not noise, and
  // Irtiza asked to weaken the nudge so it doesn't override that. At the
  // default of 3, Snowflake's rank key (79) stays above Notion's (78).
  const snowflakeUnstated = job({ id: "snowflake", score: 82 });
  const notionStated = job({ id: "notion", score: 78, salaryMin: 235000, salaryMax: 260000 });

  const [first] = sortByRank([snowflakeUnstated, notionStated], DEFAULT_PREFERENCES);
  assert.equal(first?.id, "snowflake", "a 4-point quality gap should still win on merit at the weakened penalty");
});

test("a penalty of 0 disables de-prioritization entirely — pure score order", () => {
  const off: Preferences = { ...prefs, unstatedSalaryRankPenalty: 0 };
  const unstated = job({ id: "a", score: 75 });
  const stated = job({ id: "b", score: 72, salaryMin: 130000, salaryMax: 150000 });

  const [first] = sortByRank([unstated, stated], off);
  assert.equal(first?.id, "a");
});

test("sortByRank is a stable sort — equal keys keep their original order", () => {
  const first = job({ id: "a", score: 70 });
  const second = job({ id: "b", score: 70 });
  const result = sortByRank([first, second], prefs);
  assert.deepEqual(result.map((r) => r.id), ["a", "b"]);
});

test("sortByRank does not mutate the input array", () => {
  const records = [job({ id: "a", score: 60 }), job({ id: "b", score: 90 })];
  const original = [...records];
  sortByRank(records, prefs);
  assert.deepEqual(records, original);
});

// Location priority, per Shivani's feedback: Houston, Remote, Dallas, New
// York, in that order of preference.
const locationPrefs: Preferences = { ...prefs, locationPriority: ["Houston", "Remote", "Dallas", "New York"], locationPriorityStep: 2 };

test("locationBonus gives the top-priority entry the largest bonus", () => {
  const houston = job({ rawLocation: "Houston, TX", locationClass: "onsite" });
  const dallas = job({ rawLocation: "Dallas, TX", locationClass: "onsite" });
  const newYork = job({ rawLocation: "New York, NY", locationClass: "onsite" });

  assert.equal(locationBonus(houston, locationPrefs), 6); // tier 0 of 4: (4-1-0)*2
  assert.equal(locationBonus(dallas, locationPrefs), 2); // tier 2 of 4: (4-1-2)*2
  assert.equal(locationBonus(newYork, locationPrefs), 0); // last tier: (4-1-3)*2
});

test("locationBonus matches a generic remote role by locationClass, not by city name", () => {
  const remote = job({ rawLocation: "Remote - US", locationClass: "remote" });
  assert.equal(locationBonus(remote, locationPrefs), 4); // tier 1 of 4: (4-1-1)*2
});

test("a remote role explicitly for a named city matches that city's tier, not the generic Remote tier", () => {
  // Houston comes before Remote in the priority list, so a role that is
  // both — remote, but specifically for someone in Houston — should get
  // Houston's higher bonus, not Remote's lower one.
  const remoteHouston = job({ rawLocation: "Remote - Houston, TX", locationClass: "remote" });
  assert.equal(locationBonus(remoteHouston, locationPrefs), 6);
});

test("an unmatched location gets no bonus", () => {
  const chicago = job({ rawLocation: "Chicago, IL", locationClass: "onsite" });
  assert.equal(locationBonus(chicago, locationPrefs), 0);
});

test("locationBonus is 0 when the priority list is empty — a no-op by default", () => {
  const houston = job({ rawLocation: "Houston, TX", locationClass: "onsite" });
  assert.equal(locationBonus(houston, prefs), 0);
});

test("the location bonus and the salary penalty stack in rankKey", () => {
  const houstonUnstated = job({ rawLocation: "Houston, TX", locationClass: "onsite", score: 70 });
  // rankKey = 70 (score) - 8 (unstated salary penalty) + 6 (Houston bonus) = 68
  assert.equal(rankKey(houstonUnstated, locationPrefs), 68);
});

test("a real location preference can flip two close scores toward the preferred city", () => {
  const dallasStrong = job({ id: "a", rawLocation: "Dallas, TX", locationClass: "onsite", score: 74 });
  const houstonWeaker = job({ id: "b", rawLocation: "Houston, TX", locationClass: "onsite", score: 70 });

  // Dallas: 74 + 2 = 76. Houston: 70 + 6 = 76. A tie — order falls back to
  // original array order, so this documents the boundary rather than
  // asserting a specific winner.
  const [first] = sortByRank([dallasStrong, houstonWeaker], locationPrefs);
  assert.equal(first?.id, "a");
});

// Applicant-count preference: soft boost under the threshold, never a filter or penalty.
test("applicantBonus boosts a posting with fewer than 200 applicants", () => {
  assert.equal(applicantBonus(job({ applicantCount: 199 }), prefs), prefs.lowApplicantRankBonus);
  assert.equal(applicantBonus(job({ applicantCount: 0 }), prefs), prefs.lowApplicantRankBonus);
  assert.equal(rankKey(job({ score: 70, applicantCount: 50 }), prefs), rankKey(job({ score: 70 }), prefs) + prefs.lowApplicantRankBonus);
});

test("applicantBonus gives nothing at or above the threshold", () => {
  assert.equal(applicantBonus(job({ applicantCount: 200 }), prefs), 0);
  assert.equal(applicantBonus(job({ applicantCount: 5000 }), prefs), 0);
});

test("a missing applicant count is neutral: no boost, no penalty, no crash", () => {
  assert.equal(applicantBonus(job({ applicantCount: null }), prefs), 0);
  const { applicantCount: _omitted, ...legacy } = job();
  assert.equal(applicantBonus(legacy as JobRecord, prefs), 0);
  assert.equal(rankKey(job({ score: 70, applicantCount: null }), prefs), rankKey(job({ score: 70 }), prefs));
});

test("a low-applicant role wins a near-tie, but a big score gap still wins on merit", () => {
  const few = job({ id: "few", score: 70, applicantCount: 40 });
  const unknown = job({ id: "unknown", score: 71 });
  assert.equal(sortByRank([unknown, few], prefs)[0]?.id, "few");
  const strong = job({ id: "strong", score: 85 });
  assert.equal(sortByRank([few, strong], prefs)[0]?.id, "strong");
});

test("the applicant preference never excludes: every record survives sorting", () => {
  const records = [job({ id: "a", applicantCount: 900 }), job({ id: "b", applicantCount: null }), job({ id: "c", applicantCount: 5 })];
  assert.equal(sortByRank(records, prefs).length, 3);
});

test("rankKey reads the effective score: default weights keep composite ordering", () => {
  const withDims = job({
    id: "a",
    rawLocation: "Remote",
    locationClass: "remote",
    salaryMin: 100000,
    salaryMax: 120000,
    score: 70,
    scoreDimensions: { title: 95, experience: 80, skills: 80, location: 80, salary: 80, recency: 80 },
  });
  assert.equal(rankKey(withDims, prefs), 70, "no weights: rankKey is the composite");
})

test("rankKey follows human re-weighting through the effective score", () => {
  const weighted: Preferences = {
    ...prefs,
    scoreWeights: { title: 1, experience: 0, skills: 0, location: 0, salary: 0, recency: 0 },
  };
  const withDims = job({
    id: "a",
    rawLocation: "Remote",
    locationClass: "remote",
    salaryMin: 100000,
    salaryMax: 120000,
    score: 70,
    scoreDimensions: { title: 95, experience: 50, skills: 50, location: 50, salary: 50, recency: 50 },
  });
  assert.equal(rankKey(withDims, weighted), 95, "re-weighted rankKey reads the title dimension");
  assert.equal(rankKey(withDims, prefs), 70, "same record, default prefs: composite again");
})
