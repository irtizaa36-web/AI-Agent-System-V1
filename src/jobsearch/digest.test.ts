import { test } from "node:test";
import assert from "node:assert/strict";
import { renderDigest, digestPayload, type RunSummary } from "./digest";
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
    remoteRegion: "unspecified",
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
    state: "shortlisted",
    filterReason: null,
    score: 88,
    confidence: "high",
    rationale: "Squarely your demand-gen background at the level you want.",
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
    fetchedCount: 120,
    newCount: 9,
    duplicateCount: 111,
    filteredCount: 6,
    filterReasons: [
      { reason: "Title outside the target cluster", count: 4 },
      { reason: "Not remote, and not in a named metro", count: 2 },
    ],
    scoredCount: 3,
    shortlisted: [job()],
    alsoSeen: [],
    health: [{ sourceId: "greenhouse:acme", state: "ok", postingCount: 120, error: null, checkedAt: "x" }],
    failures: [],
    costUsd: 0.0412,
    inputTokens: 20000,
    outputTokens: 4500,
    ...overrides,
  };
}

test("the digest leads with the count, the cost and the roles", () => {
  const markdown = renderDigest(summary());
  assert.match(markdown, /# Job digest — 2026-09-13/);
  assert.match(markdown, /1 role worth a look/);
  assert.match(markdown, /\$0\.04/);
  assert.match(markdown, /Marketing Manager — Acme/);
  assert.match(markdown, /\[Apply\]\(https:\/\/a\.test\/1\)/);
});

test("a role with no stated pay says so rather than showing a number", () => {
  const markdown = renderDigest(summary());
  assert.match(markdown, /Pay not stated/);
  assert.doesNotMatch(markdown, /\$\d{2,3},\d{3}/);
});

test("a stated range is printed as published", () => {
  const markdown = renderDigest(summary({ shortlisted: [job({ salaryMin: 130000, salaryMax: 160000, salaryCurrency: "USD" })] }));
  assert.match(markdown, /130,000–160,000 USD/);
});

test("gaps are shown next to the role, not buried", () => {
  const markdown = renderDigest(summary({ shortlisted: [job({ gaps: ["Paid search ownership", "Team of 5+"] })] }));
  assert.match(markdown, /\*\*Gaps:\*\* Paid search ownership; Team of 5\+/);
});

test("an empty run says so plainly instead of rendering an empty list", () => {
  assert.match(renderDigest(summary({ shortlisted: [], scoredCount: 0 })), /No new roles cleared the score cutoff/);
});

test("every digest states that nothing was applied to or sent", () => {
  assert.match(renderDigest(summary()), /Nothing was applied to, nobody was contacted, and no message was sent/);
});

test("cross-posted roles list their other links", () => {
  const markdown = renderDigest(
    summary({
      shortlisted: [
        job({
          sources: [
            { sourceId: "greenhouse:acme", url: "https://a.test/1", fetchedAt: "x" },
            { sourceId: "lever:acme", url: "https://b.test/2", fetchedAt: "x" },
          ],
        }),
      ],
    }),
  );
  assert.match(markdown, /Also posted: \[lever:acme\]\(https:\/\/b\.test\/2\)/);
});

test("the digest shows why postings were filtered out, not just how many", () => {
  const markdown = renderDigest(summary());
  assert.match(markdown, /Filtered out:.*Title outside the target cluster \(4\)/);
  assert.match(markdown, /Not remote, and not in a named metro \(2\)/);
});

test("filter reasons beyond the top 5 are rolled up instead of spilling the whole list", () => {
  const filterReasons = Array.from({ length: 8 }, (_, i) => ({ reason: `Reason ${i}`, count: 10 - i }));
  const markdown = renderDigest(summary({ filterReasons }));
  assert.match(markdown, /3 more reasons \(12\)/);
});

test("a run with nothing filtered out shows no filter-reasons line", () => {
  const markdown = renderDigest(summary({ filteredCount: 0, filterReasons: [] }));
  assert.doesNotMatch(markdown, /Filtered out:/);
});

test("the dashboard payload reports whether pay was stated, without inventing a figure", () => {
  const payload = digestPayload(summary());
  assert.equal(payload.shortlisted[0]?.salaryStated, false);
  assert.equal(payload.shortlisted[0]?.salaryMin, null);
});

test("the digest shows the applicant count next to the role when known", () => {
  const markdown = renderDigest(summary({ shortlisted: [job({ applicantCount: 42 })] }));
  assert.match(markdown, /42 applicants/);
  assert.equal(digestPayload(summary({ shortlisted: [job({ applicantCount: 42 })] })).shortlisted[0]?.applicantCount, 42);
});

test("the digest omits applicant text when the count is missing", () => {
  const markdown = renderDigest(summary({ shortlisted: [job({ applicantCount: null }), job({ id: "job-2" })] }));
  assert.doesNotMatch(markdown, /applicant/);
  assert.equal(digestPayload(summary()).shortlisted[0]?.applicantCount, null);

test("the Also seen list caps at ten and names the remainder", () => {
  const many = Array.from({ length: 25 }, (_, i) => job({ id: `job-${i}`, title: `Role ${i}`, score: 40 }));
  const markdown = renderDigest(summary({ shortlisted: [], alsoSeen: many }));
  const roleLines = markdown.split("\n").filter((l) => l.startsWith("- **"));
  assert.equal(roleLines.length, 10, "only ten roles are listed");
  assert.match(markdown, /- …and 15 more below the cutoff/);
});

test("a short Also seen list is shown in full with no overflow line", () => {
  const few = Array.from({ length: 3 }, (_, i) => job({ id: `job-${i}`, title: `Role ${i}`, score: 40 }));
  const markdown = renderDigest(summary({ shortlisted: [], alsoSeen: few }));
  assert.doesNotMatch(markdown, /more below the cutoff/);
});

test("writeRejectionsLog writes one JSON line per rejected record with its bucketed reason", async () => {
  const { mkdtemp, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { writeRejectionsLog } = await import("./digest.js");
  const dir = await mkdtemp(join(tmpdir(), "rej-"));
  const path = join(dir, "rejections-2026-09-28.jsonl");
  await writeRejectionsLog(
    [
      job({ id: "r1", title: "Janitor", company: "Acme", filterReason: "Title outside the target cluster", state: "filtered" }),
      job({ id: "r2", title: "VP Sales", company: "Beta", filterReason: "Posted 45 days ago, older than the 30-day limit", state: "filtered" }),
    ],
    path,
  );
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0] as string) as Record<string, unknown>;
  assert.equal(first["id"], "r1");
  assert.equal(first["title"], "Janitor");
  assert.equal(first["company"], "Acme");
  assert.equal(first["reason"], "Title outside the target cluster");
  const second = JSON.parse(lines[1] as string) as Record<string, unknown>;
  assert.equal(second["reason"], "Posting older than the age limit", "reasons are bucketed, not raw strings");
});

test("shortlisted roles show the per-dimension fit breakdown when dimensions were stored", () => {
  const markdown = renderDigest(
    summary({
      shortlisted: [
        job({
          scoreDimensions: { title: 90, experience: 80, skills: 85, location: 70, salary: 60, recency: 95 },
        }),
        job({ id: "job-2", scoreDimensions: null }),
      ],
    }),
  );
  assert.ok(markdown.includes("_Fit breakdown:_"), "breakdown line rendered");
  assert.ok(markdown.includes("title 90"), "dimension values shown");
  assert.ok(markdown.includes("recency 95"));
  assert.equal(
    markdown.split("_Fit breakdown:_").length - 1,
    1,
    "only the role with stored dimensions shows a breakdown",
  );

});
