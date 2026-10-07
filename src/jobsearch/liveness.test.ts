import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, readFile } from "node:fs/promises";
import {
  appendLivenessReviewQueue,
  checkLiveness,
  type LivenessFetcher,
} from "./liveness";
import type { JobRecord } from "./records";
import { runPipeline } from "./pipeline";
import { renderDigest } from "./digest";
import { InMemoryJobStore } from "../store/job-store";
import { FakeScoringClient } from "./scoring-client";
import { DEFAULT_PREFERENCES, type Preferences, type RawPosting } from "./records";
import type { Source } from "./sources/source";

const LEDGER = join(tmpdir(), `liveness-costs-${process.pid}.jsonl`);

function record(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "rec-1",
    title: "Marketing Manager",
    company: "Acme",
    applyUrl: "https://a.test/jobs/1",
    location: "Remote - US",
    summary: "Own demand generation.",
    firstSeen: "2026-09-13T08:00:00.000Z",
    ...overrides,
  } as JobRecord;
}

function fetcherFor(statusByUrl: Record<string, number>): LivenessFetcher {
  return async (url: string) => ({ status: statusByUrl[url] ?? 200, bodyText: null });
}

test("checkLiveness: dead postings are removed, ambiguous ones stay in and join the review queue", async () => {
  const live = record({ id: "live", applyUrl: "https://a.test/jobs/live" });
  const dead = record({ id: "dead", applyUrl: "https://a.test/jobs/dead" });
  const ambiguous = record({ id: "ambiguous", applyUrl: "https://a.test/jobs/ambiguous" });
  const fetch = fetcherFor({
    "https://a.test/jobs/live": 200,
    "https://a.test/jobs/dead": 404,
    "https://a.test/jobs/ambiguous": 503,
  });

  const report = await checkLiveness([live, dead, ambiguous], fetch);

  assert.deepEqual(report.live.map((r) => r.id).sort(), ["ambiguous", "live"]);
  assert.equal(report.removed.length, 1);
  assert.equal(report.removed[0]?.record.id, "dead");
  assert.equal(report.reviewQueue.length, 1);
  assert.equal(report.reviewQueue[0]?.id, "ambiguous");
  assert.equal(report.reviewQueue[0]?.url, "https://a.test/jobs/ambiguous");
});

test("checkLiveness: a fetcher that throws is ambiguous (fail-open), not fatal", async () => {
  const rec = record({ id: "flaky" });
  const report = await checkLiveness([rec], async () => {
    throw new Error("socket hang up");
  });

  assert.equal(report.live.length, 1);
  assert.equal(report.removed.length, 0);
  assert.equal(report.reviewQueue.length, 1);
  assert.equal(report.reviewQueue[0]?.reason, "fetch-error");
});

test("appendLivenessReviewQueue appends one JSONL line per item, id/title/company/url/reason", async () => {
  const dir = await mkdtemp(join(tmpdir(), "liveness-queue-"));
  const queuePath = join(dir, "liveness-review-queue.jsonl");
  await appendLivenessReviewQueue(
    [
      { id: "a1", title: "Marketing Manager", company: "Acme", url: "https://a.test/jobs/1", reason: "http-503" },
    ],
    queuePath,
  );

  const lines = (await readFile(queuePath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), {
    id: "a1",
    title: "Marketing Manager",
    company: "Acme",
    url: "https://a.test/jobs/1",
    reason: "http-503",
  });
});

test("appendLivenessReviewQueue with zero items writes nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "liveness-queue-"));
  const queuePath = join(dir, "liveness-review-queue.jsonl");
  await appendLivenessReviewQueue([], queuePath);

  let exists = true;
  try {
    await readFile(queuePath, "utf8");
  } catch {
    exists = false;
  }
  assert.equal(exists, false);
});

// --- Pipeline wiring ---

const prefs: Preferences = { ...DEFAULT_PREFERENCES, titles: ["marketing manager"], scoreCutoff: 65 };

function posting(overrides: Partial<RawPosting> = {}): RawPosting {
  return {
    sourceId: "greenhouse:acme",
    url: "https://a.test/jobs/1",
    title: "Marketing Manager",
    company: "Acme",
    location: "Remote - US",
    body: "<p>Own demand generation. Range $130,000 - $160,000.</p>",
    postedAt: "2026-09-01T00:00:00.000Z",
    fetchedAt: "2026-09-13T08:00:00.000Z",
    ...overrides,
  };
}

function alwaysScore(ninety = 90): FakeScoringClient {
  return new (class extends FakeScoringClient {
    constructor() {
      super([]);
    }
    async complete(request: Parameters<FakeScoringClient["complete"]>[0]) {
      this.requests.push(request);
      const ids = [...request.user.matchAll(/"id": "([^"]+)"/g)].map((match) => match[1]);
      const body = ids.map(
        (id) =>
          `{"id":"${id}","score":${ninety},"confidence":"high","rationale":"Strong fit.","gaps":[]}`,
      );
      return { text: `[${body.join(",")}]`, usage: { inputTokens: 1200, outputTokens: 200 } };
    }
  })();
}

test("pipeline liveness stage: confirmed-dead roles leave the digest and are counted", async () => {
  const store = new InMemoryJobStore();
  const dir = await mkdtemp(join(tmpdir(), "liveness-pipe-"));
  const queuePath = join(dir, "liveness-review-queue.jsonl");

  const summary = await runPipeline({
    sources: [
      { id: "greenhouse:acme", company: "Acme", fetch: async () => [posting({ url: "https://a.test/jobs/live" })] },
      { id: "greenhouse:beta", company: "Beta", fetch: async () => [posting({ url: "https://a.test/jobs/dead", company: "Beta" })] },
    ] as Source[],
    store,
    prefs,
    profile: { resume: "Ten years in demand generation.", notes: "" },
    scoringClient: alwaysScore(),
    costLogPath: LEDGER,
    politeDelay: false,
    livenessFetcher: fetcherFor({ "https://a.test/jobs/live": 200, "https://a.test/jobs/dead": 404 }),
    livenessQueuePath: queuePath,
  });

  assert.equal(summary.shortlisted.length, 1);
  assert.equal(summary.shortlisted[0]?.company, "Acme");
  assert.equal(summary.livenessRemovedCount, 1);

  const digest = renderDigest(summary);
  assert.ok(digest.includes("1 role removed — posting no longer live"), "digest names the removal");
});

test("pipeline liveness stage: ambiguous roles stay in the digest and are queued for spot-check", async () => {
  const store = new InMemoryJobStore();
  const dir = await mkdtemp(join(tmpdir(), "liveness-pipe-"));
  const queuePath = join(dir, "liveness-review-queue.jsonl");

  const summary = await runPipeline({
    sources: [
      { id: "greenhouse:acme", company: "Acme", fetch: async () => [posting({ url: "https://a.test/jobs/flaky" })] },
    ],
    store,
    prefs,
    profile: { resume: "Ten years in demand generation.", notes: "" },
    scoringClient: alwaysScore(),
    costLogPath: LEDGER,
    politeDelay: false,
    livenessFetcher: fetcherFor({ "https://a.test/jobs/flaky": 503 }),
    livenessQueuePath: queuePath,
  });

  assert.equal(summary.shortlisted.length, 1);
  assert.equal(summary.livenessRemovedCount, 0);

  const queued = (await readFile(queuePath, "utf8")).trim().split("\n");
  assert.equal(queued.length, 1);
  const item = JSON.parse(queued[0] ?? "");
  assert.equal(item.reason, "http-503");
  assert.equal(item.url, "https://a.test/jobs/flaky");
});
