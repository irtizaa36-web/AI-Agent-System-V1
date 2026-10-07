import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliDeps } from "./index";
import { Registry } from "../registry/registry";
import { InMemoryRunStore } from "../store/run-store";
import { InMemoryWorkflowStore } from "../store/workflow-store";
import { FakeInkboxClient } from "../integrations/inkbox/fake-client";
import { InMemoryForwardingLog } from "../integrations/inkbox/forwarding-log";
import { InMemoryMessageEventLog } from "../integrations/inkbox/message-event-log";
import { InMemoryCoworkerTaskStore } from "../coworker/store";
import { InMemoryAgentStatusStore } from "../dashboard/agent-status-store";
import { InMemoryRecommendationStore } from "../dashboard/recommendation-store";
import { FakeSleeperWriteClient } from "../integrations/sleeper/fake-write-client";
import { InMemoryPickemStore } from "../sleeper/pickem/store";
import type { SleeperWriteClient } from "../integrations/sleeper/write-gate";
import { fixtureClient, LEAGUE_ID } from "../sleeper/test-fixtures";

/** `null` means no write client at all, as when SLEEPER_TOKEN is unset. */
function harness(writer: SleeperWriteClient | null = new FakeSleeperWriteClient()) {
  const writeClient = writer ?? undefined;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const pickemStore = new InMemoryPickemStore();
  const deps: CliDeps = {
    registry: new Registry(),
    store: new InMemoryRunStore(),
    workflowStore: new InMemoryWorkflowStore(),
    cwd: process.cwd(),
    inkboxClient: new FakeInkboxClient(),
    forwardingLog: new InMemoryForwardingLog(),
    messageEventLog: new InMemoryMessageEventLog(),
    coworkerStore: new InMemoryCoworkerTaskStore(),
    agentStatusStore: new InMemoryAgentStatusStore(),
    recommendationStore: new InMemoryRecommendationStore(),
    sleeper: { readClient: fixtureClient(), writeClient, pickemStore },
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
  return { deps, stdout, stderr, pickemStore };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "sleeper-cli-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const LINEUP = { kind: "set_lineup", leagueId: LEAGUE_ID, rosterId: 1, starters: ["11", "12", "19", "14", "20", "16", "17", "18", "KC"] };

test("sleeper leagues and preview resolve the username given at runtime", async () => {
  const h = harness();
  assert.equal(await runCli(["sleeper", "leagues", "owner_one"], h.deps), 0);
  assert.match(h.stdout.join("\n"), /user_id 100 — season 2026, week 3\n  1001  Test League/);

  const p = harness();
  assert.equal(await runCli(["sleeper", "preview", "owner_one"], p.deps), 0);
  assert.match(p.stdout.join("\n"), /Opponent: Rival FC/);

  const bad = harness();
  assert.equal(await runCli(["sleeper", "preview", "nobody"], bad.deps), 1);
  assert.match(bad.stderr.join("\n"), /No Sleeper user found/);
});

test("sleeper write is a dry run unless --confirm is passed", () =>
  withTempDir(async (dir) => {
    const file = join(dir, "action.json");
    await writeFile(file, JSON.stringify(LINEUP));
    const writer = new FakeSleeperWriteClient();

    const dry = harness(writer);
    assert.equal(await runCli(["sleeper", "write", "--action", file], dry.deps), 0);
    assert.match(dry.stdout.join("\n"), /dry_run:true[\s\S]*Dry run only\. Nothing was sent/);
    assert.equal(writer.executed.length, 0);

    const confirmed = harness(writer);
    assert.equal(await runCli(["sleeper", "write", "--action", file, "--confirm"], confirmed.deps), 0);
    assert.match(confirmed.stdout.join("\n"), /written:true/);
    assert.equal(writer.executed.length, 1);
  }));

test("sleeper write --confirm fails clearly without SLEEPER_TOKEN, and on a failed roster check", () =>
  withTempDir(async (dir) => {
    const file = join(dir, "action.json");
    await writeFile(file, JSON.stringify(LINEUP));
    const noToken = harness(null);
    assert.equal(await runCli(["sleeper", "write", "--action", file, "--confirm"], noToken.deps), 1);
    assert.match(noToken.stderr.join("\n"), /set SLEEPER_TOKEN/);

    const badFile = join(dir, "bad.json");
    await writeFile(badFile, JSON.stringify({ ...LINEUP, starters: ["34"] }));
    const writer = new FakeSleeperWriteClient();
    const bad = harness(writer);
    assert.equal(await runCli(["sleeper", "write", "--action", badFile, "--confirm"], bad.deps), 1);
    assert.match(bad.stderr.join("\n"), /Refusing to write/);
    assert.equal(writer.executed.length, 0);
  }));

test("pick'em: research, slip, the owner logs his manual entry, then settles it", () =>
  withTempDir(async (dir) => {
    const h = harness();
    assert.equal(await runCli(["sleeper", "pickem", "research", "--player", "Wes Wideout", "--stat", "rec_yd", "--line", "64.5"], h.deps), 0);
    assert.match(h.stdout.join("\n"), /grade:high/);

    h.stdout.length = 0;
    assert.equal(
      await runCli(["sleeper", "pickem", "research", "--sport", "mlb", "--player", "Ace Arm", "--stat", "strikeouts", "--line", "6.5", "--projection", "8.2"], h.deps),
      0,
    );
    assert.match(h.stdout.join("\n"), /sport:mlb[\s\S]*grade:high/);

    h.stdout.length = 0;
    assert.equal(
      await runCli(["sleeper", "pickem", "research", "--sport", "cfb", "--player", "Gunner Pass", "--stat", "passing yards", "--line", "250"], h.deps),
      0,
    );
    assert.match(h.stdout.join("\n"), /sport:cfb[\s\S]*grade:unknown \(no projection — ungraded thesis\)/);

    const badSport = harness();
    assert.equal(await runCli(["sleeper", "pickem", "research", "--sport", "nhl", "--player", "A", "--stat", "hits", "--line", "1.5"], badSport.deps), 1);
    assert.match(badSport.stderr.join("\n"), /Usage/);

    const badProj = harness();
    assert.equal(await runCli(["sleeper", "pickem", "research", "--player", "Wes Wideout", "--stat", "rec_yd", "--line", "64.5", "--projection", "80"], badProj.deps), 1);
    assert.match(badProj.stderr.join("\n"), /only for --sport mlb\|cfb/);

    const picks = join(dir, "picks.json");
    await writeFile(
      picks,
      JSON.stringify([
        { player: "Wes Wideout", stat: "rec_yd", line: 64.5, direction: "more" },
        { player: "Quinn Arm", stat: "pass_yd", line: 215.5, direction: "more" },
      ]),
    );
    h.stdout.length = 0;
    assert.equal(await runCli(["sleeper", "pickem", "slip", "--picks", picks, "--conviction", "standard"], h.deps), 0);
    const slipId = h.stdout.join("\n").match(/slipId:(slip-[0-9a-f]+)/)?.[1];
    assert.ok(slipId);

    assert.equal(await runCli(["sleeper", "pickem", "log", slipId as string, "--multiplier", "3", "--date", "2026-09-27"], h.deps), 0);
    const entryId = (await h.pickemStore.listEntries())[0]?.id as string;
    assert.equal(await runCli(["sleeper", "pickem", "settle", entryId, "--result", "won"], h.deps), 0);
    assert.match(h.stdout.join("\n"), /Available now: \$21\.00/);

    h.stdout.length = 0;
    assert.equal(await runCli(["sleeper", "pickem", "bankroll"], h.deps), 0);
    assert.match(h.stdout.join("\n"), /Settled: 1, P&L \$6\.00/);
  }));

test("there is no pick'em place/submit command", async () => {
  for (const sub of ["place", "submit", "enter"]) {
    const h = harness();
    assert.equal(await runCli(["sleeper", "pickem", sub], h.deps), 1);
    assert.match(h.stderr.join("\n"), /Usage:/);
  }
});
