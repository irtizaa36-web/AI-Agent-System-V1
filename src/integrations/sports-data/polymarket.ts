/**
 * The Polymarket market-data read port via the public Gamma API
 * (https://gamma-api.polymarket.com). No auth needed for market data.
 * Strictly read-only — this is the price-discovery leg only, separate from
 * the trading port in src/integrations/polymarket/ (which handles orders).
 *
 * Gamma returns `outcomes` and `outcomePrices` as JSON-encoded strings
 * (e.g. '["Yes","No"]' and '["0.62","0.38"]'); they are parsed defensively
 * into aligned outcome/price pairs. Only fields the agent reads are
 * declared. Every method degrades to an empty result when Gamma is
 * unreachable or changes shape — never throws through the caller.
 */

import { getJson, joinUrl, type HttpGetOptions } from "./http";

const BASE_URL = "https://gamma-api.polymarket.com";

export interface PolymarketOutcomePrice {
  readonly outcome: string;
  /** USD-per-share as a number, or null when Gamma's value didn't parse. */
  readonly price: number | null;
}

export interface PolymarketMarket {
  readonly question: string;
  readonly slug: string;
  readonly outcomes: readonly string[];
  /** Aligned with `outcomes` (index i of prices ↔ index i of outcomes). */
  readonly prices: readonly PolymarketOutcomePrice[];
  readonly lastTradePrice?: number | null;
  readonly bestBid?: number | null;
  readonly bestAsk?: number | null;
  readonly volume?: number | null;
  readonly volume24hr?: number | null;
  readonly active?: boolean;
  readonly closed?: boolean;
}

export interface PolymarketEvent {
  readonly id: number;
  readonly slug: string;
  readonly title: string;
  readonly markets: readonly PolymarketMarket[];
}

export interface PolymarketClient {
  /** Search events by query (e.g. "NFL Chiefs"), with nested markets and prices. */
  searchEvents(query: string): Promise<readonly PolymarketEvent[]>;
  /** One event by Gamma id, with nested markets and prices. Null when not found. */
  getEvent(eventId: number): Promise<PolymarketEvent | null>;
}

export interface PolymarketClientOptions extends HttpGetOptions {
  readonly baseUrl?: string;
}

interface GammaMarketWire {
  readonly question?: string;
  readonly slug?: string;
  readonly outcomes?: unknown;
  readonly outcomePrices?: unknown;
  readonly lastTradePrice?: number | null;
  readonly bestBid?: number | null;
  readonly bestAsk?: number | null;
  readonly volume?: number | null;
  readonly volume24hr?: number | null;
  readonly active?: boolean;
  readonly closed?: boolean;
}

interface GammaEventWire {
  readonly id?: number;
  readonly slug?: string;
  readonly title?: string;
  readonly markets?: GammaMarketWire[];
}

/** Gamma encodes string arrays as JSON strings; accepts real arrays too. */
function parseStringArray(value: unknown): readonly string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
    } catch {
      return [];
    }
  }
  return [];
}

function toMarket(wire: GammaMarketWire): PolymarketMarket | null {
  if (typeof wire.question !== "string" || typeof wire.slug !== "string") return null;
  const outcomes = parseStringArray(wire.outcomes);
  const priceStrings = parseStringArray(wire.outcomePrices);
  const prices: PolymarketOutcomePrice[] = outcomes.map((outcome, index) => {
    const raw = priceStrings[index];
    const price = raw === undefined ? null : Number(raw);
    return { outcome, price: raw === undefined || !Number.isFinite(price) ? null : (price as number) };
  });
  return {
    question: wire.question,
    slug: wire.slug,
    outcomes,
    prices,
    lastTradePrice: wire.lastTradePrice ?? null,
    bestBid: wire.bestBid ?? null,
    bestAsk: wire.bestAsk ?? null,
    volume: wire.volume ?? null,
    volume24hr: wire.volume24hr ?? null,
    active: wire.active,
    closed: wire.closed,
  };
}

function toEvent(wire: GammaEventWire): PolymarketEvent | null {
  if (typeof wire.id !== "number" || typeof wire.slug !== "string" || typeof wire.title !== "string") return null;
  const markets: PolymarketMarket[] = [];
  for (const marketWire of wire.markets ?? []) {
    const market = toMarket(marketWire);
    if (market) markets.push(market);
  }
  return { id: wire.id, slug: wire.slug, title: wire.title, markets };
}

export function createPolymarketClient(options: PolymarketClientOptions = {}): PolymarketClient {
  const baseUrl = options.baseUrl ?? BASE_URL;
  const httpOptions: HttpGetOptions = { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs };

  return {
    async searchEvents(query: string): Promise<readonly PolymarketEvent[]> {
      const url = joinUrl(baseUrl, "/public-search");
      url.searchParams.set("q", query);
      const response = await getJson<{ events?: GammaEventWire[] | null }>(url, httpOptions);
      const events: PolymarketEvent[] = [];
      for (const wire of response?.data.events ?? []) {
        const event = toEvent(wire);
        if (event) events.push(event);
      }
      return events;
    },

    async getEvent(eventId: number): Promise<PolymarketEvent | null> {
      const response = await getJson<GammaEventWire>(joinUrl(baseUrl, `/events/${eventId}`), httpOptions);
      if (!response) return null;
      return toEvent(response.data);
    },
  };
}
