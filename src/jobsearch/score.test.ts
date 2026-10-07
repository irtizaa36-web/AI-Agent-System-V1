import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBatchPrompt, buildSystemPrompt, chunk, parseScoringResponse, scoreRecords } from "./score";
import { DEFAULT_PREFERENCES, type JobRecord, type Preferences } from "./records";
import { FakeScoringClient } from "./scoring-client";
import { CostLedger } from "./cost";
import { join } from "node:path";
import { tmpdir } from "node:os";

function job(id: string, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    contentHash: `hash-${id}`,
    identityKey: `acme::manager::remote`,
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
    summary: "Own demand generation.",
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

const prefs: Preferences = { ...DEFAULT_PREFERENCES, titles: ["marketing manager"], scoringBatchSize: 2, scoreCutoff: 65 };
const profile = { resume: "Ten years in demand generation.", notes: "" };
const ledgerPath = join(tmpdir(), `costs-${process.pid}.jsonl`);

test("chunk splits into batches of the configured size", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("the system prompt carries the rubric, targets and resume; the batch prompt carries only postings", () => {
  const system = buildSystemPrompt(profile, prefs);
  assert.match(system, /marketing manager/);
  assert.match(system, /Ten years in demand generation/);
  assert.match(system, /Remote roles only/);

  const batch = buildBatchPrompt([job("a")]);
  assert.doesNotMatch(batch, /Ten years in demand generation/, "the resume must stay in the cached prefix");
  assert.match(batch, /Marketing Manager/);
});

test("a posting with no stated salary is described as not stated, not omitted", () => {
  assert.match(buildBatchPrompt([job("a")]), /"salary": "not stated"/);
});

test("parseScoringResponse reads a clean array", () => {
  const parsed = parseScoringResponse('[{"id":"a","score":88,"confidence":"high","rationale":"Good.","gaps":[]}]');
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0]?.score, 88);
  assert.equal(parsed.entries[0]?.confidence, "high");
  assert.deepEqual(parsed.failures, []);
});

test("parseScoringResponse tolerates a code fence", () => {
  const fenced = parseScoringResponse('```json\n[{"id":"a","score":70,"confidence":"medium","rationale":"ok","gaps":[]}]\n```');
  assert.equal(fenced.entries[0]?.id, "a");
});

test("one malformed entry is skipped and named, and the rest of the batch still parses", () => {
  const parsed = parseScoringResponse(
    '[{"id":"a","score":88,"confidence":"high","rationale":"Good.","gaps":[]},' +
      '{"score":"high"},' +
      '{"id":"c","score":40,"confidence":"medium","rationale":"Wrong level.","gaps":[]}]',
  );
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.entries.map((e) => e.id), ["a", "c"]);
  assert.equal(parsed.failures.length, 1);
  assert.match(parsed.failures[0] ?? "", /scoring entry 1/);
});

test("a non-numeric score skips the entry instead of voiding the batch", () => {
  const parsed = parseScoringResponse(
    '[{"id":"a","score":"ninety","confidence":"high","rationale":"x","gaps":[]},' +
      '{"id":"b","score":55,"confidence":"low","rationale":"y","gaps":[]}]',
  );
  assert.equal(parsed.entries.length, 1);
  assert.equal(parsed.entries[0]?.id, "b");
  assert.match(parsed.failures[0] ?? "", /non-numeric score/);
});

test("a response that is not a JSON array at all still throws at the batch level", () => {
  assert.throws(() => parseScoringResponse("this is not json"), /not a JSON array/);
});

test("parseScoringResponse clamps an out-of-range score and defaults an unknown confidence to low", () => {
  const parsed = parseScoringResponse('[{"id":"a","score":120,"confidence":"certain","rationale":"x","gaps":[]}]');
  assert.equal(parsed.entries[0]?.score, 100);
  assert.equal(parsed.entries[0]?.confidence, "low");
});

test("scoreRecords names skipped malformed entries in the run failures", async () => {
  const client = new FakeScoringClient([
    '[{"id":"a","score":90,"confidence":"high","rationale":"Strong.","gaps":[]},' + '{"id":"b","score":"n/a","confidence":"high","rationale":"x","gaps":[]}]',
  ]);

  const result = await scoreRecords([job("a"), job("b")], profile, prefs, client, new CostLedger("run-3", ledgerPath));

  assert.equal(result.scored.length, 1);
  assert.equal(result.scored[0]?.id, "a");
  assert.match(result.failures.join(" "), /non-numeric score/);
});

