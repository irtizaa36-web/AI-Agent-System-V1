import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDigestSms } from "./digest-sms";
import type { RunSummary } from "./digest";
import type { JobRecord } from "./records";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    contentHash: "hash-1",
    identityKey: "acme::marketing manager::remote",
    title: "Marketing Manager",
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
    applyUrl: "https://a.test/apply/1",
    descriptionPath: "/tmp/1.html",
    summary: "Own demand gen.",
    state: "shortlisted",
    filterReason: null,
    score: 78,
    confidence: "high",
    rationale: "Strong fit.",
    gaps: [],
    scoreDimensions: null,
    ...overrides,
  };
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    startedAt: "2026-09-13T08:00:00.000Z",
    finishedAt: "2026-09-13T08:02:00.000Z",
    fetchedCount: 100,
    newCount: 20,
    duplicateCount: 80,
    filteredCount: 15,
    filterReasons: [{ reason: "Title outside the target cluster", count: 15 }],
    scoredCount: 5,
    shortlisted: [job()],
    alsoSeen: [],
    health: [],
    failures: [],
    costUsd: 0.02,
    inputTokens: 1000,
    outputTokens: 200,
    ...overrides,
  };
}

test("every role gets its own apply link, per Shivani's explicit ask", () => {
  const text = formatDigestSms(
    summary({
      shortlisted: [
        job({ id: "a", title: "Marketing Manager", applyUrl: "https://a.test/apply/1" }),
        job({ id: "b", title: "GTM Manager", applyUrl: "https://a.test/apply/2" }),
      ],
    }),
    5,
  );

  assert.match(text, /Marketing Manager @ Acme \[78\] https:\/\/a\.test\/apply\/1/);
  assert.match(text, /GTM Manager @ Acme \[78\] https:\/\/a\.test\/apply\/2/);
});

test("a stated salary is shown inline, an unstated one is simply omitted rather than shown as a fake figure", () => {
  const withPay = formatDigestSms(summary({ shortlisted: [job({ salaryMin: 130000, salaryMax: 150000 })] }), 5);
  assert.match(withPay, /\(130,000-150,000\)/);

  const withoutPay = formatDigestSms(summary({ shortlisted: [job({ salaryMin: null, salaryMax: null })] }), 5);
  assert.doesNotMatch(withoutPay, /\(\d/);
});

test("a single stated figure (min equals max) is shown once, not as a redundant range", () => {
  const text = formatDigestSms(summary({ shortlisted: [job({ salaryMin: 140000, salaryMax: 140000 })] }), 5);
  assert.match(text, /\(140,000\)/);
  assert.doesNotMatch(text, /140,000-140,000/);
});

test("maxRoles caps the message and says how many more are on the dashboard", () => {
  const text = formatDigestSms(
    summary({ shortlisted: [job({ id: "a" }), job({ id: "b" }), job({ id: "c" })] }),
    2,
  );

  assert.equal((text.match(/@ Acme/g) ?? []).length, 2);
  assert.match(text, /\+1 more on the dashboard/);
});

test("no shortlisted roles produces a short, honest 'nothing today' message, not an empty body", () => {
  const text = formatDigestSms(summary({ shortlisted: [] }), 5);
  assert.match(text, /no new roles cleared the bar today/);
});
