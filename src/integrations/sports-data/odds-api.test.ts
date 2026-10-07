import { test } from "node:test";
import assert from "node:assert/strict";
import { FREE_TIER_MONTHLY_REQUESTS, createOddsApiClient } from "./odds-api";

function fakeFetch(routes: Record<string, { status?: number; body: unknown; headers?: Record<string, string> }>): {
  fetchImpl: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(`${url.pathname}${url.search}`);
    const route = routes[url.pathname];
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: route.headers ?? { "x-requests-remaining": "499", "x-requests-used": "1" },
    });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

const ODDS_BODY = [
  {
    id: "event-1",
    sport_key: "americanfootball_nfl",
    commence_time: "2026-09-27T17:00:00Z",
    home_team: "Kansas City Chiefs",
    away_team: "Buffalo Bills",
    bookmakers: [
      {
        key: "draftkings",
        title: "DraftKings",
        markets: [
          { key: "spreads", outcomes: [{ name: "Kansas City Chiefs", price: -110, point: -3.5 }] },
          { key: "totals", outcomes: [{ name: "Over", price: -110, point: 47.5 }] },
        ],
      },
    ],
  },
];

test("getNflOdds requests game odds with default markets and parses the wire format", async () => {
  const { fetchImpl, urls } = fakeFetch({ "/v4/sports/americanfootball_nfl/odds/": { body: ODDS_BODY } });
  const events = await createOddsApiClient({ fetchImpl, apiKey: "test-key" }).getNflOdds();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.home_team, "Kansas City Chiefs");
  assert.equal(events[0]?.bookmakers[0]?.markets[0]?.outcomes[0]?.point, -3.5);
  const url = new URL(urls[0] as string, "https://api.the-odds-api.com");
  assert.equal(url.searchParams.get("markets"), "h2h,spreads,totals");
  assert.equal(url.searchParams.get("regions"), "us");
  assert.equal(url.searchParams.get("apiKey"), "test-key");
});

test("getEventPlayerProps hits the per-event props path", async () => {
  const { fetchImpl, urls } = fakeFetch({ "/v4/sports/americanfootball_nfl/events/event-1/odds/": { body: ODDS_BODY[0] } });
  const event = await createOddsApiClient({ fetchImpl, apiKey: "test-key" }).getEventPlayerProps("event-1", ["player_pass_yds"]);
  assert.equal(event?.id, "event-1");
  assert.ok((urls[0] as string).includes("markets=player_pass_yds"));
});

test("the budget counter syncs from the x-requests-remaining header and counts requests", async () => {
  const { fetchImpl } = fakeFetch({ "/v4/sports/americanfootball_nfl/odds/": { body: [] } });
  const client = createOddsApiClient({ fetchImpl, apiKey: "test-key" });
  assert.equal(client.usedRequests(), 0);
  // Before any call: full free tier assumed.
  assert.equal(client.remainingBudget(), FREE_TIER_MONTHLY_REQUESTS);
  await client.getNflOdds();
  await client.getNflOdds();
  assert.equal(client.usedRequests(), 2);
  // Header said 499 remaining on the last response — the sync wins over the estimate.
  assert.equal(client.remainingBudget(), 499);
});

test("without the header, the budget falls back to the free-tier estimate", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    void input;
    return new Response("[]", { status: 200 });
  }) as typeof fetch;
  const client = createOddsApiClient({ fetchImpl, apiKey: "test-key" });
  await client.getNflOdds();
  assert.equal(client.remainingBudget(), FREE_TIER_MONTHLY_REQUESTS - 1);
});

test("missing key: calls degrade to empty and the budget is unknown", async () => {
  // Ensure env doesn't leak a key into this test.
  const saved = process.env["ODDS_API_KEY"];
  delete process.env["ODDS_API_KEY"];
  try {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    const client = createOddsApiClient({ fetchImpl });
    assert.deepEqual(await client.getNflOdds(), []);
    assert.equal(await client.getEventPlayerProps("e", ["player_pass_yds"]), null);
    assert.equal(client.remainingBudget(), null);
    assert.equal(client.usedRequests(), 0);
    assert.equal(calls.length, 0);
  } finally {
    if (saved !== undefined) process.env["ODDS_API_KEY"] = saved;
  }
});

test("a failing API call degrades silently and never logs the key", async () => {
  const logged: string[] = [];
  const methods = ["log", "warn", "error", "info", "debug"] as const;
  const originals = methods.map((m) => console[m]);
  methods.forEach((m) => {
    (console[m] as (...args: unknown[]) => void) = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
  });
  try {
    const fetchImpl = (async () => new Response("denied", { status: 401 })) as typeof fetch;
    const client = createOddsApiClient({ fetchImpl, apiKey: "super-secret-key" });
    assert.deepEqual(await client.getNflOdds(), []);
    assert.ok(!logged.some((line) => line.includes("super-secret-key")), "key must never be logged");
  } finally {
    methods.forEach((m, i) => {
      console[m] = originals[i] as never;
    });
  }
});
