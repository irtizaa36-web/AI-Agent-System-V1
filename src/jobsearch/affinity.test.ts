import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AFFINITY_MAX_BONUS,
  affinityBonus,
  buildAffinity,
  normalizeCompany,
  parseAppliedHistory,
  titleTokens,
} from "./affinity";
import type { JobRecord } from "./records";

/**
 * Synthetic applied history only — never real PII. The affinity module is
 * deterministic, so fixtures can be small and exact.
 */
const HISTORY = [
  { title: "Senior Marketing Program Manager", company: "Acme Corp", location: "Remote", dateApplied: "2026-09-20", status: "applied" },
  { title: "Marketing Program Manager", company: "Beta Inc", location: "Dallas, TX", dateApplied: "2026-09-18", status: "screening" },
  { title: "Senior Marketing Manager", company: "Acme Corp", location: "Remote", dateApplied: "2026-09-10", status: "rejected" },
] as const;

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    contentHash: "hash-1",
    identityKey: "acme::marketing program manager::remote",
    title: "Marketing Program Manager",
    company: "Acme",
    rawLocation: "Remote",
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
    sources: [{ sourceId: "greenhouse:acme", url: "https://a.test/1", fetchedAt: "2026-09-13T08:00:00.000Z" }],
    applyUrl: "https://a.test/1",
    descriptionPath: "/tmp/1.html",
    summary: "Own demand gen.",
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

test("parseAppliedHistory keeps valid entries and skips sloppy ones individually", () => {
  const parsed = parseAppliedHistory([
    { title: "PM", company: "Acme", location: "Remote", dateApplied: "2026-09-20", status: "applied" },
    { title: "", company: "Acme" },
    { title: "PM" },
    "not an object",
    { title: "Designer", company: "Beta", dateApplied: "not-a-date", status: "" },
  ]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.title, "PM");
  assert.equal(parsed[0]?.dateApplied, "2026-09-20");
  assert.equal(parsed[1]?.dateApplied, null, "bad dates become null, never guessed");
  assert.equal(parsed[1]?.status, null, "blank status becomes null");
});

test("parseAppliedHistory returns [] for absent, null, or wrong-shaped history", () => {
  assert.deepEqual(parseAppliedHistory(undefined), []);
  assert.deepEqual(parseAppliedHistory(null), []);
  assert.deepEqual(parseAppliedHistory({}), []);
  assert.deepEqual(parseAppliedHistory("nope"), []);
});

test("buildAffinity counts title tokens and companies", () => {
  const model = buildAffinity(parseAppliedHistory(HISTORY), []);
  assert.equal(model.entryCount, 3);
  assert.equal(model.titleTokens["marketing"], 3, "marketing appears in all three titles");
  assert.equal(model.titleTokens["senior"], 2);
  assert.equal(model.companies["acme corp"], 2);
  assert.equal(model.companies["beta inc"], 1);
});

test("titleTokens drops stopwords but keeps seniority words", () => {
  const tokens = titleTokens("Senior Marketing Program Manager II");
  assert.ok(tokens.includes("senior"), "seniority is signal");
  assert.ok(tokens.includes("marketing"));
  assert.ok(!tokens.includes("ii"), "numerals dropped");
  assert.deepEqual(titleTokens("a the and of"), [], "pure stopwords tokenize to nothing");
});

test("normalizeCompany is case- and punctuation-insensitive", () => {
  assert.equal(normalizeCompany("Acme Corp."), normalizeCompany("acme corp"));
});

test("affinityBonus is zero with a null or empty model — no signal, no change", () => {
  assert.deepEqual(affinityBonus(job(), null), { points: 0, reasons: [] });
  assert.deepEqual(affinityBonus(job(), buildAffinity([], [])), { points: 0, reasons: [] });
});

test("affinityBonus rewards shared title tokens, capped at 3", () => {
  const model = buildAffinity(parseAppliedHistory(HISTORY));
  const bonus = affinityBonus(job({ title: "Senior Marketing Program Manager", company: "Unrelated Co" }), model);
  // tokens senior, marketing, program, manager all in history -> 4 matches, capped at 3
  assert.equal(bonus.points, 3);
  assert.ok(bonus.reasons[0]?.includes("marketing"), "reasons name the evidence");
});

test("affinityBonus adds +2 for a previously-applied company", () => {
  const model = buildAffinity(parseAppliedHistory(HISTORY));
  const bonus = affinityBonus(job({ title: "Unrelated Role XYZ", company: "Acme Corp" }), model);
  assert.equal(bonus.points, 2);
  assert.ok(bonus.reasons.some((r) => r.includes("Acme Corp")), "company named in reasons");
});

test("affinityBonus hard-caps at AFFINITY_MAX_BONUS", () => {
  assert.equal(AFFINITY_MAX_BONUS, 5);
  const model = buildAffinity(parseAppliedHistory(HISTORY));
  const bonus = affinityBonus(job({ title: "Senior Marketing Program Manager", company: "Acme Corp" }), model);
  // 3 (title cap) + 2 (company) = 5 — exactly the cap, never above it
  assert.equal(bonus.points, 5);
  const huge = buildAffinity(
    parseAppliedHistory(
      Array.from({ length: 20 }, (_, i) => ({
        title: "Senior Marketing Program Manager",
        company: "Acme Corp",
        location: "Remote",
        dateApplied: "2026-09-20",
        status: "applied",
      })),
    ),
  );
  const record = job({ title: "Senior Marketing Program Manager", company: "Acme Corp" });
  assert.ok(affinityBonus(record, huge).points <= AFFINITY_MAX_BONUS, "repetition never exceeds the cap");
});

test("affinityBonus ignores records with no token or company overlap", () => {
  const model = buildAffinity(parseAppliedHistory(HISTORY));
  const bonus = affinityBonus(job({ title: "Staff Accountant", company: "Ledger LLC" }), model);
  assert.deepEqual(bonus, { points: 0, reasons: [] });
});

import { SEED_APPLIED_HISTORY } from "./affinity";

test("seed set carries her five real snapshot applications", () => {
  assert.equal(SEED_APPLIED_HISTORY.length, 5);
  const companies = SEED_APPLIED_HISTORY.map((entry) => entry.company);
  assert.deepEqual(companies, ["Eon.io", "GoFundMe", "Bloom Nutrition", "Dyson", "LTK"]);
});

test("buildAffinity includes the seed by default — marketing skew shows up unseeded", () => {
  const model = buildAffinity([]);
  assert.equal(model.entryCount, 5);
  assert.equal(model.titleTokens["marketing"], 3, "Eon, GoFundMe, Bloom");
  assert.equal(model.titleTokens["manager"], 3, "Eon, GoFundMe, Dyson");
  assert.equal(model.titleTokens["senior"], 1, "GoFundMe only — 'sr' is a separate token");
  assert.equal(model.companies["eon io"], 1);
  const bonus = affinityBonus(
    job({ title: "Field Marketing Manager", company: "Other Co" }),
    model,
  );
  assert.ok(bonus.points > 0, "seed titles move the needle even with no pull file");
});

test("buildAffinity dedupes seed entries that reappear in pull history", () => {
  const pull = parseAppliedHistory([
    { title: "Field Marketing Manager", company: "Eon.io", location: "Remote", dateApplied: "2026-09-14", status: "applied" },
  ]);
  const model = buildAffinity(pull);
  assert.equal(model.entryCount, 5, "Eon entry counted once, not twice");
});

test("seed can be excluded entirely", () => {
  const model = buildAffinity([], []);
  assert.equal(model.entryCount, 0);
});
