/**
 * The Odds API read port (https://api.the-odds-api.com/v4): NFL game odds
 * (spreads, totals, moneylines) and player props from US sportsbooks.
 * Read-only — the API has no write operations.
 *
 * Key handling: the key comes from ODDS_API_KEY (overridable per client).
 * It is only ever sent as the `apiKey` query param the API requires; it is
 * never logged, never included in error text, and never exposed by any
 * return value.
 *
 * Free-tier budget (500 requests/month): the client counts every request it
 * makes in-memory and also syncs from the `x-requests-remaining` response
 * header when the API sends it. Callers check `remainingBudget()` BEFORE
 * calling — a null budget means "unknown" (no key or no call made yet).
 * All methods degrade to empty results when the key is missing, the budget
 * is exhausted, or the API fails — never throw through the caller.
 */

import { getJson, joinUrl, type HttpGetOptions } from "./http";

const BASE_URL = "https://api.the-odds-api.com/v4";
/** The Odds API free tier: 500 requests/month, no card. */
export const FREE_TIER_MONTHLY_REQUESTS = 500;
const NFL_SPORT_KEY = "americanfootball_nfl";

export interface OddsOutcome {
  readonly name: string;
  readonly price: number;
  /** The line, e.g. -3.5 for a spread or 47.5 for a total. Absent on moneylines. */
  readonly point?: number;
}

export interface OddsMarket {
  readonly key: string;
  readonly last_update?: string;
  readonly outcomes: readonly OddsOutcome[];
}

export interface OddsBookmaker {
  readonly key: string;
  readonly title?: string;
  readonly last_update?: string;
  readonly markets: readonly OddsMarket[];
}

export interface OddsEvent {
  readonly id: string;
  readonly sport_key: string;
  readonly sport_title?: string;
  readonly commence_time: string;
  readonly home_team: string;
  readonly away_team: string;
  readonly bookmakers: readonly OddsBookmaker[];
}

export interface OddsApiClient {
  /** Game odds for upcoming NFL games. `markets` defaults to h2h/spreads/totals. */
  getNflOdds(markets?: readonly string[]): Promise<readonly OddsEvent[]>;
  /** Player props for one event. `markets` e.g. ["player_pass_yds","player_rush_yds"]. */
  getEventPlayerProps(eventId: string, markets: readonly string[]): Promise<OddsEvent | null>;
  /** Requests left this month, or null when unknown (no key / nothing fetched yet). Check BEFORE calling. */
  remainingBudget(): number | null;
  /** Requests this client instance has made. */
  usedRequests(): number;
}

export interface OddsApiClientOptions extends HttpGetOptions {
  readonly baseUrl?: string;
  /** Defaults to process.env.ODDS_API_KEY. */
  readonly apiKey?: string;
}

const DEFAULT_GAME_MARKETS = ["h2h", "spreads", "totals"] as const;

export function createOddsApiClient(options: OddsApiClientOptions = {}): OddsApiClient {
  const baseUrl = options.baseUrl ?? BASE_URL;
  // Read once at construction; the key never leaves this closure except as the apiKey query param.
  const apiKey = options.apiKey ?? process.env["ODDS_API_KEY"];
  const httpOptions: HttpGetOptions = { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs };

  let used = 0;
  let lastObservedRemaining: number | null = null;

  function trackUsage(headers: Headers): void {
    used += 1;
    const remaining = headers.get("x-requests-remaining");
    if (remaining !== null) {
      const parsed = Number(remaining);
      if (Number.isFinite(parsed) && parsed >= 0) lastObservedRemaining = Math.floor(parsed);
    }
  }

  /** Every request goes through here so usage is counted exactly once. */
  async function get<T>(path: string, params: Readonly<Record<string, string>>): Promise<{ data: T; headers: Headers } | null> {
    if (!apiKey) return null;
    const url = joinUrl(baseUrl, path);
    url.searchParams.set("apiKey", apiKey);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const response = await getJson<T>(url, httpOptions);
    if (!response) return null;
    trackUsage(response.headers);
    return response;
  }

  return {
    async getNflOdds(markets: readonly string[] = [...DEFAULT_GAME_MARKETS]): Promise<readonly OddsEvent[]> {
      const response = await get<OddsEvent[]>(`/sports/${NFL_SPORT_KEY}/odds/`, {
        regions: "us",
        markets: markets.join(","),
        oddsFormat: "american",
      });
      return response?.data ?? [];
    },

    async getEventPlayerProps(eventId: string, markets: readonly string[]): Promise<OddsEvent | null> {
      const response = await get<OddsEvent>(`/sports/${NFL_SPORT_KEY}/events/${encodeURIComponent(eventId)}/odds/`, {
        regions: "us",
        markets: markets.join(","),
        oddsFormat: "american",
      });
      return response?.data ?? null;
    },

    remainingBudget(): number | null {
      if (lastObservedRemaining !== null) return lastObservedRemaining;
      if (!apiKey) return null;
      return Math.max(0, FREE_TIER_MONTHLY_REQUESTS - used);
    },

    usedRequests(): number {
      return used;
    },
  };
}
