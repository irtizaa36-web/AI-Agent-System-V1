import { test } from "node:test";
import assert from "node:assert/strict";
import { applyFilters, salaryUnknown, summarizeRejections } from "./filter";
import { parseExperienceYears } from "./normalize";
import { DEFAULT_PREFERENCES, type JobRecord, type Preferences } from "./records";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    contentHash: "hash-1",
    identityKey: "acme::marketing manager::remote",
    title: "Marketing Manager",
    company: "Acme",
    rawLocation: "Remote",
    locationClass: "remote",
    remoteRegion: "unspecified",
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
    summary: "Own demand generation for the growth team.",
    state: "seen",
    filterReason: null,
    score: null,
    confidence: null,
    rationale: null,
    gaps: [],
    scoreDimensions: null,
    ...overrides,
  };
}

const prefs: Preferences = { ...DEFAULT_PREFERENCES, titles: ["marketing manager", "growth manager"] };

test("a remote role with a matching title passes", () => {
  assert.equal(applyFilters(job(), prefs).passed, true);
});

test("a title outside the configured list is NOT rejected; fit is judged at scoring", () => {
  const outcome = applyFilters(job({ title: "Partnerships Lead, Retail Media" }), prefs);
  assert.equal(outcome.passed, true);
  assert.equal(outcome.reason, null);
});

test("titles are only a soft signal: an unrelated title still passes the deterministic filters", () => {
  assert.equal(applyFilters(job({ title: "Staff Backend Engineer" }), prefs).passed, true);
  assert.equal(applyFilters(job({ title: "Staff Backend Engineer" }), { ...prefs, titles: [] }).passed, true);
});

test("title exclusions and the other hard filters still reject", () => {
  assert.equal(applyFilters(job({ title: "Marketing Intern" }), prefs).passed, false);
  assert.equal(applyFilters(job({ locationClass: "onsite", rawLocation: "Chicago, IL" }), prefs).passed, false);
});

test("an onsite role is rejected under remote-only", () => {
  const outcome = applyFilters(job({ locationClass: "onsite", rawLocation: "Chicago, IL" }), prefs);
  assert.equal(outcome.passed, false);
  assert.match(outcome.reason ?? "", /Not remote/);
});

test("a named metro re-admits an onsite role", () => {
  const outcome = applyFilters(job({ locationClass: "onsite", rawLocation: "Chicago, IL" }), {
    ...prefs,
    metros: ["Chicago"],
  });
  assert.equal(outcome.passed, true);
});

test("a posting below the stated salary floor is rejected with the numbers in the reason", () => {
  const outcome = applyFilters(job({ salaryMin: 70000, salaryMax: 80000, salaryCurrency: "USD" }), {
    ...prefs,
    salaryFloor: 120000,
  });
  assert.equal(outcome.passed, false);
  assert.match(outcome.reason ?? "", /80,000/);
  assert.match(outcome.reason ?? "", /120,000/);
});

test("a posting that states NO salary passes the floor and is flagged unknown, never guessed", () => {
  const record = job();
  const outcome = applyFilters(record, { ...prefs, salaryFloor: 120000 });

  assert.equal(outcome.passed, true, "silence about pay is not evidence of low pay");
  assert.equal(salaryUnknown(record), true);
});

test("an excluded title and an excluded company are both rejected", () => {
  assert.equal(applyFilters(job({ title: "Marketing Manager Intern" }), prefs).passed, false);
  assert.equal(applyFilters(job(), { ...prefs, companyExclusions: ["Acme Inc."] }).passed, false);
});

test("an industry exclusion matches on the posting body", () => {
  const outcome = applyFilters(job({ summary: "Own demand gen for our sports betting brand." }), {
    ...prefs,
    industryExclusions: ["sports betting"],
  });
  assert.equal(outcome.passed, false);
  assert.match(outcome.reason ?? "", /Industry excluded/);
});

test("usRemoteOnly rejects a remote posting with a specific non-US region and no US option", () => {
  const outcome = applyFilters(job({ rawLocation: "Remote - India", remoteRegion: "non-us" }), {
    ...prefs,
    usRemoteOnly: true,
  });
  assert.equal(outcome.passed, false);
  assert.match(outcome.reason ?? "", /not eligible from the US/);
  assert.match(outcome.reason ?? "", /Remote - India/);
});

