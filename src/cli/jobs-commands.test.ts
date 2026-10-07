import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  outboundSendsPermitted,
  sendDigestEmailIfConfigured,
  sendDigestImessageIfConfigured,
  sendDigestSmsIfConfigured,
  type JobsCommandDeps,
} from "./jobs-commands";
import type { RunSummary } from "../jobsearch/digest";

/**
 * Standing-rule pins (2026-10-04, carve-out 2026-10-05): this pipeline package
 * NEVER sends anything itself — no email, no SMS, no iMessage — even when
 * every enable flag is on. The 2026-10-05 carve-out authorizes exactly one
 * exception: the Shivani digest lane may be sent, and only by the VM sender
 * module (~/workspace/system/bin/shivani-digest-send.py) via AgentMail REST.
 * These tests pin the pipeline closed AND prove the repo contains no other
 * send path — flipping any of this must be a deliberate, reviewed change,
 * never an accident.
 */

function deps(): { deps: JobsCommandDeps; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    deps: {
      stdout: (line: string) => lines.push(line),
      stderr: (line: string) => lines.push(`STDERR: ${line}`),
    },
  };
}

function emptySummary(): RunSummary {
  return {
    runId: "run-1",
    startedAt: "2026-10-04T16:00:00.000Z",
    finishedAt: "2026-10-04T16:05:00.000Z",
    fetchedCount: 0,
    newCount: 0,
    duplicateCount: 0,
    filteredCount: 0,
    filterReasons: [],
    scoredCount: 0,
    shortlisted: [],
    alsoSeen: [],
    health: [],
    failures: [],
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
}

/** Runs fn with the given env vars set, restoring the originals after. */
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(vars)) {
    saved.set(key, process.env[key]);
    process.env[key] = vars[key] as string;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("outboundSendsPermitted is false — the standing rule pins every send closed", () => {
  assert.equal(outboundSendsPermitted(), false);
});

test("digest email never fires even when DIGEST_EMAIL_ENABLED=true", async () => {
  const { deps: d, lines } = deps();
  await withEnv(
    {
      DIGEST_EMAIL_ENABLED: "true",
      DIGEST_EMAIL_TO: "candidate@example.com",
      INKBOX_API_KEY: "test-key",
      INKBOX_MAILBOX_ADDRESS: "mailbox@example.com",
    },
    () => sendDigestEmailIfConfigured(emptySummary(), d),
  );
  const out = lines.join("\n");
  assert.match(out, /not sent/);
  assert.match(out, /NO-EMAILS/);
  assert.doesNotMatch(out, /emailed to/);
});

test("digest SMS never fires even when DIGEST_SMS_ENABLED=true", async () => {
  const { deps: d, lines } = deps();
  await withEnv(
    {
      DIGEST_SMS_ENABLED: "true",
      DIGEST_SMS_TO: "+15551234567",
      INKBOX_API_KEY: "test-key",
      INKBOX_SMS_PHONE_NUMBER_ID: "test-number-id",
    },
    () => sendDigestSmsIfConfigured(emptySummary(), d),
  );
  const out = lines.join("\n");
  assert.match(out, /not sent/);
  assert.doesNotMatch(out, /texted to/);
});

test("digest iMessage never fires even when DIGEST_IMESSAGE_ENABLED=true", async () => {
  const { deps: d, lines } = deps();
  await withEnv(
    {
      DIGEST_IMESSAGE_ENABLED: "true",
      DIGEST_IMESSAGE_TO: "+15551234567",
      INKBOX_API_KEY: "test-key",
      INKBOX_IDENTITY_ID: "test-identity-id",
    },
    () => sendDigestImessageIfConfigured(emptySummary(), d),
  );
  const out = lines.join("\n");
  assert.match(out, /not sent/);
  assert.doesNotMatch(out, /iMessaged to/);
});

test("no send call exists anywhere in jobs-commands.ts — structural tripwire", async () => {
  // The four send paths (digest email saveDraft+send, feedback email
  // saveDraft+send, feedback iMessage send, digest SMS/iMessage sends) were
  // removed 2026-10-04. If a send call reappears here, this fails loudly.
  const source = await readFile(join(__dirname, "..", "..", "src", "cli", "jobs-commands.ts"), "utf8");
  for (const call of ["inkboxClient.send(", "imessageClient.send(", "inkboxClient.saveDraft(", "client.saveDraft("]) {
    assert.doesNotMatch(source, new RegExp(call.replace(/[().]/g, (c) => `\\${c}`)), `found a send call: ${call}`);
  }
});

test("the repo has no other send path — the VM sender module is the only authorized one", async () => {
  // Scoped to the pipeline package (src/jobsearch + src/cli): no AgentMail
  // send, no Inkbox send, no SMS/iMessage client send may exist anywhere in
  // it. The single authorized send path lives OUTSIDE this repo at
  // ~/workspace/system/bin/shivani-digest-send.py (AgentMail REST, Shivani
  // digest lane only, 2026-10-05 carve-out) — deliberately out of reach of
  // this tripwire so the pipeline can never send and the sender can.
  const { readdir } = await import("node:fs/promises");
  const roots = [join(__dirname, "..", "..", "src", "jobsearch"), join(__dirname, "..", "..", "src", "cli")];
  const offenders: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(p);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        const src = await readFile(p, "utf8");
        if (/agentmail\.to\/v0\/inboxes.*messages\/send|inkboxClient\.send\(|imessageClient\.send\(|smsClient\.send\(|\.saveDraft\(/.test(src)) {
          offenders.push(p);
        }
      }
    }
  }
  for (const r of roots) await walk(r);
  assert.deepEqual(offenders, [], "send path found inside the pipeline package");
});

test("the jobs dashboard binds 127.0.0.1 explicitly, never 0.0.0.0 or an env-driven host", async () => {
  const source = await readFile(join(__dirname, "jobs-commands.js"), "utf8");
  const listenCalls = [...source.matchAll(/server\.listen\(([^)]*)\)/g)].map((m) => m[1] as string);
  assert.ok(listenCalls.length > 0, "expected at least one server.listen call");
  for (const args of listenCalls) {
    assert.match(args, /"127\.0\.0\.1"/, `bind address must be explicit localhost: server.listen(${args})`);
    assert.doesNotMatch(args, /0\.0\.0\.0/, "never bind all interfaces");
  }
})

test("jobs applied records her application and schedules the nudge; jobs stage walks the funnel", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { runJobsCommand } = await import("./jobs-commands.js");
  const { JsonFileJobStore } = await import("../store/job-store.js");
  const { dataDirFor } = await import("../jobsearch/config.js");

  const root = await mkdtemp(join(tmpdir(), "crm-cli-"));
  await mkdir(join(root, "config", "job-search", "shivani"), { recursive: true });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps = { stdout: (l: string) => stdout.push(l), stderr: (l: string) => stderr.push(l), root };

  const store = new JsonFileJobStore(join(root, dataDirFor("shivani")));
  await store.saveJobs([{
    id: "job-1", contentHash: "h", identityKey: "k", title: "Field Marketing Manager", company: "Eon.io",
    rawLocation: "Remote", locationClass: "remote", remoteRegion: "us",
    salaryMin: null, salaryMax: null, salaryCurrency: null, postedAt: null,
    experienceYearsMin: null, experienceYearsMax: null,
    firstSeenAt: "2026-09-28T00:00:00.000Z", lastSeenAt: "2026-09-28T00:00:00.000Z",
    sources: [], applyUrl: "https://example.com/1", descriptionPath: "/tmp/1.html",
    summary: "s", state: "shortlisted", filterReason: null, score: 80,
    confidence: null, rationale: null, gaps: [], scoreDimensions: null,
  }]);

  assert.equal(await runJobsCommand(["applied", "--profile", "shivani", "--job", "job-1"], deps), 0);
  let apps = await store.listApplications();
  assert.equal(apps.length, 1);
  assert.equal(apps[0]!.status, "applied");
  assert.ok(apps[0]!.appliedAt, "applied date stamped");
  assert.ok(apps[0]!.followUpDueAt, "nudge scheduled");
  assert.match(stdout.join("\n"), /Follow-up nudge scheduled in 7 days/);
  const jobs = await store.listJobs();
  assert.equal(jobs[0]!.state, "applied", "job record follows the application");

  // The funnel walk.
  assert.equal(await runJobsCommand(["stage", "--profile", "shivani", "job-1", "screening"], deps), 0);
  apps = await store.listApplications();
  assert.equal(apps[0]!.status, "screening");

  // An illegal jump fails loudly and changes nothing.
  stdout.length = 0; stderr.length = 0;
  assert.equal(await runJobsCommand(["stage", "--profile", "shivani", "job-1", "offer"], deps), 1);
  assert.match(stderr.join("\n"), /Cannot move application/);
  apps = await store.listApplications();
  assert.equal(apps[0]!.status, "screening", "illegal move changed nothing");
})

