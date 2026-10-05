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

test("ClaudeCliScoringClient strips ANTHROPIC_API_KEY from the CLI's env and passes everything else through", async () => {
  // A fake `claude` that reports what it was spawned with. If the key leaked
  // through, the real CLI would use the retired API credit instead of the
  // claude.ai login.
  const dir = mkdtempSync(join(tmpdir(), "fake-claude-env-"));
  const bin = join(dir, "claude");
  writeFileSync(bin, '#!/bin/bash\ncat >/dev/null\necho "KEY=${ANTHROPIC_API_KEY-UNSET} OTHER=${SCORING_CLIENT_TEST_PASSTHROUGH-UNSET}"\n');
  chmodSync(bin, 0o755);

  const savedKey = process.env["ANTHROPIC_API_KEY"];
  const savedOther = process.env["SCORING_CLIENT_TEST_PASSTHROUGH"];
  process.env["ANTHROPIC_API_KEY"] = "test-key-must-not-reach-the-cli";
  process.env["SCORING_CLIENT_TEST_PASSTHROUGH"] = "kept";
  try {
    const result = await new ClaudeCliScoringClient(bin).complete({ model: "m", system: "s", user: "u", maxTokens: 1 });
    assert.equal(result.text.trim(), "KEY=UNSET OTHER=kept");
  } finally {
    if (savedKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
    else process.env["ANTHROPIC_API_KEY"] = savedKey;
    if (savedOther === undefined) delete process.env["SCORING_CLIENT_TEST_PASSTHROUGH"];
    else process.env["SCORING_CLIENT_TEST_PASSTHROUGH"] = savedOther;
  }
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
