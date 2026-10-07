import { playerName, type PlayerMap, type SleeperPlayer, type SleeperReadClient } from "../../integrations/sleeper/client";
import type { Conviction } from "./bankroll";

/**
 * Projection research for Sleeper Picks lines (ADR 0021). Read-only: it
 * compares a line the owner copies from the Sleeper app against Sleeper's own
 * weekly projection for that stat. It has no information edge beyond that
 * projection, and it says so. It never places anything.
 */

/** Plain-English stat names mapped to Sleeper's projection keys. */
export const STAT_ALIASES: Readonly<Record<string, string>> = {
  "passing yards": "pass_yd",
  "pass yards": "pass_yd",
  "passing tds": "pass_td",
  "pass tds": "pass_td",
  "rushing yards": "rush_yd",
  "rush yards": "rush_yd",
  "rushing attempts": "rush_att",
  "receiving yards": "rec_yd",
  "rec yards": "rec_yd",
  receptions: "rec",
  "rush + rec yards": "rush_rec_yd",
  "rush+rec yards": "rush_rec_yd",
  "fantasy points": "pts_ppr",
};

/** Stats that aren't projected directly but are sums of ones that are. */
const COMBINED: Readonly<Record<string, readonly string[]>> = {
  rush_rec_yd: ["rush_yd", "rec_yd"],
  pass_rush_yd: ["pass_yd", "rush_yd"],
};

export function resolveStatKey(stat: string): string {
  const normalized = stat.trim().toLowerCase();
  return STAT_ALIASES[normalized] ?? normalized.replace(/\s+/g, "_");
}

/** Sports the pick'em research module covers. NFL is graded against Sleeper's
 * own projections; MLB and CFB have no Sleeper projection source (see ADR
 * 0023), so they grade only against a projection the owner supplies, or stay
 * ungraded as a news/form thesis. */
export type PickemSport = "nfl" | "mlb" | "cfb";

export const PICKEM_SPORTS: readonly PickemSport[] = ["nfl", "mlb", "cfb"];

export function parsePickemSport(raw: unknown): PickemSport | undefined {
  if (typeof raw !== "string") return undefined;
  const normalized = raw.trim().toLowerCase();
  return (PICKEM_SPORTS as readonly string[]).includes(normalized) ? (normalized as PickemSport) : undefined;
}

/** Plain-English MLB stat names mapped to Sleeper-style snake_case keys.
 * Sleeper Picks shows these as e.g. "Strikeouts", "Hits", "Home Runs". */
export const MLB_STAT_ALIASES: Readonly<Record<string, string>> = {
  strikeouts: "so",
  "pitcher strikeouts": "pitching_so",
  "strikeouts pitched": "pitching_so",
  hits: "h",
  "hits allowed": "hits_allowed",
  "home runs": "hr",
  homers: "hr",
  rbis: "rbi",
  "runs batted in": "rbi",
  runs: "r",
  "runs scored": "r",
  "stolen bases": "sb",
  steals: "sb",
  "total bases": "tb",
  "bases on balls": "bb",
  walks: "bb",
  "earned runs": "er",
  "innings pitched": "ip",
  "pitching outs": "pitching_outs",
};

/** Plain-English CFB stat names mapped to Sleeper-style snake_case keys.
 * Keys mirror the NFL set where the stat is the same. */
export const CFB_STAT_ALIASES: Readonly<Record<string, string>> = {
  "passing yards": "pass_yd",
  "pass yards": "pass_yd",
  "passing tds": "pass_td",
  "pass tds": "pass_td",
  "passing touchdowns": "pass_td",
  "rushing yards": "rush_yd",
  "rush yards": "rush_yd",
  "rushing tds": "rush_td",
  "rushing touchdowns": "rush_td",
  "receiving yards": "rec_yd",
  "rec yards": "rec_yd",
  receptions: "rec",
  catches: "rec",
  touchdowns: "td",
  "total touchdowns": "td",
  "rush + rec yards": "rush_rec_yd",
  "rush+rec yards": "rush_rec_yd",
  "all-purpose yards": "rush_rec_yd",
  "fantasy points": "pts_ppr",
  interceptions: "pass_int",
  "interceptions thrown": "pass_int",
};

