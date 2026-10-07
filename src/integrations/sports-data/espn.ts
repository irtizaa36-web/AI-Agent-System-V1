/**
 * The ESPN read port: scoreboard/schedule, news, and player injuries from
 * ESPN's unofficial APIs. No key needed, fully read-only.
 *
 * - Scoreboard + news: site API (https://site.api.espn.com/apis/site/v2/sports/football/nfl).
 * - Injuries: core API (https://sports.core.api.espn.com/...), where a
 *   team's injury list is a set of `$ref` links that must be followed: one
 *   fetch for the injury detail, one more for the athlete's name. Injuries
 *   are capped per team so a Sunday sweep stays bounded.
 *
 * Field names follow ESPN's wire format (camelCase here — ESPN's APIs use
 * camelCase, unlike Sleeper's snake_case) so raw responses pass through
 * without translation. Only fields the agent reads are declared. Every
 * method degrades to an empty list when ESPN is unreachable or changes
 * shape — never throws through the caller.
 */

import { getJson, type HttpGetOptions } from "./http";

const SITE_BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const CORE_BASE_URL = "https://sports.core.api.espn.com/v2/sports/football/leagues/nfl";
/** Bounds the follow-the-$ref fan-out for one team's injury list. */
const MAX_INJURIES_PER_TEAM = 30;

/** ESPN's numeric team ids, keyed by standard abbreviation. Verified against the teams endpoint 2026-09-27. */
export const ESPN_TEAM_IDS: Readonly<Record<string, string>> = {
  ARI: "22", ATL: "1", BAL: "33", BUF: "2", CAR: "29", CHI: "3", CIN: "4", CLE: "5",
  DAL: "6", DEN: "7", DET: "8", GB: "9", HOU: "34", IND: "11", JAX: "30", KC: "12",
  LAC: "24", LAR: "14", LV: "13", MIA: "15", MIN: "16", NE: "17", NO: "18",
  NYG: "19", NYJ: "20", PHI: "21", PIT: "23", SEA: "26", SF: "25", TB: "27",
  TEN: "10", WSH: "28",
};

export interface EspnTeamRef {
  readonly id: string;
  readonly abbreviation: string;
  readonly displayName: string;
}

export interface EspnCompetitor {
  readonly homeAway: string;
  readonly winner?: boolean;
  readonly score?: string;
  readonly team: EspnTeamRef;
}

export interface EspnGameStatus {
  readonly state: string;
  readonly completed: boolean;
  readonly description: string;
  readonly detail?: string;
  readonly displayClock?: string;
}

export interface EspnEvent {
  readonly id: string;
  readonly date: string;
  readonly name: string;
  readonly shortName: string;
  readonly status: EspnGameStatus;
  readonly competitors: readonly EspnCompetitor[];
}

export interface EspnArticle {
  readonly id: string;
  readonly headline: string;
  readonly description?: string;
  readonly published: string;
  readonly type?: string;
  readonly links?: { readonly web?: { readonly href?: string } };
}

export interface EspnInjury {
  readonly athlete_id: string;
  readonly athlete_name: string;
  readonly position?: string;
  /** e.g. "Questionable", "Doubtful", "Out", "Active". */
  readonly status: string;
  readonly date?: string;
  readonly short_comment?: string;
  readonly long_comment?: string;
}

export interface EspnClient {
  /** Scoreboard for one date in YYYYMMDD form (e.g. "20260927"). Empty when nothing is scheduled. */
  getScoreboard(dates: string): Promise<readonly EspnEvent[]>;
  /** League-wide NFL news, newest first. */
  getLeagueNews(limit?: number): Promise<readonly EspnArticle[]>;
  /** News for one team (numeric ESPN id, see ESPN_TEAM_IDS). */
  getTeamNews(teamId: string, limit?: number): Promise<readonly EspnArticle[]>;
  /** Current injury list for one team, with athlete names resolved. */
  getTeamInjuries(teamId: string): Promise<readonly EspnInjury[]>;
}

export interface EspnClientOptions extends HttpGetOptions {
  readonly siteBaseUrl?: string;
  readonly coreBaseUrl?: string;
}

interface InjuryListItem {
  readonly $ref?: string;
}

interface InjuryDetail {
  readonly status?: string;
  readonly date?: string;
  readonly shortComment?: string;
  readonly longComment?: string;
  readonly athlete?: { readonly $ref?: string };
}

interface AthleteRecord {
  readonly displayName?: string;
  readonly position?: { readonly abbreviation?: string };
}

/** The numeric id at the end of a core-API athlete $ref URL, or undefined. */
function athleteIdFromRef(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const match = /\/athletes\/(\d+)/.exec(ref);
  return match?.[1];
}

export function createEspnClient(options: EspnClientOptions = {}): EspnClient {
  const siteBaseUrl = options.siteBaseUrl ?? SITE_BASE_URL;
  const coreBaseUrl = options.coreBaseUrl ?? CORE_BASE_URL;
  const httpOptions: HttpGetOptions = { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs };

  async function getInjury(refs: readonly InjuryListItem[]): Promise<readonly EspnInjury[]> {
    const injuries: EspnInjury[] = [];
    for (const item of refs.slice(0, MAX_INJURIES_PER_TEAM)) {
      if (!item.$ref) continue;
      const detail = await getJson<InjuryDetail>(item.$ref, httpOptions);
      if (!detail || typeof detail.data.status !== "string") continue;
      const athleteId = athleteIdFromRef(detail.data.athlete?.$ref);
      if (!athleteId) continue;
      // Athlete name needs its own fetch — the injury detail only carries a $ref.
      const athlete = await getJson<AthleteRecord>(
        `${coreBaseUrl}/seasons/2026/athletes/${athleteId}?lang=en&region=us`,
        httpOptions,
      );
      const athleteName = athlete?.data.displayName;
      if (!athleteName) continue;
      injuries.push({
        athlete_id: athleteId,
        athlete_name: athleteName,
        position: athlete?.data.position?.abbreviation,
        status: detail.data.status,
        date: detail.data.date,
        short_comment: detail.data.shortComment,
        long_comment: detail.data.longComment,
      });
    }
    return injuries;
  }

  return {
    async getScoreboard(dates: string): Promise<readonly EspnEvent[]> {
      const url = new URL(`${siteBaseUrl}/scoreboard`);
      url.searchParams.set("dates", dates);
      const response = await getJson<{ events?: EspnEvent[] | null }>(url, httpOptions);
      return response?.data.events ?? [];
    },

    async getLeagueNews(limit = 20): Promise<readonly EspnArticle[]> {
      const response = await getJson<{ articles?: EspnArticle[] | null }>(`${siteBaseUrl}/news`, httpOptions);
      return (response?.data.articles ?? []).slice(0, limit);
    },

    async getTeamNews(teamId: string, limit = 20): Promise<readonly EspnArticle[]> {
      const url = new URL(`${siteBaseUrl}/news`);
      url.searchParams.set("team", teamId);
      const response = await getJson<{ articles?: EspnArticle[] | null }>(url, httpOptions);
      return (response?.data.articles ?? []).slice(0, limit);
    },

    async getTeamInjuries(teamId: string): Promise<readonly EspnInjury[]> {
      const response = await getJson<{ items?: InjuryListItem[] | null }>(
        `${coreBaseUrl}/teams/${encodeURIComponent(teamId)}/injuries?lang=en&region=us`,
        httpOptions,
      );
      return getInjury(response?.data.items ?? []);
    },
  };
}
