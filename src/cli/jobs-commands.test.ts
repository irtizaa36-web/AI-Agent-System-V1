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
