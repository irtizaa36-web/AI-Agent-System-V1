import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import type { CliDeps } from "./index";
import { parseSleeperWriteAction } from "../integrations/sleeper/write-actions";
import { NOT_CONFIGURED, formatPreview, runSleeperWrite } from "../integrations/sleeper/write-gate";
import { formatMatchupPreview, formatWaiverReport, matchupPreview, resolveAccount, waiverRecommendations } from "../sleeper/monitoring";
import { computeBankroll } from "../sleeper/pickem/bankroll";
import { formatLineResearch, formatNonNflLineResearch, parsePickemSport, researchLine, researchNonNflLine } from "../sleeper/pickem/research";
import { buildSlip, parseSlipPicks } from "../sleeper/pickem/slip";
import { logManualEntry, settleEntry } from "../sleeper/pickem/store";
import { pickemToday } from "../tools/pickem-tools";

/**
 * `orchestrator sleeper ...` (ADR 0021). Monitoring and pick'em research are
 * read-only. `sleeper write` is a dry run unless --confirm is passed, and even
 * then it sends only an action that passes the live roster check. Nothing
 * here places a Sleeper Picks entry: `pickem log` records one the owner
 * already placed by hand.
 */

const USAGE = [
  "Usage:",
  "  orchestrator sleeper leagues <username> [--season 2026]",
  "  orchestrator sleeper preview <username> [--league <id>] [--week N]      Matchup preview with injury/bye alerts (all leagues if no --league)",
  "  orchestrator sleeper waivers <username> --league <id> [--week N] [--limit N]",
  "  orchestrator sleeper write --action <action.json> [--confirm]           Dry run by default; --confirm sends it",
  '  orchestrator sleeper pickem research --player "<name|id>" --stat <stat> --line <n> [--week N] [--sport nfl|mlb|cfb] [--projection <n>]',
  "  orchestrator sleeper pickem slip --picks <picks.json> --conviction standard|high [--stake n]",
  "  orchestrator sleeper pickem log <slipId> --multiplier <x> [--date YYYY-MM-DD]   After YOU placed it in the app",
  "  orchestrator sleeper pickem settle <entryId> --result won|lost|void [--payout n]",
  "  orchestrator sleeper pickem bankroll|entries",
].join("\n");

function weekOption(raw: string | undefined): number | undefined | "invalid" {
  if (raw === undefined) return undefined;
  const week = Number(raw);
  return Number.isInteger(week) && week >= 1 && week <= 18 ? week : "invalid";
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf-8"));
}

