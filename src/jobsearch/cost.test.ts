import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CostLedger, costOf, readLedger } from "./cost";

test("costOf prices a Haiku call from the published per-million rates", () => {
  // 1M input at $1 + 1M output at $5.
  assert.equal(costOf("claude-haiku-4-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 6);
});

test("costOf bills cached reads at a tenth of input", () => {
  const cost = costOf("claude-haiku-4-5", { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 });
  assert.ok(Math.abs(cost - 0.1) < 1e-9);
});

test("costOf returns zero for an unknown model rather than failing a scheduled run", () => {
  assert.equal(costOf("some-future-model", { inputTokens: 1000, outputTokens: 1000 }), 0);
});

test("the ledger accumulates a run total and persists one line per call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cost-ledger-test-"));
  const path = join(dir, "costs.jsonl");
  try {
    const ledger = new CostLedger("run-1", path);
    await ledger.record("score", "claude-haiku-4-5", { inputTokens: 20_000, outputTokens: 4_500 });
    await ledger.record("score", "claude-haiku-4-5", { inputTokens: 20_000, outputTokens: 4_500 });

    assert.equal(ledger.totalTokens().input, 40_000);
    assert.ok(ledger.total() > 0);

    const entries = await readLedger(path);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.runId, "run-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a realistic scoring run costs a few cents, not a few dollars", async () => {
  // The plan's steady-state estimate: ~20K input, ~4.5K output per run.
  const cost = costOf("claude-haiku-4-5", { inputTokens: 20_000, outputTokens: 4_500 });
  assert.ok(cost < 0.05, `expected a few cents, got $${cost.toFixed(4)}`);
});

test("readLedger returns nothing for a ledger that does not exist yet", async () => {
  assert.deepEqual(await readLedger(join(tmpdir(), "definitely-missing-costs.jsonl")), []);
});

test("versioned model ids resolve to their base pricing tier", () => {
  const base = costOf("claude-haiku-4-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.ok(base > 0, "base tier is priced");
  assert.equal(
    costOf("claude-haiku-4-5-20251001", { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    base,
    "a versioned id bills at its family's rate, not $0",
  );
  assert.equal(costOf("claude-sonnet-5-latest", { inputTokens: 1_000_000, outputTokens: 0 }), costOf("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 0 }));
});

test("genuinely unknown models cost 0 rather than throwing", () => {
  assert.equal(costOf("some-future-model-9", { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 0);
});