test("jobs reject rejects the posting and explicitly does not mute the company", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { runJobsCommand } = await import("./jobs-commands.js");
  const { JsonFileJobStore } = await import("../store/job-store.js");
  const { dataDirFor } = await import("../jobsearch/config.js");
  const { loadMutedCompanies } = await import("../jobsearch/crm.js");

  const root = await mkdtemp(join(tmpdir(), "crm-cli-"));
  await mkdir(join(root, "config", "job-search", "shivani"), { recursive: true });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps = { stdout: (l: string) => stdout.push(l), stderr: (l: string) => stderr.push(l), root };

  const store = new JsonFileJobStore(join(root, dataDirFor("shivani")));
  await store.saveJobs([{
    id: "job-2", contentHash: "h", identityKey: "k", title: "Marketing Coordinator", company: "Noise Inc",
    rawLocation: "Remote", locationClass: "remote", remoteRegion: "us",
    salaryMin: null, salaryMax: null, salaryCurrency: null, postedAt: null,
    experienceYearsMin: null, experienceYearsMax: null,
    firstSeenAt: "2026-09-28T00:00:00.000Z", lastSeenAt: "2026-09-28T00:00:00.000Z",
    sources: [], applyUrl: "https://example.com/2", descriptionPath: "/tmp/2.html",
    summary: "s", state: "shortlisted", filterReason: null, score: 70,
    confidence: null, rationale: null, gaps: [], scoreDimensions: null,
  }]);

  assert.equal(await runJobsCommand(["reject", "--profile", "shivani", "--job", "job-2"], deps), 0);
  const jobs = await store.listJobs();
  assert.equal(jobs[0]!.state, "rejected");
  assert.match(stdout.join("\n"), /NOT muted/);
  assert.deepEqual(await loadMutedCompanies("shivani", root), [], "rejecting a posting never mutes the company");
})

