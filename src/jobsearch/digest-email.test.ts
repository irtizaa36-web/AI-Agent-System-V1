import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDigestEmailBody, formatDigestEmailSubject } from "./digest-email";
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

test("the subject names the date and the count", () => {
  assert.equal(formatDigestEmailSubject(summary({ shortlisted: [job(), job({ id: "b" })] })), "Job digest 2026-09-13: 2 roles worth a look");
  assert.equal(formatDigestEmailSubject(summary({ shortlisted: [job()] })), "Job digest 2026-09-13: 1 role worth a look");
});

test("the subject is honest when nothing cleared the bar, rather than a misleading empty count", () => {
  assert.equal(formatDigestEmailSubject(summary({ shortlisted: [] })), "Job digest 2026-09-13: nothing new today");
});

test("every role gets its own apply URL on its own line, unambiguously clickable — not wrapped in markdown brackets", () => {
  const body = formatDigestEmailBody(
    summary({
      shortlisted: [
        job({ id: "a", title: "Marketing Manager", applyUrl: "https://a.test/apply/1" }),
        job({ id: "b", title: "GTM Manager", applyUrl: "https://a.test/apply/2" }),
      ],
    }),
  );

  assert.match(body, /Apply: https:\/\/a\.test\/apply\/1/);
  assert.match(body, /Apply: https:\/\/a\.test\/apply\/2/);
  assert.doesNotMatch(body, /\[Apply\]/, "no markdown link syntax — this is a plain-text email, brackets would show up literally");
});

test("no length cap — every shortlisted role appears, unlike the SMS/iMessage version", () => {
  const body = formatDigestEmailBody(
    summary({ shortlisted: [job({ id: "a" }), job({ id: "b" }), job({ id: "c" }), job({ id: "d" }), job({ id: "e" }), job({ id: "f" })] }),
  );
  assert.equal((body.match(/Apply: /g) ?? []).length, 6);
});

test("each role carries its rationale and gaps, not just the title and link", () => {
  const body = formatDigestEmailBody(
    summary({ shortlisted: [job({ rationale: "Squarely her GTM enablement background.", gaps: ["No stated years requirement"] })] }),
  );
  assert.match(body, /Squarely her GTM enablement background\./);
  assert.match(body, /Gaps: No stated years requirement/);
});

test("a stated salary is shown, an unstated one says so rather than showing a figure", () => {
  const withPay = formatDigestEmailBody(summary({ shortlisted: [job({ salaryMin: 130000, salaryMax: 150000, salaryCurrency: "USD" })] }));
  assert.match(withPay, /130,000-150,000 USD/);

  const withoutPay = formatDigestEmailBody(summary({ shortlisted: [job({ salaryMin: null, salaryMax: null })] }));
  assert.match(withoutPay, /Pay not stated/);
});

test("a single stated figure (min equals max) is shown once, not as a redundant range", () => {
  const body = formatDigestEmailBody(summary({ shortlisted: [job({ salaryMin: 140000, salaryMax: 140000, salaryCurrency: "USD" })] }));
  assert.match(body, /140,000 USD/);
  assert.doesNotMatch(body, /140,000-140,000/);
});

test("no shortlisted roles produces an honest 'nothing today' body, not an empty one", () => {
  const body = formatDigestEmailBody(summary({ shortlisted: [] }));
  assert.match(body, /No new roles cleared the bar today/);
});

test("every email states plainly that nothing was applied to or sent, same discipline as the markdown digest", () => {
  const body = formatDigestEmailBody(summary());
  assert.match(body, /Nothing was applied to, nobody was contacted, and no message was sent/);
});

test("roles below the cutoff are mentioned by count, not dumped into the email body", () => {
  const body = formatDigestEmailBody(summary({ alsoSeen: [job({ id: "x" }), job({ id: "y" })] }));
  assert.match(body, /Also seen, below the cutoff: 2 more roles/);
});