test("usRemoteOnly passes a remote posting that states a US region", () => {
  const outcome = applyFilters(job({ rawLocation: "Remote - US", remoteRegion: "us" }), {
    ...prefs,
    usRemoteOnly: true,
  });
  assert.equal(outcome.passed, true);
});

test("usRemoteOnly never rejects on a guess — a bare Remote with no stated country still passes", () => {
  const outcome = applyFilters(job({ rawLocation: "Remote", remoteRegion: "unspecified" }), {
    ...prefs,
    usRemoteOnly: true,
  });
  assert.equal(outcome.passed, true, "an unlabeled remote posting is not evidence it excludes the US");
});

test("usRemoteOnly has no effect on an onsite role — that's the plain remote-only gate's job", () => {
  const outcome = applyFilters(job({ locationClass: "onsite", rawLocation: "Chicago, IL", remoteRegion: "unspecified" }), {
    ...prefs,
    usRemoteOnly: true,
  });
  assert.equal(outcome.passed, false);
  assert.match(outcome.reason ?? "", /Not remote/, "rejected for not being remote, not for region");
});

test("usRemoteOnly is a no-op when turned off, even on a non-US remote role", () => {
  const outcome = applyFilters(job({ rawLocation: "Remote - India", remoteRegion: "non-us" }), {
    ...prefs,
    usRemoteOnly: false,
  });
  assert.equal(outcome.passed, true);
});

// The level cap Irtiza asked for after reviewing the first real digest: cap
// at Senior/current level by rejecting a step above it. These are the exact
// two titles that made him ask for it, plus a check that Senior itself
// still passes.
const levelCapPrefs: Preferences = {
  ...prefs,
  titleExclusions: ["intern", "internship", "co-op", "contractor", "temporary", "principal", "director", "vp", "president", "head of", "chief"],
};

test("the level cap rejects the two real Principal-level roles that prompted it", () => {
  const gitlabRole = job({ title: "Principal Program Manager, Go-To-Market" });
  const snowflakeRole = job({ title: "Principal Business Operations Manager, Ops & AI Tooling" });

  assert.equal(applyFilters(gitlabRole, levelCapPrefs).passed, false);
  assert.equal(applyFilters(snowflakeRole, levelCapPrefs).passed, false);
});

test("the level cap leaves Senior — her current level — untouched", () => {
  const outcome = applyFilters(job({ title: "Senior Marketing Manager" }), levelCapPrefs);
  assert.equal(outcome.passed, true);
});

test("the level cap also catches Director, VP (and its SVP/EVP/AVP variants), and Chief", () => {
  for (const title of ["Director of Marketing", "VP, Marketing", "SVP, Marketing", "Chief Marketing Officer"]) {
    assert.equal(applyFilters(job({ title }), levelCapPrefs).passed, false, `expected "${title}" to be rejected`);
  }
});

test('the level cap catches "Vice President" spelled out, via the "president" entry', () => {
  assert.equal(applyFilters(job({ title: "Vice President, Marketing" }), levelCapPrefs).passed, false);
});

// Experience-years band, per Shivani's feedback: her resume shows 5 years,
// and she wants roles asking for 3-7 years (widened from 3-6 on Toozy's
// 2026-10-04 call) — not a step up in seniority requirement, and not a step
// down into entry-level. Hard boundaries: any stated figure past the
// ceiling kills the posting.
const experiencePrefs: Preferences = { ...prefs, experienceYearsFloor: 3, experienceYearsCeiling: 7 };

test("a posting wanting more experience than the ceiling is rejected", () => {
  const outcome = applyFilters(job({ experienceYearsMin: 8, experienceYearsMax: null }), experiencePrefs);
  assert.equal(outcome.passed, false);
  assert.match(outcome.reason ?? "", /8\+ years.*above the 7-year ceiling/);
});