test("jobs mute-company / unmute-company round-trips", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { runJobsCommand } = await import("./jobs-commands.js");
  const { loadMutedCompanies } = await import("../jobsearch/crm.js");

  const root = await mkdtemp(join(tmpdir(), "crm-cli-"));
  await mkdir(join(root, "config", "job-search", "shivani"), { recursive: true });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps = { stdout: (l: string) => stdout.push(l), stderr: (l: string) => stderr.push(l), root };

  assert.equal(await runJobsCommand(["mute-company", "--profile", "shivani", "Noise Inc"], deps), 0);
  assert.deepEqual(await loadMutedCompanies("shivani", root), ["Noise Inc"]);
  assert.equal(await runJobsCommand(["unmute-company", "--profile", "shivani", "Noise Inc"], deps), 0);
  assert.deepEqual(await loadMutedCompanies("shivani", root), []);
})

test("jobs linkedin-sync ingests applied/saved history idempotently and never rejects", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { runJobsCommand } = await import("./jobs-commands.js");
  const { JsonFileJobStore } = await import("../store/job-store.js");
  const { dataDirFor } = await import("../jobsearch/config.js");
  const { linkedInPullPath, chicagoDateStamp } = await import("../jobsearch/sources/linkedin-pull.js");

  const root = await mkdtemp(join(tmpdir(), "crm-cli-"));
  await mkdir(join(root, "config", "job-search", "shivani"), { recursive: true });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps = { stdout: (l: string) => stdout.push(l), stderr: (l: string) => stderr.push(l), root };

  const pullPath = linkedInPullPath("shivani", chicagoDateStamp(new Date()), root);
  await mkdir(join(pullPath, ".."), { recursive: true });
  await writeFile(pullPath, JSON.stringify({
    pulledAt: new Date().toISOString(),
    items: [],
    appliedHistory: [
      { title: "Field Marketing Manager", company: "Eon.io", location: "Dallas", dateApplied: null, status: "In Progress" },
      { title: "Performance Marketing Specialist", company: "Bloom Nutrition", location: "Austin", dateApplied: null, status: "No longer accepting applications" },
    ],
    savedJobs: [
      { title: "Field Marketing Manager", company: "Baseten", location: "NYC", url: "https://example.com/b" },
    ],
  }), "utf8");

  assert.equal(await runJobsCommand(["linkedin-sync", "--profile", "shivani"], deps), 0);
  const store = new JsonFileJobStore(join(root, dataDirFor("shivani")));
  let apps = await store.listApplications();
  assert.equal(apps.length, 3);
  assert.deepEqual(apps.map((a) => a.status).sort(), ["applied", "applied", "saved"]);
  assert.ok(apps.every((a) => a.source === "linkedin"));

  // Second run: idempotent.
  stdout.length = 0;
  assert.equal(await runJobsCommand(["linkedin-sync", "--profile", "shivani"], deps), 0);
  apps = await store.listApplications();
  assert.equal(apps.length, 3, "re-running creates nothing new");
  assert.match(stdout.join("\n"), /0 application record\(s\) created/);
})