const SPORT_ALIASES: Readonly<Record<PickemSport, Readonly<Record<string, string>>>> = {
  nfl: STAT_ALIASES,
  mlb: MLB_STAT_ALIASES,
  cfb: CFB_STAT_ALIASES,
};

/** Resolves a stat name to its canonical key for the given sport. */
export function resolveStatKeyForSport(stat: string, sport: PickemSport): string {
  const normalized = stat.trim().toLowerCase();
  return SPORT_ALIASES[sport][normalized] ?? normalized.replace(/\s+/g, "_");
}

export type LineGrade = Conviction | "weak";

export interface LineAssessment {
  readonly direction: "more" | "less";
  /** (projection − line) / line, as a percentage; positive favours MORE. */
  readonly edgePct: number;
  readonly grade: LineGrade;
}

/** Edge thresholds: ≥20% off the line is high conviction, ≥10% standard, anything closer is weak (skip). */
export const EDGE_THRESHOLDS = { high: 20, standard: 10 } as const;

export function assessLine(projection: number, line: number): LineAssessment {
  if (!(line > 0)) throw new Error("The line must be a positive number.");
  const edgePct = Math.round(((projection - line) / line) * 1000) / 10;
  const size = Math.abs(edgePct);
  return {
    direction: edgePct >= 0 ? "more" : "less",
    edgePct,
    grade: size >= EDGE_THRESHOLDS.high ? "high" : size >= EDGE_THRESHOLDS.standard ? "standard" : "weak",
  };
}

/** Finds exactly one player by name (case-insensitive, active players first) or explains the ambiguity. */
export function findPlayer(players: PlayerMap, query: string): SleeperPlayer {
  const trimmed = query.trim();
  const byId = players[trimmed];
  if (byId) return byId;
  const all = Object.values(players).filter((p) => playerName(p, p.player_id).toLowerCase() === trimmed.toLowerCase());
  // A retired namesake has no team; prefer players currently on one.
  const onTeam = all.filter((p) => p.team);
  const matches = onTeam.length > 0 ? onTeam : all;
  if (matches.length === 1) return matches[0] as SleeperPlayer;
  if (matches.length === 0) throw new Error(`No player named "${query}". Use the full name as Sleeper shows it, or the Sleeper player id.`);
  throw new Error(
    `"${query}" matches ${matches.length} players: ${matches.map((p) => `${playerName(p, p.player_id)} (${p.position ?? "?"}, ${p.team ?? "FA"}) id ${p.player_id}`).join("; ")}. Use the id.`,
  );
}

export interface LineResearch {
  readonly player: { readonly id: string; readonly name: string; readonly position: string | null; readonly team: string | null; readonly injuryStatus: string | null };
  readonly statKey: string;
  readonly line: number;
  readonly week: number;
  readonly projection: number | undefined;
  readonly assessment: LineAssessment | undefined;
  readonly caveats: readonly string[];
}

export async function researchLine(
  client: SleeperReadClient,
  input: { readonly player: string; readonly stat: string; readonly line: number; readonly week?: number; readonly season?: string },
): Promise<LineResearch> {
  const [players, state] = await Promise.all([client.getPlayers(), client.getNflState()]);
  const player = findPlayer(players, input.player);
  const week = input.week ?? (state.display_week || state.week);
  const season = input.season ?? state.season;
  const statKey = resolveStatKey(input.stat);
  const caveats: string[] = [];

  let projection: number | undefined;
  try {
    const rows = await client.getProjections(season, week, [player.position ?? ""]);
    const stats = rows.find((r) => r.player_id === player.player_id)?.stats;
    if (stats) {
      const parts = COMBINED[statKey];
      projection = parts ? parts.reduce((sum, key) => sum + (stats[key] ?? 0), 0) : stats[statKey];
      if (projection !== undefined) projection = Math.round(projection * 100) / 100;
    }
    if (projection === undefined) caveats.push(`Sleeper has no "${statKey}" projection for this player in week ${week}.`);
  } catch {
    caveats.push("Sleeper's projections endpoint (undocumented) was unavailable.");
  }
  if (player.injury_status) caveats.push(`Injury status: ${player.injury_status}. A limited player can miss any line.`);
  caveats.push("The only input is Sleeper's own projection; the line setter sees it too. This is research, not an edge guarantee.");

  return {
    player: { id: player.player_id, name: playerName(player, player.player_id), position: player.position, team: player.team, injuryStatus: player.injury_status },
    statKey,
    line: input.line,
    week,
    projection,
    assessment: projection === undefined ? undefined : assessLine(projection, input.line),
    caveats,
  };
}

