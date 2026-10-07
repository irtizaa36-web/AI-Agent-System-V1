import { test } from "node:test";
import assert from "node:assert/strict";
import { createPolymarketClient } from "./polymarket";

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>): {
  fetchImpl: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(`${url.pathname}${url.search}`);
    const route = routes[url.pathname];
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

const MARKET_WIRE = {
  question: "Will the Chiefs beat the Saints by 6 or more points?",
  slug: "will-the-chiefs-beat-the-saints-by-6-or-more-points",
  outcomes: '["Yes","No"]',
  outcomePrices: '["0.62","0.38"]',
  lastTradePrice: 0.62,
  bestBid: 0.6,
  bestAsk: 0.64,
  volume: 14548.18,
  active: true,
  closed: false,
};

const SEARCH_BODY = {
  events: [
    { id: 13233, slug: "nfl-chiefs-vs-saints", title: "NFL: Chiefs vs. Saints", markets: [MARKET_WIRE] },
  ],
  pagination: { hasMore: false },
};

test("searchEvents parses JSON-encoded outcomes/outcomePrices into aligned pairs", async () => {
  const { fetchImpl, urls } = fakeFetch({ "/public-search": { body: SEARCH_BODY } });
  const events = await createPolymarketClient({ fetchImpl }).searchEvents("NFL Chiefs");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.title, "NFL: Chiefs vs. Saints");
  const market = events[0]?.markets[0];
  assert.equal(market?.question, "Will the Chiefs beat the Saints by 6 or more points?");
  assert.deepEqual(market?.outcomes, ["Yes", "No"]);
  assert.deepEqual(market?.prices, [
    { outcome: "Yes", price: 0.62 },
    { outcome: "No", price: 0.38 },
  ]);
  assert.equal(market?.volume, 14548.18);
  assert.ok(urls[0]?.startsWith("/public-search?q="));
});

test("getEvent fetches one event by id with its markets", async () => {
  const { fetchImpl, urls } = fakeFetch({ "/events/13233": { body: SEARCH_BODY.events[0] } });
  const event = await createPolymarketClient({ fetchImpl }).getEvent(13233);
  assert.equal(event?.slug, "nfl-chiefs-vs-saints");
  assert.equal(event?.markets.length, 1);
  assert.deepEqual(urls, ["/events/13233"]);
});

test("unparseable outcomePrices degrade to null prices, not thrown errors", async () => {
  const { fetchImpl } = fakeFetch({
    "/public-search": {
      body: { events: [{ id: 1, slug: "s", title: "t", markets: [{ ...MARKET_WIRE, outcomePrices: "not-json" }] }] },
    },
  });
  const prices = (await createPolymarketClient({ fetchImpl }).searchEvents("x"))[0]?.markets[0]?.prices;
  assert.deepEqual(prices, [
    { outcome: "Yes", price: null },
    { outcome: "No", price: null },
  ]);
});

test("markets missing question/slug are skipped", async () => {
  const { fetchImpl } = fakeFetch({
    "/public-search": { body: { events: [{ id: 1, slug: "s", title: "t", markets: [{ outcomes: '["Yes"]' }] }] } },
  });
  const events = await createPolymarketClient({ fetchImpl }).searchEvents("x");
  assert.equal(events[0]?.markets.length, 0);
});

test("failures degrade to empty results without throwing", async () => {
  const throwing = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  const client = createPolymarketClient({ fetchImpl: throwing });
  assert.deepEqual(await client.searchEvents("NFL"), []);
  assert.equal(await client.getEvent(1), null);
});
