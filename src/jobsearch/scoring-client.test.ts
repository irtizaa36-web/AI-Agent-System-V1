import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeCliScoringClient,
  FakeScoringClient,
  createScoringClientFromEnv,
} from "./scoring-client";

/** A fake `claude` binary that echoes stdin to stdout, like `claude -p` would. */
function fakeClaudeBin(): string {
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, "#!/bin/bash\ncat\n");
  chmodSync(bin, 0o755);
  return bin;
}

test("ClaudeCliScoringClient pipes system+user through the CLI and returns stdout", async () => {
  const client = new ClaudeCliScoringClient(fakeClaudeBin());
  const result = await client.complete({ model: "m", system: "SYS", user: "USER", maxTokens: 10 });
  assert.equal(result.text, "SYS\n\nUSER");
  assert.deepEqual(result.usage, {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
});

test("createScoringClientFromEnv honors CLAUDE_CLI_PATH", () => {
  const saved = process.env["CLAUDE_CLI_PATH"];
  process.env["CLAUDE_CLI_PATH"] = fakeClaudeBin();
  try {
    const client = createScoringClientFromEnv();
    assert.ok(client instanceof ClaudeCliScoringClient);
  } finally {
    if (saved === undefined) delete process.env["CLAUDE_CLI_PATH"];
    else process.env["CLAUDE_CLI_PATH"] = saved;
  }
});

test("FakeScoringClient replays scripted responses", async () => {
  const fake = new FakeScoringClient(['[{"id":"a"}]']);
  const result = await fake.complete({ model: "m", system: "s", user: "u", maxTokens: 1 });
  assert.equal(result.text, '[{"id":"a"}]');
  assert.equal(fake.requests.length, 1);
});