test("scoreRecords shortlists above the cutoff and merely scores below it", async () => {
  const client = new FakeScoringClient([
    '[{"id":"a","score":90,"confidence":"high","rationale":"Strong.","gaps":[]},' +
      '{"id":"b","score":40,"confidence":"medium","rationale":"Wrong level.","gaps":["People management"]}]',
  ]);

  const result = await scoreRecords([job("a"), job("b")], profile, prefs, client, new CostLedger("run-1", ledgerPath));

  assert.equal(result.scored.length, 2);
  assert.equal(result.scored.find((r) => r.id === "a")?.state, "shortlisted");
  assert.equal(result.scored.find((r) => r.id === "b")?.state, "scored");
  assert.deepEqual(result.scored.find((r) => r.id === "b")?.gaps, ["People management"]);
});

test("a failed batch is reported and its postings stay unscored rather than vanishing", async () => {
  const client = new FakeScoringClient(["this is not json"]);

  const result = await scoreRecords([job("a")], profile, prefs, client, new CostLedger("run-2", ledgerPath));

  assert.equal(result.scored.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0] ?? "", /not a JSON array/);
});

test("the cached system prefix is byte-identical across batches, so the cache can actually hit", async () => {
  const client = new FakeScoringClient([
    '[{"id":"a","score":70,"confidence":"high","rationale":"x","gaps":[]},{"id":"b","score":70,"confidence":"high","rationale":"x","gaps":[]}]',
    '[{"id":"c","score":70,"confidence":"high","rationale":"x","gaps":[]}]',
  ]);

  await scoreRecords([job("a"), job("b"), job("c")], profile, prefs, client, new CostLedger("run-3", ledgerPath));

  assert.equal(client.requests.length, 2);
  assert.equal(client.requests[0]?.system, client.requests[1]?.system);
});

