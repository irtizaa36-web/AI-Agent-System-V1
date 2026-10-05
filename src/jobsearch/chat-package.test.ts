import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chatPackageRole, writeChatPackage, type ChatPackageRole, type ChatPackageRolesEnvelope } from "./chat-package";
import type { RunSummary } from "./digest";
import type { JobRecord } from "./records";

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "job-1",
    contentHash: "hash-1",
    identityKey: "acme::partner marketing manager::remote",
    title: "Partner Marketing Manager",
    company: "Acme",
    rawLocation: "Remote, USA",
    locationClass: "remote",
    remoteRegion: "us",
    salaryMin: 130000,
    salaryMax: 160000,
    salaryCurrency: "USD",
    postedAt: "2026-10-03T10:00:00.000Z",
    experienceYearsMin: 3,
    experienceYearsMax: 7,
    firstSeenAt: "2026-10-04T08:00:00.000Z",
    lastSeenAt: "2026-10-04T08:00:00.000Z",
    sources: [],
    applyUrl: "https://boards.example.com/acme/1",
    descriptionPath: "/tmp/1.html",
    summary: "Own partner marketing.",
    state: "shortlisted",
    filterReason: null,
    score: 82,
    confidence: "high",
    rationale: "Partner marketing ownership matches her AWS track record.",
    gaps: [],
    ...overrides,
  };
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    startedAt: "2026-10-04T16:00:00.000Z",
    finishedAt: "2026-10-04T16:05:00.000Z",
    fetchedCount: 100,
    newCount: 10,
    duplicateCount: 90,
    filteredCount: 5,
    filterReasons: [],
    scoredCount: 5,
    shortlisted: [],
    alsoSeen: [],
    health: [],
    failures: [],
    costUsd: 0.01,
    inputTokens: 100,
    outputTokens: 50,
    ...overrides,
  };
}

test("chatPackageRole flattens a role to the required metadata fields", () => {
  const role = chatPackageRole(job(), "2026-10-04T16:00:00.000Z");
  assert.deepEqual(role, {
    roleId: "acme::partner marketing manager::remote",
    title: "Partner Marketing Manager",
    company: "Acme",
    location: "Remote, USA",
    payBand: "130,000-160,000 USD",
    postedAge: "1 day ago",
    experienceRequired: "3-7 years",
    applyUrl: "https://boards.example.com/acme/1",
    fitNote: "Partner marketing ownership matches her AWS track record.",
  } satisfies ChatPackageRole);
});

test("chatPackageRole degrades honestly when the posting states nothing", () => {
  const role = chatPackageRole(
    job({
      rawLocation: "",
      salaryMin: null,
      salaryMax: null,
      salaryCurrency: null,
      postedAt: null,
      experienceYearsMin: null,
      experienceYearsMax: null,
      rationale: null,
    }),
    "2026-10-04T16:00:00.000Z",
  );
  assert.equal(role.payBand, "Pay not stated");
  assert.equal(role.postedAge, "date unknown");
  assert.equal(role.experienceRequired, "not stated");
  assert.equal(role.fitNote, "");
  assert.equal(role.location, "remote");
});

test("chatPackageRole renders open-ended experience bounds the way the posting states them", () => {
  assert.equal(chatPackageRole(job({ experienceYearsMin: 6, experienceYearsMax: null }), "2026-10-04T16:00:00.000Z").experienceRequired, "6+ years");
  assert.equal(chatPackageRole(job({ experienceYearsMin: null, experienceYearsMax: 5 }), "2026-10-04T16:00:00.000Z").experienceRequired, "up to 5 years");
  assert.equal(chatPackageRole(job({ experienceYearsMin: 5, experienceYearsMax: 5 }), "2026-10-04T16:00:00.000Z").experienceRequired, "5 years");
});

test("chatPackageRole calls a same-day posting 'today'", () => {
  const role = chatPackageRole(job({ postedAt: "2026-10-04T15:30:00.000Z" }), "2026-10-04T16:00:00.000Z");
  assert.equal(role.postedAge, "today");
});

test("writeChatPackage writes shortlist.txt, roles.json, and manifest.json with the expected shape", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-package-"));
  const lines: string[] = [];
  const packageDir = await writeChatPackage(
    "shivani",
    root,
    summary({
      shortlisted: [
        job(),
        job({ id: "job-2", title: "Growth Marketing Manager", company: "Beta", applyUrl: "https://boards.example.com/beta/2" }),
      ],
    }),
    (line) => lines.push(line),
  );

  const files = await readdir(packageDir);
  assert.deepEqual(files.sort(), ["manifest.json", "roles.json", "shortlist.txt"]);

  const envelope = JSON.parse(await readFile(join(packageDir, "roles.json"), "utf8")) as ChatPackageRolesEnvelope;
  assert.equal(envelope.date, "2026-10-04"); // startedAt 16:00Z = 11:00 CDT
  assert.equal(envelope.filter_version, "unknown"); // no meta passed
  assert.equal(envelope.code_sha, "unknown"); // tmpdir is not a git checkout
  assert.equal(envelope.roles.length, 2);
  assert.equal(envelope.roles[0]?.roleId, "acme::partner marketing manager::remote");
  assert.equal(envelope.roles[0]?.title, "Partner Marketing Manager");
  assert.equal(envelope.roles[0]?.applyUrl, "https://boards.example.com/acme/1");
  assert.equal(envelope.roles[1]?.title, "Growth Marketing Manager");

  const manifest = JSON.parse(await readFile(join(packageDir, "manifest.json"), "utf8")) as {
    runTimestamp: string;
    roleCount: number;
    packageDir: string;
    files: { shortlist: string; roles: string; manifest: string };
  };
  assert.equal(manifest.runTimestamp, "2026-10-04T16:00:00.000Z");
  assert.equal(manifest.roleCount, 2);
  assert.equal(manifest.packageDir, packageDir);
  assert.deepEqual(manifest.files, { shortlist: "shortlist.txt", roles: "roles.json", manifest: "manifest.json" });

  const shortlist = await readFile(join(packageDir, "shortlist.txt"), "utf8");
  assert.match(shortlist, /Job digest 2026-10-04: 2 roles worth a look/);
  assert.match(shortlist, /Partner Marketing Manager — Acme/);
  assert.match(shortlist, /https:\/\/boards\.example\.com\/acme\/1/);

  assert.match(lines.join("\n"), new RegExp(`Chat package written to .* — 2 roles shortlisted\\.`));
});

test("writeChatPackage handles an empty shortlist honestly", async () => {
  const root = await mkdtemp(join(tmpdir(), "chat-package-"));
  const lines: string[] = [];
  const packageDir = await writeChatPackage("shivani", root, summary(), (line) => lines.push(line), {
    filterVersion: "3-7",
    codeSha: "abc123",
  });

  const envelope = JSON.parse(await readFile(join(packageDir, "roles.json"), "utf8")) as ChatPackageRolesEnvelope;
  assert.deepEqual(envelope.roles, []);
  assert.equal(envelope.date, "2026-10-04");
  assert.equal(envelope.filter_version, "3-7");
  assert.equal(envelope.code_sha, "abc123");
  const shortlist = await readFile(join(packageDir, "shortlist.txt"), "utf8");
  assert.match(shortlist, /nothing new today/);
  assert.match(lines.join("\n"), /0 roles shortlisted/);
});
