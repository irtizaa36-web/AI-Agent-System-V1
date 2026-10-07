import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STAKING_RULES, computeBankroll, decideStake, type LedgerEntry } from "./bankroll";
import { assessLine, findPlayer, formatNonNflLineResearch, parsePickemSport, researchLine, researchNonNflLine, resolveStatKey, resolveStatKeyForSport } from "./research";
import { buildSlip, parseSlipPicks, type SlipPick } from "./slip";
import { InMemoryPickemStore, JsonFilePickemStore, logManualEntry, settleEntry } from "./store";
import { fixtureClient, PLAYERS } from "../test-fixtures";

const DAY = "2026-09-27";
const PICKS: SlipPick[] = [
  { player: "Wes Wideout", stat: "rec_yd", line: 64.5, direction: "more", projection: 78.2, edgePct: 21.2, grade: "high" },
  { player: "Quinn Arm", stat: "pass_yd", line: 215.5, direction: "more", projection: 260, edgePct: 20.6, grade: "high" },
];

function entry(stake: number, status: LedgerEntry["status"], payout?: number, placedOn = "2026-09-20"): LedgerEntry {
  return { stake, status, placedOn, ...(payout !== undefined ? { payout } : {}) };
}

test("the owner's staking rules are the ones in code", () => {
  assert.equal(STAKING_RULES.startingBankroll, 15);
  assert.equal(STAKING_RULES.standardMinStake, 3);
  assert.equal(STAKING_RULES.standardMaxStake, 4);
  assert.equal(STAKING_RULES.highConvictionMaxFraction, 0.5);
  assert.equal(STAKING_RULES.maxPlaysPerDay, 2);
});

test("bankroll: stakes leave when placed, payouts return when settled, voids refund", () => {
  assert.deepEqual(computeBankroll([]), { starting: 15, available: 15, openExposure: 0, realizedPnl: 0, settledCount: 0, openCount: 0 });
  const state = computeBankroll([entry(3, "won", 9), entry(4, "lost"), entry(3, "void"), entry(3, "open")]);
  assert.equal(state.available, 14); // 15 − 13 staked + 9 + 3 refunded
  assert.equal(state.openExposure, 3);
  assert.equal(state.realizedPnl, 2); // +6 −4 +0
  assert.equal(state.openCount, 1);
});

test("standard plays stake $3–$4: $3 at a $15 bankroll, $4 once it's $20+", () => {
  assert.deepEqual(decideStake({ conviction: "standard", available: 15, playsToday: 0 }), { ok: true, stake: 3, note: "Standard play: $3.00 of $15.00 available." });
  assert.equal((decideStake({ conviction: "standard", available: 24, playsToday: 0 }) as { stake: number }).stake, 4);
  assert.equal(decideStake({ conviction: "standard", available: 15, playsToday: 0, requestedStake: 4 }).ok, true);
  assert.match((decideStake({ conviction: "standard", available: 15, playsToday: 0, requestedStake: 5 }) as { reason: string }).reason, /\$3–\$4/);
  assert.match((decideStake({ conviction: "standard", available: 15, playsToday: 0, requestedStake: 2 }) as { reason: string }).reason, /\$3–\$4/);
  assert.match((decideStake({ conviction: "standard", available: 2.5, playsToday: 0 }) as { reason: string }).reason, /below the \$3 standard stake/);
  assert.match((decideStake({ conviction: "standard", available: 3, playsToday: 0 }) as { reason: string }).reason, /Never stake 100%/);
});

