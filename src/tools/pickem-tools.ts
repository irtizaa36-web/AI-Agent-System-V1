import type { Tool } from "./tool";
import type { SleeperReadClient } from "../integrations/sleeper/client";
import { STAKING_RULES, computeBankroll, playsOn, type Conviction } from "../sleeper/pickem/bankroll";
import { formatLineResearch, formatNonNflLineResearch, parsePickemSport, researchLine, researchNonNflLine } from "../sleeper/pickem/research";
import { buildSlip, parseSlipPicks } from "../sleeper/pickem/slip";
import type { PickemStore } from "../sleeper/pickem/store";

/**
 * Sleeper Picks Tools (ADR 0021). There is deliberately no Tool that places,
 * submits or enters anything: Sleeper Picks has no API, and every entry is
 * placed by the owner's own hand in the app. These research a line, report
 * the bankroll, and write out a slip. Logging a placed entry is CLI-only
 * (`orchestrator sleeper pickem log`), so a model can never record an entry
 * the owner didn't make.
 */

/** Today's date in the owner's timezone (PICKEM_TIMEZONE, default America/New_York) as YYYY-MM-DD. */
export function pickemToday(now: Date = new Date()): string {
  const timeZone = process.env["PICKEM_TIMEZONE"] || "America/New_York";
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function createPickemResearchLineTool(client: SleeperReadClient): Tool {
  return {
    name: "pickem-research-line",
    description:
      "Compares one Sleeper Picks line (copied from the app by the owner) with a projection: lean MORE/LESS, edge %, and a grade (high, standard, or weak = skip). NFL uses Sleeper's own weekly projection; MLB/CFB grade only against an owner-supplied projection, or return an ungraded thesis without one. Read-only research.",
    inputSchema: {
      type: "object",
      properties: {
        player: { type: "string", description: "Full name as Sleeper shows it, or the Sleeper player id (NFL only; MLB/CFB take a plain name)" },
        stat: { type: "string", description: "e.g. \"receiving yards\" or a key like rec_yd (NFL); \"strikeouts\", \"hits\" (MLB); \"passing yards\" (CFB)" },
        line: { type: "number" },
        week: { type: "integer", minimum: 1, maximum: 18, description: "NFL only" },
        sport: { type: "string", enum: ["nfl", "mlb", "cfb"], description: "Defaults to nfl" },
        projection: { type: "number", description: "Owner-supplied projection; required to grade MLB/CFB lines, rejected for NFL" },
      },
      required: ["player", "stat", "line"],
    },
    async execute(input: unknown): Promise<string> {
      const v = (input ?? {}) as Record<string, unknown>;
      if (typeof v["player"] !== "string" || typeof v["stat"] !== "string" || typeof v["line"] !== "number") {
        throw new Error('pickem-research-line requires { "player": string, "stat": string, "line": number }');
      }
      const sport = parsePickemSport(v["sport"] ?? "nfl");
      if (sport === undefined) throw new Error('pickem-research-line "sport" must be one of nfl, mlb, cfb');
      if (sport !== "nfl") {
        const projection = v["projection"];
        if (projection !== undefined && (typeof projection !== "number" || !(projection >= 0))) {
          throw new Error('pickem-research-line "projection" must be a non-negative number');
        }
        return formatNonNflLineResearch(
          researchNonNflLine({
            sport,
            player: v["player"],
            stat: v["stat"],
            line: v["line"],
            ...(projection !== undefined ? { projection: projection as number } : {}),
          }),
        );
      }
      if (v["projection"] !== undefined) throw new Error('pickem-research-line "projection" is only for sport mlb|cfb');
      const research = await researchLine(client, {
        player: v["player"],
        stat: v["stat"],
        line: v["line"],
        ...(typeof v["week"] === "number" ? { week: v["week"] } : {}),
      });
      return formatLineResearch(research);
    },
  };
}

export function createPickemBankrollStatusTool(store: PickemStore): Tool {
  return {
    name: "pickem-bankroll-status",
    description: "Reports the Sleeper Picks bankroll from the owner's manual entry log: available, open exposure, P&L, plays today, and the staking rules. Read-only.",
    inputSchema: { type: "object", properties: {} },
    async execute(): Promise<string> {
      const entries = await store.listEntries();
      const state = computeBankroll(entries);
      const today = pickemToday();
      return [
        `startingBankroll:$${state.starting.toFixed(2)}`,
        `available:$${state.available.toFixed(2)}`,
        `openExposure:$${state.openExposure.toFixed(2)} (${state.openCount} open)`,
        `realizedPnl:$${state.realizedPnl.toFixed(2)} (${state.settledCount} settled)`,
        `playsToday:${playsOn(entries, today)} of ${STAKING_RULES.maxPlaysPerDay} (${today})`,
        `rules:standard $${STAKING_RULES.standardMinStake}-$${STAKING_RULES.standardMaxStake}; high conviction up to 50% of available, never 100%; max ${STAKING_RULES.maxPlaysPerDay} plays/day; skip weak days`,
      ].join("\n");
    },
  };
}

export function createPickemBuildSlipTool(store: PickemStore): Tool {
  return {
    name: "pickem-build-slip",
    description:
      "Writes out the exact Sleeper Picks slip for the owner to enter by hand (picks, stake under the owner's staking rules, bankroll before/after). Cannot place it. Refuses weak picks, over-limit stakes, and a third play in a day.",
    inputSchema: {
      type: "object",
      properties: {
        picks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              player: { type: "string" },
              playerId: { type: "string" },
              position: { type: "string" },
              team: { type: "string" },
              stat: { type: "string" },
              line: { type: "number" },
              direction: { type: "string", enum: ["more", "less"] },
              projection: { type: "number" },
              edgePct: { type: "number" },
              grade: { type: "string", enum: ["high", "standard", "weak"] },
            },
            required: ["player", "stat", "line", "direction"],
          },
        },
        conviction: { type: "string", enum: ["standard", "high"] },
        stake: { type: "number", description: "Optional; omitted means the rule's recommended stake" },
      },
      required: ["picks", "conviction"],
    },
    async execute(input: unknown): Promise<string> {
      const v = (input ?? {}) as Record<string, unknown>;
      const conviction = v["conviction"];
      if (conviction !== "standard" && conviction !== "high") throw new Error('pickem-build-slip: "conviction" must be "standard" or "high"');
      const picks = parseSlipPicks(v["picks"]);
      if (!picks.ok) throw new Error(`pickem-build-slip: ${picks.error}`);
      const stake = v["stake"];
      const result = buildSlip({
        picks: picks.picks,
        conviction: conviction as Conviction,
        ledger: await store.listEntries(),
        day: pickemToday(),
        ...(typeof stake === "number" ? { requestedStake: stake } : {}),
      });
      if (!result.ok) return `slip:none\nreason:${result.reason}`;
      await store.saveSlip(result.slip);
      return result.text;
    },
  };
}