test("jobs mail-scan refuses without --dry-run and proposes links with it", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { runJobsCommand } = await import("./jobs-commands.js");
  const { JsonFileJobStore } = await import("../store/job-store.js");
  const { dataDirFor } = await import("../jobsearch/config.js");
  const { randomUUID } = await import("node:crypto");

  const root = await mkdtemp(join(tmpdir(), "crm-cli-"));
  await mkdir(join(root, "config", "job-search", "shivani"), { recursive: true });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps = { stdout: (l: string) => stdout.push(l), stderr: (l: string) => stderr.push(l), root };

  // Read-only by design: no --dry-run, no scan.
  assert.equal(await runJobsCommand(["mail-scan", "--profile", "shivani", "--mbox", "/tmp/x.json"], deps), 1);
  assert.match(stderr.join("\n"), /read-only/);

  const mbox = join(root, "mail.json");
  await writeFile(mbox, JSON.stringify([
    { id: "m1", from: "jobs@acmecorp.com", subject: "Interview: Marketing Program Manager", date: null, snippet: "Acme Corp would like to meet you" },
    { id: "m2", from: "mom@family.com", subject: "Dinner Sunday", date: null, snippet: "hi" },
  ]), "utf8");

  const store = new JsonFileJobStore(join(root, dataDirFor("shivani")));
  await store.saveJobs([{
    id: "job-9", contentHash: "h", identityKey: "k", title: "Marketing Program Manager", company: "Acme Corp",
    rawLocation: "Remote", locationClass: "remote", remoteRegion: "us",
    salaryMin: null, salaryMax: null, salaryCurrency: null, postedAt: null,
    experienceYearsMin: null, experienceYearsMax: null,
    firstSeenAt: "2026-09-28T00:00:00.000Z", lastSeenAt: "2026-09-28T00:00:00.000Z",
    sources: [], applyUrl: "https://example.com/9", descriptionPath: "/tmp/9.html",
    summary: "s", state: "applied", filterReason: null, score: 80,
    confidence: null, rationale: null, gaps: [], scoreDimensions: null,
  }]);
  await store.saveApplication({
    id: randomUUID(), jobId: "job-9", status: "applied", appliedAt: "2026-09-20T00:00:00.000Z",
    resumeVariantPath: null, coverLetterPath: null, followUpDueAt: "2026-09-27T00:00:00.000Z",
    outcome: null, rejectionReason: null, notes: [],
  });

  stdout.length = 0; stderr.length = 0;
  assert.equal(await runJobsCommand(["mail-scan", "--profile", "shivani", "--dry-run", "--mbox", mbox], deps), 0);
  const report = stdout.join("\n");
  assert.match(report, /interview/);
  assert.match(report, /nothing was changed/);
  assert.ok(!report.includes("Dinner Sunday"), "non-recruiting mail is not proposed");
})
