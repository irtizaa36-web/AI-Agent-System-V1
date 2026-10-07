import { test } from "node:test";
import assert from "node:assert/strict";
import { createKalshiClient, kalshiYesPrice } from "./kalshi";

function fakeFetch(routes: Record<string, { status?: number; body?: unknown; dynamic?: (url: URL) => unknown }>): {
  fetchImpl: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(`${url.pathname}${url.search}`);
    const route = routes[url.pathname];
    if (!route) return new Response("not found", { status: 404 });
    const body = route.dynamic ? route.dynamic(url) : route.body;
    return new Response(JSON.stringify(body), { status: route.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

const MARKET = {
  ticker: "KXNFLGAME-26SEP27CARCLE-CLE",
  event_ticker: "KXNFLGAME-26SEP27CARCLE",
  market_type: "binary",
  title: "Cleveland wins",
  status: "active",
  yes_bid_dollars: "0.4300",
  yes_ask_dollars: "0.4400",
  no_bid_dollars: "0.5600",
  no_ask_dollars: "0.5700",
  last_price_dollars: "0.4350",
  volume_fp: 1234.5,
  open_time: "2026-09-15T16:15:00Z",
  close_time: "2026-09-29T17:00:00Z",
};

test("listEvents follows cursor pages and returns nested markets", async () => {
  const { fetchImpl, urls } = fakeFetch({
    "/trade-api/v2/events": {
      dynamic: (url: URL) => {
        const cursor = url.searchParams.get("cursor");
        if (!cursor) {
          return {
            cursor: "page-2",
            events: [{ event_ticker: "E1", series_ticker: "KXNFLGAME", title: "Carolina vs Cleveland", markets: [MARKET] }],
          };
        }
        return { events: [{ event_ticker: "E2", series_ticker: "KXNFLGAME", title: "Dallas vs Green Bay" }] };
      },
    },
  });
  const events = await createKalshiClient({ fetchImpl }).listEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0]?.markets?.length, 1);
  assert.equal(events[0]?.markets?.[0]?.yes_bid_dollars, "0.4300");
  assert.equal(urls.length, 2);
  assert.ok(urls[0]?.includes("series_ticker=KXNFLGAME"));
  assert.ok(urls[0]?.includes("with_nested_markets=true"));
  assert.ok(urls[1]?.includes("cursor=page-2"));
});

test("listMarkets hits the markets path with the event ticker", async () => {
  const { fetchImpl, urls } = fakeFetch({
    "/trade-api/v2/markets": { body: { markets: [MARKET] } },
  });
  const markets = await createKalshiClient({ fetchImpl }).listMarkets("KXNFLGAME-26SEP27CARCLE");
  assert.equal(markets.length, 1);
  assert.equal(markets[0]?.ticker, MARKET.ticker);
  assert.ok(urls[0]?.includes("event_ticker=KXNFLGAME-26SEP27CARCLE"));
});

test("getOrderbook parses the yes/no dollar levels", async () => {
  const { fetchImpl, urls } = fakeFetch({
    "/trade-api/v2/markets/TICK/orderbook": {
      body: { orderbook_fp: { yes_dollars: [["0.4300", "100.0"]], no_dollars: [["0.5700", "50.0"]] } },
    },
  });
  const book = await createKalshiClient({ fetchImpl }).getOrderbook("TICK", 3);
  assert.deepEqual(book, {
    market_ticker: "TICK",
    yes: [["0.4300", "100.0"]],
    no: [["0.5700", "50.0"]],
  });
  assert.ok(urls[0]?.includes("depth=3"));
});

test("getOrderbook returns null when Kalshi has no book", async () => {
  const { fetchImpl } = fakeFetch({ "/trade-api/v2/markets/TICK/orderbook": { body: {} } });
  assert.equal(await createKalshiClient({ fetchImpl }).getOrderbook("TICK"), null);
});

test("kalshiYesPrice prefers dollars fields and falls back to legacy cents", async () => {
  assert.equal(kalshiYesPrice(MARKET), "0.4300");
  assert.equal(
    kalshiYesPrice({ ticker: "T", event_ticker: "E", market_type: "binary", title: "t", status: "active", yes_bid: 43, last_price: 44 }),
    "0.4300",
  );
  assert.equal(kalshiYesPrice({ ticker: "T", event_ticker: "E", market_type: "binary", title: "t", status: "active" }), null);
});

test("a failed follow-up page keeps the pages already collected", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(
        JSON.stringify({ cursor: "p2", events: [{ event_ticker: "E1", series_ticker: "KXNFLGAME", title: "One" }] }),
        { status: 200 },
      );
    }
    throw new Error("network down");
  }) as typeof fetch;
  const events = await createKalshiClient({ fetchImpl }).listEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.event_ticker, "E1");
});

test("a total failure degrades to [] without throwing", async () => {
  const throwing = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  assert.deepEqual(await createKalshiClient({ fetchImpl: throwing }).listEvents(), []);
  assert.deepEqual(await createKalshiClient({ fetchImpl: throwing }).listMarkets("E"), []);
  assert.equal(await createKalshiClient({ fetchImpl: throwing }).getOrderbook("T"), null);
});
