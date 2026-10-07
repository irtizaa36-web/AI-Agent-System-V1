import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileFiltered } from "./reconcile";
import { DEFAULT_PREFERENCES, type JobRecord, type Preferences } from "./records";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    contentHash: "hash-1",
    identityKey: "acme::gtm strategy operations manager::remote",
    title: "GTM Strategy & Operations Manager",
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
    sources: [],
    applyUrl: "https://a.test/1",
    descriptionPath: "/tmp/1.html",
    summary: "Own GTM operations.",
    state: "filtered",
    filterReason: "Title outside the target cluster",
    score: null,
    confidence: null,
    rationale: null,
    gaps: [],
    scoreDimensions: null,
    ...overrides,
  };
}

const prefs: Preferences = { ...DEFAULT_PREFERENCES, titles: ["strategy & operations manager"] };

test("a filtered record that now passes is rescued: state flips to seen, filterReason clears", () => {
  const { rescued, stillFiltered } = reconcileFiltered([job()], prefs);
  assert.equal(rescued.length, 1);
  assert.equal(stillFiltered.length, 0);
  assert.equal(rescued[0]?.state, "seen");
  assert.equal(rescued[0]?.filterReason, null);
});

test("a record that still fails stays filtered, with its reason refreshed", () => {
  const stale = job({ title: "Marketing Intern", filterReason: "some stale reason" });
  const { rescued, stillFiltered } = reconcileFiltered([stale], prefs);
  assert.equal(rescued.length, 0);
  assert.equal(stillFiltered.length, 1);
  assert.match(stillFiltered[0]?.filterReason ?? "", /^Title excluded/);
});

test("records not in the filtered state are left alone entirely", () => {
  const scored = job({ state: "scored", filterReason: null, score: 80 });
  const { rescued, stillFiltered } = reconcileFiltered([scored], prefs);
  assert.equal(rescued.length, 0);
  assert.equal(stillFiltered.length, 0);
});

test("nothing else about a rescued record changes — score, gaps, sources are untouched", () => {
  const record = job({ sources: [{ sourceId: "greenhouse:acme", url: "https://a.test/1", fetchedAt: "x" }] });
  const { rescued } = reconcileFiltered([record], prefs);
  assert.deepEqual(rescued[0]?.sources, record.sources);
  assert.equal(rescued[0]?.id, record.id);
  assert.equal(rescued[0]?.contentHash, record.contentHash);
});
