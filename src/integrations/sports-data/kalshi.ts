/**
 * The Kalshi read port (https://api.elections.kalshi.com/trade-api/v2).
 * Market data is public — no auth needed. Strictly read-only: this client
 * has no order placement, no positions, no balance access.
 *
 * Event discovery goes through series tickers (KXNFLGAME for game markets).
 * The events endpoint supports cursor pagination (`cursor` in → `cursor`
 * out); listing methods follow it automatically up to a page cap.
 *
 * Prices use the `*_dollars` fields (Kalshi's current convention), falling
 * back to the legacy `yes_bid`/`yes_ask`/`last_price` fields when the
 * dollars variants are absent. Only fields the agent reads are declared.
 * Every method degrades to an empty result when Kalshi is unreachable —
 * never throws through the caller.
 */

import { getJson, joinUrl, type HttpGetOptions } from "./http";

const BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
/** Follows at most this many cursor pages per listing call. */
const MAX_PAGES = 5;

export interface KalshiMarket {
  readonly ticker: string;
  readonly event_ticker: string;
  readonly market_type: string;
  readonly title: string;
  readonly status: string;
  readonly yes_bid_dollars?: string | null;
  readonly yes_ask_dollars?: string | null;
  readonly no_bid_dollars?: string | null;
  readonly no_ask_dollars?: string | null;
  readonly last_price_dollars?: string | null;
  /** Legacy fields, null on current markets — checked only as a fallback. */
  readonly yes_bid?: number | null;
  readonly yes_ask?: number | null;
  readonly last_price?: number | null;
  readonly volume_fp?: number | null;
  readonly volume_24h_fp?: number | null;
  readonly open_interest_fp?: number | null;
  readonly liquidity_dollars?: string | null;
  readonly open_time?: string;
  readonly close_time?: string;
}

export interface KalshiEvent {
  readonly event_ticker: string;
  readonly series_ticker: string;
  readonly title: string;
  readonly sub_title?: string;
  readonly markets?: readonly KalshiMarket[];
}

/** One orderbook level as a [price_dollars, contracts] tuple, per Kalshi's wire format. */
export type KalshiLevel = readonly [string, string];

export interface KalshiOrderbook {
  readonly market_ticker: string;
  readonly yes: readonly KalshiLevel[];
  readonly no: readonly KalshiLevel[];
}

export interface KalshiClient {
  /** Open events for a series (default KXNFLGAME), with nested markets. Follows cursor pages. */
  listEvents(seriesTicker?: string, status?: string): Promise<readonly KalshiEvent[]>;
  /** Markets for one event ticker. Follows cursor pages. */
  listMarkets(eventTicker: string): Promise<readonly KalshiMarket[]>;
  /** Top-of-book levels for one market ticker. Null when unavailable. */
  getOrderbook(marketTicker: string, depth?: number): Promise<KalshiOrderbook | null>;
}

export interface KalshiClientOptions extends HttpGetOptions {
  readonly baseUrl?: string;
}

/** Best available Yes price in dollars, or null when Kalshi reported none. */
export function kalshiYesPrice(market: KalshiMarket): string | null {
  if (market.yes_bid_dollars != null) return market.yes_bid_dollars;
  if (market.last_price_dollars != null) return market.last_price_dollars;
  if (market.yes_bid != null) return (market.yes_bid / 100).toFixed(4);
  if (market.last_price != null) return (market.last_price / 100).toFixed(4);
  return null;
}

interface PagedResponse<T> {
  readonly cursor?: string;
  readonly events?: T[];
  readonly markets?: T[];
}

interface OrderbookResponse {
  readonly orderbook_fp?: {
    readonly yes_dollars?: KalshiLevel[];
    readonly no_dollars?: KalshiLevel[];
  };
}

export function createKalshiClient(options: KalshiClientOptions = {}): KalshiClient {
  const baseUrl = options.baseUrl ?? BASE_URL;
  const httpOptions: HttpGetOptions = { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs };

  /** Follows `cursor` pages, collecting `events` or `markets` arrays. */
  async function collectPages<T>(path: string, params: Readonly<Record<string, string>>, field: "events" | "markets"): Promise<readonly T[]> {
    const collected: T[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = joinUrl(baseUrl, path);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await getJson<PagedResponse<T>>(url, httpOptions);
      if (!response) break;
      collected.push(...(response.data[field] ?? []));
      const next = response.data.cursor;
      if (!next) break;
      cursor = next;
    }
    return collected;
  }

  return {
    async listEvents(seriesTicker = "KXNFLGAME", status = "open"): Promise<readonly KalshiEvent[]> {
      return collectPages<KalshiEvent>("/events", {
        series_ticker: seriesTicker,
        status,
        with_nested_markets: "true",
        limit: "100",
      }, "events");
    },

    async listMarkets(eventTicker: string): Promise<readonly KalshiMarket[]> {
      return collectPages<KalshiMarket>("/markets", {
        event_ticker: eventTicker,
        status: "open",
        limit: "100",
      }, "markets");
    },

    async getOrderbook(marketTicker: string, depth = 10): Promise<KalshiOrderbook | null> {
      const url = joinUrl(baseUrl, `/markets/${encodeURIComponent(marketTicker)}/orderbook`);
      url.searchParams.set("depth", String(depth));
      const response = await getJson<OrderbookResponse>(url, httpOptions);
      const book = response?.data.orderbook_fp;
      if (!book) return null;
      return {
        market_ticker: marketTicker,
        yes: book.yes_dollars ?? [],
        no: book.no_dollars ?? [],
      };
    },
  };
}