test("a posting wanting less experience than the floor is rejected", () => {
  const outcome = applyFilters(job({ experienceYearsMin: 0, experienceYearsMax: 1 }), experiencePrefs);
  assert.equal(outcome.passed, false);
  assert.match(outcome.reason ?? "", /at most 1 years.*below the 3-year floor/);
});

test("a posting whose stated range touches 7 survives — '5-7' and '3-7' are in-band", () => {
  assert.equal(applyFilters(job({ experienceYearsMin: 5, experienceYearsMax: 7 }), experiencePrefs).passed, true);
  assert.equal(applyFilters(job({ experienceYearsMin: 3, experienceYearsMax: 7 }), experiencePrefs).passed, true);
});

test("a posting whose stated max exceeds the ceiling is rejected — no more overlap admissions", () => {
  // "3-8 years" used to survive on overlap; under the locked 3-7 band it dies.
  const outcome = applyFilters(job({ experienceYearsMin: 3, experienceYearsMax: 8 }), experiencePrefs);
  assert.equal(outcome.passed, false);
  assert.match(outcome.reason ?? "", /up to 8 years.*above the 7-year ceiling/);
  assert.equal(applyFilters(job({ experienceYearsMin: 6, experienceYearsMax: 8 }), experiencePrefs).passed, false);
  assert.equal(applyFilters(job({ experienceYearsMin: 5, experienceYearsMax: 8 }), experiencePrefs).passed, false);
});

test("an open-ended '7+' posting is rejected — its floor sits at the ceiling", () => {
  const outcome = applyFilters(job({ experienceYearsMin: 7, experienceYearsMax: null }), experiencePrefs);
  assert.equal(outcome.passed, false);
  assert.match(outcome.reason ?? "", /7\+ years.*above the 7-year ceiling/);
});

test("an open-ended '5+' posting survives — an unstated max is not evidence of a mismatch", () => {
  assert.equal(applyFilters(job({ experienceYearsMin: 5, experienceYearsMax: null }), experiencePrefs).passed, true);
});

test("a posting stating no years requirement at all is never rejected — same rule as the salary floor", () => {
  const outcome = applyFilters(job({ experienceYearsMin: null, experienceYearsMax: null }), experiencePrefs);
  assert.equal(outcome.passed, true, "silence about years is not evidence of a mismatch");
});

test("the experience band is a no-op when neither floor nor ceiling is configured", () => {
  const outcome = applyFilters(job({ experienceYearsMin: 15, experienceYearsMax: null }), prefs);
  assert.equal(outcome.passed, true);
});

// Recency, per Shivani's feedback: surface recently posted roles.
test("a posting older than the age limit is rejected, with its age in the reason", () => {
  const now = new Date("2026-09-13T00:00:00.000Z");
  const outcome = applyFilters(
    job({ postedAt: "2026-08-01T00:00:00.000Z" }),
    { ...prefs, maxPostingAgeDays: 14 },
    now,
  );
  assert.equal(outcome.passed, false);
  assert.match(outcome.reason ?? "", /43 days ago, older than the 14-day limit/);
});

test("a posting within the age limit passes", () => {
  const now = new Date("2026-09-13T00:00:00.000Z");
  const outcome = applyFilters(
    job({ postedAt: "2026-09-10T00:00:00.000Z" }),
    { ...prefs, maxPostingAgeDays: 14 },
    now,
  );
  assert.equal(outcome.passed, true);
});

test("a posting with no stated date is never rejected by the age limit — same 'don't guess' rule", () => {
  const now = new Date("2026-09-13T00:00:00.000Z");
  const outcome = applyFilters(job({ postedAt: null }), { ...prefs, maxPostingAgeDays: 14 }, now);
  assert.equal(outcome.passed, true);
});

test("the age limit is a no-op when not configured", () => {
  const now = new Date("2026-09-13T00:00:00.000Z");
  const outcome = applyFilters(job({ postedAt: "2020-01-01T00:00:00.000Z" }), prefs, now);
  assert.equal(outcome.passed, true);
});