test("the system prompt asks for experience alignment and treats titles as examples only", () => {
  const system = buildSystemPrompt(profile, prefs);
  assert.match(system, /does NOT need a title from a fixed list/);
  assert.match(system, /examples only, not a required list/);

test("the scoring prompt asks for all six dimension scores and names posted/firstSeen", () => {
  const system = buildSystemPrompt(profile, prefs);
  for (const key of ["title", "experience", "skills", "location", "salary", "recency"]) {
    assert.ok(system.includes(key), `dimension ${key} must be named in the prompt`);
  }
  const batch = buildBatchPrompt([job("a")]);
  assert.ok(batch.includes("\"posted\""), "posted date reaches the model");
  assert.ok(batch.includes("\"firstSeen\""), "first-seen date reaches the model");
});

test("parseScoreDimensions reads six finite numbers and rejects partial sets", async () => {
  const { parseScoreDimensions } = await import("./score.js");
  const full = parseScoreDimensions({ title: 80, experience: 70, skills: 90, location: 60, salary: 50, recency: 100 });
  assert.deepEqual(full, { title: 80, experience: 70, skills: 90, location: 60, salary: 50, recency: 100 });
  assert.equal(parseScoreDimensions({ title: 80, experience: 70 }), null, "partial set stores null");
  assert.equal(parseScoreDimensions({ title: 80, experience: 70, skills: 90, location: 60, salary: "high", recency: 100 }), null, "non-numeric stores null");
  assert.equal(parseScoreDimensions(null), null);
  assert.equal(parseScoreDimensions("nope"), null);
});

test("scoreRecords stores dimensions; malformed dimensions keep the composite", async () => {
  const client = new FakeScoringClient([
    '[{"id":"a","score":88,"confidence":"high","rationale":"Good.","gaps":[],"dimensions":{"title":90,"experience":80,"skills":95,"location":70,"salary":60,"recency":85}},' +
      '{"id":"b","score":70,"confidence":"medium","rationale":"ok","gaps":[],"dimensions":{"title":70}}]',
  ]);
  const result = await scoreRecords([job("a"), job("b")], profile, prefs, client, new CostLedger("run-dims", ledgerPath));
  const a = result.scored.find((r) => r.id === "a");
  const b = result.scored.find((r) => r.id === "b");
  assert.deepEqual(a?.scoreDimensions, { title: 90, experience: 80, skills: 95, location: 70, salary: 60, recency: 85 });
  assert.equal(b?.scoreDimensions, null, "partial dimensions store null without losing the entry");
  assert.equal(b?.score, 70, "the composite survives bad dimensions");
  assert.equal(result.failures.length, 0, "dimension problems never become entry failures");
});

test("effectiveScore is the composite by default — cut and rank behavior identical until a human re-weights", async () => {
  const { effectiveScore } = await import("./score.js");
  const record = job("a", {
    score: 70,
    scoreDimensions: { title: 90, experience: 80, skills: 80, location: 80, salary: 80, recency: 80 },
  });
  assert.equal(effectiveScore(record, DEFAULT_PREFERENCES), 70, "null weights: composite rules");
  assert.equal(
    effectiveScore(record, { ...DEFAULT_PREFERENCES, scoreWeights: { title: 1, experience: 1, skills: 1, location: 1, salary: 1, recency: 1 } }),
    82,
    "equal weights average the dimensions: (90 + 5*80) / 6",
  );
  assert.equal(
    effectiveScore(record, { ...DEFAULT_PREFERENCES, scoreWeights: { title: 5, experience: 1, skills: 1, location: 1, salary: 1, recency: 1 } }),
    85,
    "title-weighted average: (5*90 + 5*80) / 10",
  );
  assert.equal(
    effectiveScore({ ...record, scoreDimensions: null }, { ...DEFAULT_PREFERENCES, scoreWeights: { title: 1, experience: 1, skills: 1, location: 1, salary: 1, recency: 1 } }),
    70,
    "weights set but no dimensions: composite fallback",
  );
  assert.equal(
    effectiveScore(record, { ...DEFAULT_PREFERENCES, scoreWeights: { title: 0, experience: 0, skills: 0, location: 0, salary: 0, recency: 0 } }),
    70,
    "all-zero weights: composite fallback, not division by zero",
  );
});

test("scoreRecords cuts on the effective score when weights are set", async () => {
  const weighted = { ...prefs, scoreWeights: { title: 1, experience: 0, skills: 0, location: 0, salary: 0, recency: 0 } };
  const client = new FakeScoringClient([
    '[{"id":"a","score":60,"confidence":"high","rationale":"Composite below cutoff.","gaps":[],"dimensions":{"title":95,"experience":50,"skills":50,"location":50,"salary":50,"recency":50}}]',
  ]);
  const result = await scoreRecords([job("a")], profile, weighted, client, new CostLedger("run-weighted", ledgerPath));
  assert.equal(result.scored[0]?.state, "shortlisted", "title dimension 95 clears the 65 cutoff even though the composite is 60");
});

test("scoreRecords applies the affinity bonus and records it in the rationale", async () => {
  const { buildAffinity, parseAppliedHistory } = await import("./affinity.js");
  const affinity = buildAffinity(
    parseAppliedHistory([
      { title: "Senior Marketing Program Manager", company: "Acme Corp", location: "Remote", dateApplied: "2026-09-20", status: "applied" },
      { title: "Marketing Program Manager", company: "Beta Inc", location: "Dallas, TX", dateApplied: "2026-09-18", status: "applied" },
    ]),
  );
  const client = new FakeScoringClient([
    '[{"id":"a","score":63,"confidence":"high","rationale":"Good fit.","gaps":[]}]',
  ]);
  const result = await scoreRecords(
    [job("a", { title: "Senior Marketing Program Manager", company: "Acme Corp" })],
    profile,
    prefs,
    client,
    new CostLedger("run-affinity", ledgerPath),
    affinity,
  );
  const record = result.scored[0];
  // title tokens senior/marketing/program/manager all in history (cap 3) + Acme Corp (+2) = 5
  assert.equal(record?.score, 68, "composite 63 + capped affinity 5");
  assert.match(record?.rationale ?? "", /\[affinity \+5:/, "bonus recorded in the rationale");
  assert.match(record?.rationale ?? "", /Acme Corp/, "company named as evidence");
  assert.equal(record?.state, "shortlisted", "68 clears the 65 cutoff — the nudge is real but the cutoff itself is untouched");
});

test("scoreRecords without an affinity model behaves exactly as before", async () => {
  const client = new FakeScoringClient([
    '[{"id":"a","score":63,"confidence":"high","rationale":"Good fit.","gaps":[]}]',
  ]);
  const result = await scoreRecords(
    [job("a", { title: "Senior Marketing Program Manager", company: "Acme Corp" })],
    profile,
    prefs,
    client,
    new CostLedger("run-no-affinity", ledgerPath),
  );
  assert.equal(result.scored[0]?.score, 63, "no bonus without a model");
  assert.equal(result.scored[0]?.rationale, "Good fit.", "rationale untouched");
  assert.equal(result.scored[0]?.state, "scored", "63 stays below the 65 cutoff");
});

test("the affinity bonus never pushes a score past 100", async () => {
  const { buildAffinity, parseAppliedHistory } = await import("./affinity.js");
  const affinity = buildAffinity(
    parseAppliedHistory([
      { title: "Senior Marketing Program Manager", company: "Acme Corp", location: "Remote", dateApplied: "2026-09-20", status: "applied" },
    ]),
  );
  const client = new FakeScoringClient([
    '[{"id":"a","score":99,"confidence":"high","rationale":"Perfect.","gaps":[]}]',
  ]);
  const result = await scoreRecords(
    [job("a", { title: "Senior Marketing Program Manager", company: "Acme Corp" })],
    profile,
    prefs,
    client,
    new CostLedger("run-affinity-cap", ledgerPath),
    affinity,
  );
  assert.equal(result.scored[0]?.score, 100);

});