export function formatLineResearch(r: LineResearch): string {
  return [
    `player:${r.player.name} (${r.player.position ?? "?"}, ${r.player.team ?? "FA"}) id ${r.player.id}`,
    `stat:${r.statKey}`,
    `line:${r.line}`,
    `week:${r.week}`,
    `projection:${r.projection ?? "unavailable"}`,
    ...(r.assessment
      ? [`lean:${r.assessment.direction.toUpperCase()}`, `edgePct:${r.assessment.edgePct}`, `grade:${r.assessment.grade}${r.assessment.grade === "weak" ? " (skip)" : ""}`]
      : ["grade:unknown (no projection — skip)"]),
    ...r.caveats.map((c) => `caveat:${c}`),
  ].join("\n");
}

/** Research for a non-NFL Sleeper Picks line (ADR 0023). Pure: no Sleeper
 * client, no network — Sleeper exposes no MLB/CFB projection endpoints, so
 * the only numeric input beyond the line is a projection the owner supplies
 * (from the Sleeper app, another projections source, or his own number).
 * Without one, the result is an ungraded thesis: direction unknown, and it
 * can never earn a conviction grade. Grading reuses the same edge thresholds
 * as NFL (`assessLine`). */
export interface NonNflLineResearch {
  readonly sport: Exclude<PickemSport, "nfl">;
  readonly player: string;
  readonly statKey: string;
  readonly line: number;
  readonly projection: number | undefined;
  readonly assessment: LineAssessment | undefined;
  readonly caveats: readonly string[];
}

export function researchNonNflLine(input: {
  readonly sport: Exclude<PickemSport, "nfl">;
  readonly player: string;
  readonly stat: string;
  readonly line: number;
  readonly projection?: number;
}): NonNflLineResearch {
  const player = input.player.trim();
  if (!player) throw new Error("researchNonNflLine requires a non-empty player name.");
  if (!(input.line > 0)) throw new Error("The line must be a positive number.");
  if (input.projection !== undefined && !(input.projection >= 0)) {
    throw new Error("The projection must be a non-negative number.");
  }
  const statKey = resolveStatKeyForSport(input.stat, input.sport);
  const caveats: string[] = [
    `No independent ${input.sport.toUpperCase()} projection source: Sleeper's API is NFL-only (ADR 0021).`,
  ];
  if (input.projection === undefined) {
    caveats.push("No projection supplied — this is an ungraded news/form thesis, not a graded edge. It cannot earn a conviction grade; skip unless the owner's own thesis is strong.");
  } else {
    caveats.push("Graded against an owner-supplied projection, not an independent one. The line setter may see the same number — this is research, not an edge guarantee.");
  }
  return {
    sport: input.sport,
    player,
    statKey,
    line: input.line,
    projection: input.projection,
    assessment: input.projection === undefined ? undefined : assessLine(input.projection, input.line),
    caveats,
  };
}

export function formatNonNflLineResearch(r: NonNflLineResearch): string {
  return [
    `sport:${r.sport}`,
    `player:${r.player}`,
    `stat:${r.statKey}`,
    `line:${r.line}`,
    `projection:${r.projection ?? "unavailable"}`,
    ...(r.assessment
      ? [`lean:${r.assessment.direction.toUpperCase()}`, `edgePct:${r.assessment.edgePct}`, `grade:${r.assessment.grade}${r.assessment.grade === "weak" ? " (skip)" : ""}`]
      : ["grade:unknown (no projection — ungraded thesis)"]),
    ...r.caveats.map((c) => `caveat:${c}`),
  ].join("\n");
}