// Shivani's hard 3-day recency window.
const DAY_MS = 24 * 60 * 60 * 1000;
const shivaniNow = new Date("2026-09-29T12:00:00.000Z");
const threeDayPrefs: Preferences = { ...prefs, maxPostingAgeDays: 3 };
const postedDaysAgo = (days: number): string => new Date(shivaniNow.getTime() - days * DAY_MS).toISOString();

test("3-day cutoff: 2.9 days old is kept", () => {
  assert.equal(applyFilters(job({ postedAt: postedDaysAgo(2.9) }), threeDayPrefs, shivaniNow).passed, true);
});

test("3-day cutoff: 3.1 days old is dropped", () => {
  const outcome = applyFilters(job({ postedAt: postedDaysAgo(3.1) }), threeDayPrefs, shivaniNow);
  assert.equal(outcome.passed, false);
  assert.match(outcome.reason ?? "", /older than the 3-day limit/);
});

test("3-day cutoff: exactly 3.0 days old is KEPT (limit is inclusive; only strictly older is dropped)", () => {
  assert.equal(applyFilters(job({ postedAt: postedDaysAgo(3) }), threeDayPrefs, shivaniNow).passed, true);
});

test("3-day cutoff: unknown or unparseable posted dates are not newly excluded", () => {
  assert.equal(applyFilters(job({ postedAt: null }), threeDayPrefs, shivaniNow).passed, true);
  assert.equal(applyFilters(job({ postedAt: "not a date" }), threeDayPrefs, shivaniNow).passed, true);
});

test("the committed shivani profile sets the recency window to 3 days", async () => {
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile("config/job-search/shivani/preferences.json", "utf8")) as Partial<Preferences>;
  assert.equal(raw.maxPostingAgeDays, 3);
});

const maxYearsPrefs: Preferences = { ...prefs, maxRequiredYearsExperience: 5 };

test("maxRequiredYearsExperience: 8+ and 6+ years are dropped, 5+ and 3-5 are kept", () => {
  const cases: Array<[string, boolean]> = [
    ["8+ years of marketing experience", false],
    ["6+ years of marketing experience", false],
    ["5+ years of marketing experience", true],
    ["3-5 years of marketing experience", true],
    ["minimum 6 years in program management", false],
    ["6-8 years experience", false],
    ["Own demand generation for the growth team.", true],
  ];
  for (const [text, expected] of cases) {
    const parsed = parseExperienceYears(text);
    const outcome = applyFilters(
      job({ summary: text, experienceYearsMin: parsed.min, experienceYearsMax: parsed.max }),
      maxYearsPrefs,
    );
    assert.equal(outcome.passed, expected, text);
  }
});

test("maxRequiredYearsExperience: rejection reason names the cap and buckets cleanly", () => {
  const outcome = applyFilters(job({ experienceYearsMin: 6 }), maxYearsPrefs);
  assert.equal(outcome.passed, false);
  assert.match(outcome.reason ?? "", /Requires 6\+ years of experience, above the 5-year maximum/);
  const [bucket] = summarizeRejections([job({ filterReason: outcome.reason })]);
  assert.equal(bucket?.reason, "Requires more years of experience than her maximum");
});