test("high-conviction plays are capped at 50% of the bankroll and can never be all of it", () => {
  assert.equal((decideStake({ conviction: "high", available: 15, playsToday: 0 }) as { stake: number }).stake, 7.5);
  assert.equal(decideStake({ conviction: "high", available: 15, playsToday: 0, requestedStake: 6 }).ok, true);
  assert.match((decideStake({ conviction: "high", available: 15, playsToday: 0, requestedStake: 7.51 }) as { reason: string }).reason, /capped at 50%/);
  assert.match((decideStake({ conviction: "high", available: 15, playsToday: 0, requestedStake: 15 }) as { reason: string }).reason, /capped at 50%/);
  assert.match((decideStake({ conviction: "high", available: 1.5, playsToday: 0 }) as { reason: string }).reason, /below Sleeper's \$1 minimum/);
});

test("max 1–2 plays a day", () => {
  assert.equal(decideStake({ conviction: "standard", available: 15, playsToday: 1 }).ok, true);
  assert.match((decideStake({ conviction: "standard", available: 15, playsToday: 2 }) as { reason: string }).reason, /limit is 2/);
  assert.match((decideStake({ conviction: "standard", available: 15, playsToday: 1, maxPlaysToday: 1 }) as { reason: string }).reason, /limit is 1/);
  assert.equal(decideStake({ conviction: "standard", available: 15, playsToday: 1, maxPlaysToday: 9 }).ok, true);
  assert.match((decideStake({ conviction: "high", available: 15, playsToday: 2, maxPlaysToday: 9 }) as { reason: string }).reason, /limit is 2/, "can't raise past 2");
});

test("line grading: ≥20% edge is high, ≥10% standard, closer is weak", () => {
  assert.deepEqual(assessLine(78.2, 64.5), { direction: "more", edgePct: 21.2, grade: "high" });
  assert.deepEqual(assessLine(55, 60), { direction: "less", edgePct: -8.3, grade: "weak" });
  assert.equal(assessLine(72, 64.5).grade, "standard");
  assert.throws(() => assessLine(10, 0), /positive/);
  assert.equal(resolveStatKey("Receiving Yards"), "rec_yd");
  assert.equal(resolveStatKey("rush_yd"), "rush_yd");
});

test("stat aliases resolve per sport", () => {
  assert.equal(resolveStatKeyForSport("Receiving Yards", "nfl"), "rec_yd");
  assert.equal(resolveStatKeyForSport("Strikeouts", "mlb"), "so");
  assert.equal(resolveStatKeyForSport("Pitcher Strikeouts", "mlb"), "pitching_so");
  assert.equal(resolveStatKeyForSport("Home Runs", "mlb"), "hr");
  assert.equal(resolveStatKeyForSport("RBIs", "mlb"), "rbi");
  assert.equal(resolveStatKeyForSport("Stolen Bases", "mlb"), "sb");
  assert.equal(resolveStatKeyForSport("Total Bases", "mlb"), "tb");
  assert.equal(resolveStatKeyForSport("Passing Yards", "cfb"), "pass_yd");
  assert.equal(resolveStatKeyForSport("Rushing Yards", "cfb"), "rush_yd");
  assert.equal(resolveStatKeyForSport("Receptions", "cfb"), "rec");
  assert.equal(resolveStatKeyForSport("Touchdowns", "cfb"), "td");
  assert.equal(resolveStatKeyForSport("slugging percentage", "mlb"), "slugging_percentage", "unknown stats fall back to snake_case");
  assert.equal(resolveStatKey("Receiving Yards"), "rec_yd", "NFL alias resolution is unchanged");
});

test("parsePickemSport accepts nfl/mlb/cfb and rejects the rest", () => {
  assert.equal(parsePickemSport("nfl"), "nfl");
  assert.equal(parsePickemSport("MLB"), "mlb");
  assert.equal(parsePickemSport(" cfb "), "cfb");
  assert.equal(parsePickemSport("nhl"), undefined);
  assert.equal(parsePickemSport(undefined), undefined);
  assert.equal(parsePickemSport(42), undefined);
});

test("researchNonNflLine grades against an owner-supplied projection with NFL thresholds", () => {
  const graded = researchNonNflLine({ sport: "mlb", player: "Ace Arm", stat: "strikeouts", line: 6.5, projection: 8.2 });
  assert.equal(graded.statKey, "so");
  assert.deepEqual(graded.assessment, assessLine(8.2, 6.5));
  assert.equal(graded.assessment?.grade, "high");
  assert.ok(graded.caveats.some((c) => /owner-supplied projection/.test(c)));

  const weak = researchNonNflLine({ sport: "cfb", player: "Gunner Pass", stat: "passing yards", line: 250, projection: 262 });
  assert.equal(weak.assessment?.grade, "weak");

  const out = formatNonNflLineResearch(graded);
  assert.match(out, /sport:mlb/);
  assert.match(out, /player:Ace Arm/);
  assert.match(out, /stat:so/);
  assert.match(out, /lean:MORE/);
  assert.match(out, /grade:high/);
});

test("researchNonNflLine without a projection is an ungraded thesis, never a grade", () => {
  const thesis = researchNonNflLine({ sport: "mlb", player: "Ace Arm", stat: "hits", line: 1.5 });
  assert.equal(thesis.assessment, undefined);
  assert.ok(thesis.caveats.some((c) => /ungraded news\/form thesis/.test(c)));
  assert.match(formatNonNflLineResearch(thesis), /grade:unknown \(no projection — ungraded thesis\)/);
});

test("researchNonNflLine validates its inputs", () => {
  assert.throws(() => researchNonNflLine({ sport: "mlb", player: "  ", stat: "hits", line: 1.5 }), /non-empty player/);
  assert.throws(() => researchNonNflLine({ sport: "mlb", player: "Ace", stat: "hits", line: 0 }), /positive/);
  assert.throws(() => researchNonNflLine({ sport: "cfb", player: "Ace", stat: "hits", line: 1.5, projection: -1 }), /non-negative/);
});

test("player lookup by name is exact and refuses to guess between namesakes", () => {
  assert.equal(findPlayer(PLAYERS, "wes wideout").player_id, "14");
  assert.equal(findPlayer(PLAYERS, "14").player_id, "14");
  assert.throws(() => findPlayer(PLAYERS, "Same Name"), /matches 2 players.*Use the id/);
  assert.throws(() => findPlayer(PLAYERS, "Nobody Here"), /No player named/);
});

test("researchLine compares the owner's line to Sleeper's projection", async () => {
  const r = await researchLine(fixtureClient(), { player: "Wes Wideout", stat: "receiving yards", line: 64.5 });
  assert.equal(r.projection, 78.2);
  assert.deepEqual(r.assessment, { direction: "more", edgePct: 21.2, grade: "high" });
  assert.ok(r.caveats.some((c) => /not an edge guarantee/.test(c)));

  const combined = await researchLine(fixtureClient(), { player: "Rex Runner", stat: "rush + rec yards", line: 80 });
  assert.equal(combined.projection, 90);

  const down = await researchLine(fixtureClient({ undocumentedEndpointsDown: true }), { player: "Wes Wideout", stat: "rec_yd", line: 64.5 });
  assert.equal(down.assessment, undefined);
  assert.ok(down.caveats.some((c) => /unavailable/.test(c)));
});

test("buildSlip writes the exact manual-entry slip under the staking rules", () => {
  const result = buildSlip({ picks: PICKS, conviction: "standard", ledger: [], day: DAY, now: new Date("2026-09-27T12:00:00Z") });
  assert.ok(result.ok);
  if (!result.ok) return;
  assert.equal(result.slip.stake, 3);
  assert.match(result.text, /MANUAL ENTRY ONLY/);
  assert.match(result.text, /has not placed this one/);
  assert.match(result.text, /1\. Wes Wideout — MORE than 64\.5 rec_yd — proj 78\.2, edge \+21\.2%/);
  assert.match(result.text, /availableAfter:\$12\.00/);
  assert.match(result.text, new RegExp(`pickem log ${result.slip.id} --multiplier`));
  const again = buildSlip({ picks: PICKS, conviction: "standard", ledger: [], day: DAY });
  assert.equal(again.ok && again.slip.id, result.slip.id, "same slip, same id");
});

test("buildSlip refuses weak picks, bad sizes, duplicates, mismatched conviction, and a third play", () => {
  const reason = (r: ReturnType<typeof buildSlip>): string => (r.ok ? "" : r.reason);
  assert.match(reason(buildSlip({ picks: [PICKS[0] as SlipPick], conviction: "standard", ledger: [], day: DAY })), /needs 2–6 picks/);
  assert.match(reason(buildSlip({ picks: [PICKS[0] as SlipPick, PICKS[0] as SlipPick], conviction: "standard", ledger: [], day: DAY })), /only once/);
  assert.match(
    reason(buildSlip({ picks: [PICKS[0] as SlipPick, { ...(PICKS[1] as SlipPick), grade: "weak" }], conviction: "standard", ledger: [], day: DAY })),
    /On a weak day, skip/,
  );
  assert.match(
    reason(buildSlip({ picks: [PICKS[0] as SlipPick, { ...(PICKS[1] as SlipPick), grade: "standard" }], conviction: "high", ledger: [], day: DAY })),
    /every graded pick to be graded high/,
  );
  const twoToday = [entry(3, "open", undefined, DAY), entry(3, "open", undefined, DAY)];
  assert.match(reason(buildSlip({ picks: PICKS, conviction: "standard", ledger: twoToday, day: DAY })), /limit is 2/);
  assert.match(reason(buildSlip({ picks: PICKS, conviction: "high", requestedStake: 10, ledger: [], day: DAY })), /capped at 50%/);
});

test("parseSlipPicks validates untrusted input", () => {
  assert.equal(parseSlipPicks(PICKS).ok, true);
  assert.equal(parseSlipPicks("nope").ok, false);
  assert.equal(parseSlipPicks([{ player: "A", stat: "rec", line: 5, direction: "over" }]).ok, false);
  assert.equal(parseSlipPicks([{ player: "A", stat: "rec", line: -1, direction: "more" }]).ok, false);
});

test("the manual log records only what the owner reports, then settles it into the bankroll", async () => {
  const store = new InMemoryPickemStore();
  const slip = buildSlip({ picks: PICKS, conviction: "high", ledger: [], day: DAY });
  assert.ok(slip.ok);
  if (!slip.ok) return;
  await store.saveSlip(slip.slip);
  assert.equal(computeBankroll(await store.listEntries()).available, 15, "an unlogged slip doesn't touch the bankroll");

  await assert.rejects(logManualEntry(store, { slipId: "slip-missing", multiplier: 3 }), /No slip/);
  await assert.rejects(logManualEntry(store, { slipId: slip.slip.id, multiplier: 1 }), /multiplier/);
  const { entry: logged, warnings } = await logManualEntry(store, { slipId: slip.slip.id, multiplier: 3 });
  assert.deepEqual(warnings, []);
  assert.equal(logged.stake, 7.5);
  assert.equal(computeBankroll(await store.listEntries()).available, 7.5);
  await assert.rejects(logManualEntry(store, { slipId: slip.slip.id, multiplier: 3 }), /already logged/);

  const settled = await settleEntry(store, { entryId: logged.id, result: "won" });
  assert.equal(settled.payout, 22.5);
  assert.equal(computeBankroll(await store.listEntries()).available, 30);
  await assert.rejects(settleEntry(store, { entryId: logged.id, result: "lost" }), /already settled/);
});

test("logging a third play the owner already made is recorded truthfully, with a warning", async () => {
  const store = new InMemoryPickemStore();
  for (const [i, extra] of ["A", "B", "C"].entries()) {
    const picks = [{ ...(PICKS[0] as SlipPick), player: `Player ${extra}` }, PICKS[1] as SlipPick];
    const ledger = i < 2 ? await store.listEntries() : [];
    const slip = buildSlip({ picks, conviction: "standard", ledger, day: DAY });
    assert.ok(slip.ok);
    if (!slip.ok) return;
    await store.saveSlip(slip.slip);
    const { warnings } = await logManualEntry(store, { slipId: slip.slip.id, multiplier: 3 });
    assert.equal(warnings.length, i < 2 ? 0 : 1);
  }
});

test("JsonFilePickemStore persists slips and entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pickem-"));
  try {
    const path = join(dir, "sleeper", "pickem.json");
    const store = new JsonFilePickemStore(path);
    assert.deepEqual(await store.listEntries(), []);
    const slip = buildSlip({ picks: PICKS, conviction: "standard", ledger: [], day: DAY });
    assert.ok(slip.ok);
    if (!slip.ok) return;
    await store.saveSlip(slip.slip);
    await logManualEntry(store, { slipId: slip.slip.id, multiplier: 3 });
    const reopened = new JsonFilePickemStore(path);
    assert.equal((await reopened.getSlip(slip.slip.id))?.stake, 3);
    assert.equal((await reopened.listEntries()).length, 1);
    assert.match(await readFile(path, "utf-8"), /"placedOn": "2026-09-27"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the pick'em module has no way to reach Sleeper Picks: no network calls and nothing that places an entry", async () => {
  const dir = __dirname;
  for (const file of (await readdir(dir)).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js"))) {
    const source = await readFile(join(dir, file), "utf-8");
    assert.doesNotMatch(source, /\bfetch\s*\(|https?:\/\/|require\("node:https?"\)|playwright/i, `${file} must not do network I/O`);
    assert.doesNotMatch(source, /exports\.\w*(place|submit|enter)\w*\s*=/i, `${file} must not export a placement function`);
  }
});