async function runPickem(args: readonly string[], deps: CliDeps): Promise<number> {
  const sleeper = deps.sleeper;
  if (!sleeper) {
    deps.stderr("Sleeper is not configured for this CLI invocation.");
    return 1;
  }
  const [sub, ...rest] = args;
  const store = sleeper.pickemStore;

  if (sub === "bankroll") {
    const s = computeBankroll(await store.listEntries());
    deps.stdout(`Available: $${s.available.toFixed(2)} (started $${s.starting.toFixed(2)})`);
    deps.stdout(`Open: ${s.openCount} entries, $${s.openExposure.toFixed(2)} at stake`);
    deps.stdout(`Settled: ${s.settledCount}, P&L $${s.realizedPnl.toFixed(2)}`);
    return 0;
  }

  if (sub === "entries") {
    const entries = await store.listEntries();
    if (entries.length === 0) deps.stdout("No entries logged yet.");
    for (const e of entries) {
      deps.stdout(`${e.id}  ${e.placedOn}  ${e.status.padEnd(4)}  $${e.stake.toFixed(2)} x${e.multiplier}  ${e.conviction}  ${e.picks.map((p) => p.player).join(", ")}`);
    }
    return 0;
  }

  if (sub === "research") {
    const { values } = parseArgs({
      args: [...rest],
      options: {
        player: { type: "string" },
        stat: { type: "string" },
        line: { type: "string" },
        week: { type: "string" },
        sport: { type: "string" },
        projection: { type: "string" },
      },
    });
    const line = Number(values.line);
    const week = weekOption(values.week);
    const sport = parsePickemSport(values.sport ?? "nfl");
    const projection = values.projection === undefined ? undefined : Number(values.projection);
    if (!values.player || !values.stat || !(line > 0) || week === "invalid" || sport === undefined || (projection !== undefined && !(projection >= 0))) {
      deps.stderr('Usage: orchestrator sleeper pickem research --player "<name|id>" --stat <stat> --line <n> [--week N] [--sport nfl|mlb|cfb] [--projection <n>]');
      return 1;
    }
    if (sport === "nfl") {
      if (projection !== undefined) {
        deps.stderr("Note: --projection is only for --sport mlb|cfb; NFL research always uses Sleeper's own projection.");
        return 1;
      }      const research = await researchLine(sleeper.readClient, { player: values.player, stat: values.stat, line, ...(week !== undefined ? { week } : {}) });
      deps.stdout(formatLineResearch(research));
      return 0;
    }
    const research = researchNonNflLine({
      sport,
      player: values.player,
      stat: values.stat,
      line,
      ...(projection !== undefined ? { projection } : {}),
    });
    if (week !== undefined) {
      deps.stderr("Note: --week is NFL-only and is ignored for --sport mlb|cfb.");
    }
    deps.stdout(formatNonNflLineResearch(research));
    return 0;
  }

  if (sub === "slip") {
    const { values } = parseArgs({ args: [...rest], options: { picks: { type: "string" }, conviction: { type: "string" }, stake: { type: "string" } } });
    if (!values.picks || (values.conviction !== "standard" && values.conviction !== "high")) {
      deps.stderr("Usage: orchestrator sleeper pickem slip --picks <picks.json> --conviction standard|high [--stake n]");
      return 1;
    }
    const picks = parseSlipPicks(await readJson(values.picks));
    if (!picks.ok) {
      deps.stderr(`Invalid picks: ${picks.error}`);
      return 1;
    }
    const result = buildSlip({
      picks: picks.picks,
      conviction: values.conviction,
      ledger: await store.listEntries(),
      day: pickemToday(),
      ...(values.stake !== undefined ? { requestedStake: Number(values.stake) } : {}),
    });
    if (!result.ok) {
      deps.stdout(`No slip: ${result.reason}`);
      return 0;
    }
    await store.saveSlip(result.slip);
    deps.stdout(result.text);
    return 0;
  }

  if (sub === "log") {
    const { values, positionals } = parseArgs({ args: [...rest], options: { multiplier: { type: "string" }, date: { type: "string" } }, allowPositionals: true });
    const slipId = positionals[0];
    if (!slipId || values.multiplier === undefined || (values.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(values.date))) {
      deps.stderr("Usage: orchestrator sleeper pickem log <slipId> --multiplier <x> [--date YYYY-MM-DD]");
      return 1;
    }
    const { entry, warnings } = await logManualEntry(store, { slipId, multiplier: Number(values.multiplier), ...(values.date ? { placedOn: values.date } : {}) });
    deps.stdout(`Logged ${entry.id}: $${entry.stake.toFixed(2)} at x${entry.multiplier}, placed by you on ${entry.placedOn}.`);
    for (const w of warnings) deps.stderr(`Warning: ${w}`);
    return 0;
  }

  if (sub === "settle") {
    const { values, positionals } = parseArgs({ args: [...rest], options: { result: { type: "string" }, payout: { type: "string" } }, allowPositionals: true });
    const entryId = positionals[0];
    const result = values.result;
    if (!entryId || (result !== "won" && result !== "lost" && result !== "void")) {
      deps.stderr("Usage: orchestrator sleeper pickem settle <entryId> --result won|lost|void [--payout n]");
      return 1;
    }
    const settled = await settleEntry(store, { entryId, result, ...(values.payout !== undefined ? { payout: Number(values.payout) } : {}) });
    const s = computeBankroll(await store.listEntries());
    deps.stdout(`Settled ${settled.id} as ${settled.status} (payout $${(settled.payout ?? 0).toFixed(2)}). Available now: $${s.available.toFixed(2)}.`);
    return 0;
  }

  deps.stderr(USAGE);
  return 1;
}