test("maxRequiredYearsExperience: null disables the cap and unstated years always pass", () => {
  assert.equal(applyFilters(job({ experienceYearsMin: 12 }), prefs).passed, true);
  assert.equal(applyFilters(job({ experienceYearsMin: null }), maxYearsPrefs).passed, true);

// Fix 1 (revamp): recency anchors on min(firstSeenAt, postedAt), because
// board date fields are often edit-stamps rather than first-published dates.
test("a bumped old role — fresh postedAt, old firstSeenAt — is rejected by the age limit", () => {
  const now = new Date("2026-09-13T00:00:00.000Z");
  const outcome = applyFilters(
    job({
      postedAt: "2026-09-12T00:00:00.000Z", // edited yesterday, per the board
      firstSeenAt: "2026-07-01T00:00:00.000Z", // but we first saw it 74 days ago
    }),
    { ...prefs, maxPostingAgeDays: 30 },
    now,
  );
  assert.equal(outcome.passed, false, "the bump must not sail through the 30-day window");
  assert.match(outcome.reason ?? "", /74 days ago, older than the 30-day limit/);
});

test("a genuinely fresh role passes even though the anchor logic now consults firstSeenAt", () => {
  const now = new Date("2026-09-13T00:00:00.000Z");
  const outcome = applyFilters(
    job({ postedAt: "2026-09-12T00:00:00.000Z", firstSeenAt: "2026-09-12T00:00:00.000Z" }),
    { ...prefs, maxPostingAgeDays: 30 },
    now,
  );
  assert.equal(outcome.passed, true);
});

test("a dateless posting is still never rejected by the age limit, even when first seen long ago", () => {
  const now = new Date("2026-09-13T00:00:00.000Z");
  const outcome = applyFilters(
    job({ postedAt: null, firstSeenAt: "2026-01-01T00:00:00.000Z" }),
    { ...prefs, maxPostingAgeDays: 30 },
    now,
  );
  assert.equal(outcome.passed, true, "dateless postings are never rejected — the 'don't guess' rule stands");
});

// Fix 4a (revamp): the metro re-admit gate reads the structured location field only.
test("a metro named only in the summary prose no longer re-admits an onsite role", () => {
  const outcome = applyFilters(
    job({
      locationClass: "onsite",
      rawLocation: "Chicago, IL",
      summary: "Own demand generation. Our Austin office is hiring!",
    }),
    { ...prefs, metros: ["Austin"] },
  );
  assert.equal(outcome.passed, false);
  assert.match(outcome.reason ?? "", /Not remote/);
});

test("a metro named in the structured location field still re-admits an onsite role", () => {
  const outcome = applyFilters(
    job({ locationClass: "onsite", rawLocation: "Austin, TX" }),
    { ...prefs, metros: ["Austin"] },
  );
  assert.equal(outcome.passed, true);
});

// Fix 4b (revamp): per-watchlist-entry maxAgeDays override.
test("a per-board age override tightens the window for that board only", () => {
  const now = new Date("2026-09-13T00:00:00.000Z");
  const record = job({ postedAt: "2026-08-24T00:00:00.000Z", firstSeenAt: "2026-08-24T00:00:00.000Z" }); // 20 days old

  const overridden = applyFilters(record, { ...prefs, maxPostingAgeDays: 30 }, now, 14);
  assert.equal(overridden.passed, false);
  assert.match(overridden.reason ?? "", /20 days ago, older than the 14-day limit/);

  const globalDefault = applyFilters(record, { ...prefs, maxPostingAgeDays: 30 }, now);
  assert.equal(globalDefault.passed, true, "absent the override, the global default still applies");
});

// Fix 4c (revamp): maxImpliedExperienceYears caps open-ended floors.
test("an open-ended 8+ floor rejects under the implied cap, passes without it", () => {
  const record = job({ experienceYearsMin: 8, experienceYearsMax: null });
  // A band with no ceiling lets the overlap check pass, so only the
  // implied cap can reject this senior role.
  const band = { ...prefs, experienceYearsFloor: 3, experienceYearsCeiling: null };

  const capped = applyFilters(record, { ...band, maxImpliedExperienceYears: 6 });
  assert.equal(capped.passed, false);
  assert.match(capped.reason ?? "", /open-ended above the 6-year implied cap/);

  const uncapped = applyFilters(record, band);
  assert.equal(uncapped.passed, true, "null cap preserves the historical behavior");
});

test("an open-ended floor within the implied cap still overlaps the band", () => {
  const outcome = applyFilters(job({ experienceYearsMin: 4, experienceYearsMax: null }), {
    ...prefs,
    experienceYearsFloor: 3,
    experienceYearsCeiling: 6,
    maxImpliedExperienceYears: 6,
  });
  assert.equal(outcome.passed, true);
});

test("a closed range is unaffected by the implied cap", () => {
  const outcome = applyFilters(job({ experienceYearsMin: 3, experienceYearsMax: 8 }), {
    ...prefs,
    experienceYearsFloor: 3,
    experienceYearsCeiling: 6,
    maxImpliedExperienceYears: 6,
  });
  assert.equal(outcome.passed, true, "the cap only constrains open-ended floors, never closed ranges");

});