export async function runSleeperCommand(args: readonly string[], deps: CliDeps): Promise<number> {
  const sleeper = deps.sleeper;
  if (!sleeper) {
    deps.stderr("Sleeper is not configured for this CLI invocation.");
    return 1;
  }
  const [sub, ...rest] = args;

  try {
    if (sub === "pickem") return await runPickem(rest, deps);

    if (sub === "leagues") {
      const { values, positionals } = parseArgs({ args: [...rest], options: { season: { type: "string" } }, allowPositionals: true });
      if (!positionals[0]) {
        deps.stderr("Usage: orchestrator sleeper leagues <username> [--season 2026]");
        return 1;
      }
      const account = await resolveAccount(sleeper.readClient, positionals[0], values.season);
      deps.stdout(`${account.user.display_name} (@${account.user.username}) user_id ${account.user.user_id} — season ${account.season}, week ${account.week}`);
      if (account.leagues.length === 0) deps.stdout("No NFL leagues this season.");
      for (const l of account.leagues) deps.stdout(`  ${l.league_id}  ${l.name}  (${l.total_rosters} teams, ${l.status})`);
      return 0;
    }

    if (sub === "preview") {
      const { values, positionals } = parseArgs({ args: [...rest], options: { league: { type: "string" }, week: { type: "string" } }, allowPositionals: true });
      const week = weekOption(values.week);
      if (!positionals[0] || week === "invalid") {
        deps.stderr("Usage: orchestrator sleeper preview <username> [--league <id>] [--week N]");
        return 1;
      }
      const account = await resolveAccount(sleeper.readClient, positionals[0]);
      const leagueIds = values.league ? [values.league] : account.leagues.map((l) => l.league_id);
      if (leagueIds.length === 0) deps.stdout("No NFL leagues this season.");
      for (const [i, leagueId] of leagueIds.entries()) {
        if (i > 0) deps.stdout("");
        const preview = await matchupPreview(sleeper.readClient, { leagueId, userId: account.user.user_id, ...(week !== undefined ? { week } : {}) });
        deps.stdout(formatMatchupPreview(preview));
      }
      return 0;
    }

    if (sub === "waivers") {
      const { values, positionals } = parseArgs({
        args: [...rest],
        options: { league: { type: "string" }, week: { type: "string" }, limit: { type: "string" } },
        allowPositionals: true,
      });
      const week = weekOption(values.week);
      if (!positionals[0] || !values.league || week === "invalid") {
        deps.stderr("Usage: orchestrator sleeper waivers <username> --league <id> [--week N] [--limit N]");
        return 1;
      }
      const user = await sleeper.readClient.getUser(positionals[0]);
      const limit = values.limit !== undefined ? Number(values.limit) : undefined;
      const report = await waiverRecommendations(sleeper.readClient, {
        leagueId: values.league,
        userId: user.user_id,
        ...(week !== undefined ? { week } : {}),
        ...(limit !== undefined && Number.isInteger(limit) && limit > 0 ? { limit } : {}),
      });
      deps.stdout(formatWaiverReport(report));
      return 0;
    }

    if (sub === "write") {
      const { values } = parseArgs({ args: [...rest], options: { action: { type: "string" }, confirm: { type: "boolean", default: false } } });
      if (!values.action) {
        deps.stderr("Usage: orchestrator sleeper write --action <action.json> [--confirm]");
        return 1;
      }
      const parsed = parseSleeperWriteAction(await readJson(values.action));
      if (!parsed.ok) {
        deps.stderr(`Invalid action: ${parsed.error}`);
        return 1;
      }
      const [rosters, players] = await Promise.all([sleeper.readClient.getRosters(parsed.action.leagueId), sleeper.readClient.getPlayers()]);
      const dryRun = await runSleeperWrite(parsed.action, { confirm: false, rosters, players });
      deps.stdout(formatPreview(dryRun.preview));
      if (!values.confirm) {
        deps.stdout("\nDry run only. Nothing was sent. Re-run with --confirm to send exactly this change.");
        return 0;
      }
      if (!sleeper.writeClient) {
        deps.stderr(NOT_CONFIGURED);
        return 1;
      }
      const outcome = await runSleeperWrite(parsed.action, { confirm: true, client: sleeper.writeClient, rosters, players });
      deps.stdout(`\nwritten:true\nsleeperResponse:${JSON.stringify(outcome.dryRun ? null : outcome.result)}`);
      return 0;
    }
  } catch (error) {
    deps.stderr((error as Error).message);
    return 1;
  }

  deps.stderr(USAGE);
  return 1;
}
