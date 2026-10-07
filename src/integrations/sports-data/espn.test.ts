import { test } from "node:test";
import assert from "node:assert/strict";
import { ESPN_TEAM_IDS, createEspnClient } from "./espn";

/** Fixture fetch keyed by pathname; records path+query and request headers. No network. */
function fakeFetch(routes: Record<string, { status?: number; body: unknown }>): {
  fetchImpl: typeof fetch;
  urls: string[];
  headers: Record<string, string>[];
} {
  const urls: string[] = [];
  const headers: Record<string, string>[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(`${url.pathname}${url.search}`);
    const rawHeaders = new Headers(init?.headers);
    const recorded: Record<string, string> = {};
    rawHeaders.forEach((value, key) => {
      recorded[key] = value;
    });
    headers.push(recorded);
    const route = routes[url.pathname];
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, urls, headers };
}

const SCOREBOARD_BODY = {
  events: [
    {
      id: "401772001",
      date: "2026-09-27T17:00Z",
      name: "Buffalo Bills vs Kansas City Chiefs",
      shortName: "BUF vs KC",
      status: {
        state: "pre",
        completed: false,
        description: "Scheduled",
        detail: "Sun, September 27th at 1:00 PM EDT",
        displayClock: "0:00",
      },
      competitors: [
        { homeAway: "home", team: { id: "12", abbreviation: "KC", displayName: "Kansas City Chiefs" } },
        { homeAway: "away", team: { id: "2", abbreviation: "BUF", displayName: "Buffalo Bills" } },
      ],
    },
  ],
};

test("getScoreboard hits the scoreboard path with the dates param and parses events", async () => {
  const { fetchImpl, urls } = fakeFetch({
    "/apis/site/v2/sports/football/nfl/scoreboard": { body: SCOREBOARD_BODY },
  });
  const events = await createEspnClient({ fetchImpl }).getScoreboard("20260927");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.name, "Buffalo Bills vs Kansas City Chiefs");
  assert.equal(events[0]?.status.state, "pre");
  assert.equal(events[0]?.competitors[0]?.team.abbreviation, "KC");
  assert.deepEqual(urls, ["/apis/site/v2/sports/football/nfl/scoreboard?dates=20260927"]);
});

test("getScoreboard degrades to [] when ESPN errors", async () => {
  const { fetchImpl } = fakeFetch({
    "/apis/site/v2/sports/football/nfl/scoreboard": { status: 500, body: "boom" },
  });
  assert.deepEqual(await createEspnClient({ fetchImpl }).getScoreboard("20260927"), []);
});

test("news endpoints parse articles and honor the team filter", async () => {
  const articles = {
    articles: [
      { id: "1", headline: "Chiefs rule out two starters", description: "Injury news", published: "2026-09-27T14:00:00Z", type: "Story" },
      { id: "2", headline: "Second story", published: "2026-09-27T13:00:00Z" },
    ],
  };
  const { fetchImpl, urls } = fakeFetch({ "/apis/site/v2/sports/football/nfl/news": { body: articles } });
  const client = createEspnClient({ fetchImpl });
  const league = await client.getLeagueNews();
  assert.equal(league.length, 2);
  assert.equal(league[0]?.headline, "Chiefs rule out two starters");
  const team = await client.getTeamNews("12", 1);
  assert.equal(team.length, 1);
  assert.deepEqual(urls, ["/apis/site/v2/sports/football/nfl/news", "/apis/site/v2/sports/football/nfl/news?team=12"]);
});

test("getTeamInjuries follows the $ref chain and resolves athlete names", async () => {
  const { fetchImpl, urls } = fakeFetch({
    "/v2/sports/football/leagues/nfl/teams/12/injuries": {
      body: {
        items: [
          { $ref: "http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/2026/athletes/4040432/injuries/1?lang=en&region=us" },
          { $ref: "http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/2026/athletes/999/injuries/2?lang=en&region=us" },
        ],
      },
    },
    "/v2/sports/football/leagues/nfl/seasons/2026/athletes/4040432/injuries/1": {
      body: {
        status: "Questionable",
        date: "2026-09-25T23:09Z",
        shortComment: "Knee",
        athlete: { $ref: "http://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/2026/athletes/4040432?lang=en&region=us" },
      },
    },
    // Second injury's detail 404s — it is skipped, not fatal.
    "/v2/sports/football/leagues/nfl/seasons/2026/athletes/4040432": {
      body: { displayName: "Patrick Mahomes", position: { abbreviation: "QB" } },
    },
  });
  const injuries = await createEspnClient({ fetchImpl }).getTeamInjuries("12");
  assert.equal(injuries.length, 1);
  assert.deepEqual(injuries[0], {
    athlete_id: "4040432",
    athlete_name: "Patrick Mahomes",
    position: "QB",
    status: "Questionable",
    date: "2026-09-25T23:09Z",
    short_comment: "Knee",
    long_comment: undefined,
  });
  assert.ok(urls[0]?.endsWith("/teams/12/injuries?lang=en&region=us"));
});

test("getTeamInjuries degrades to [] when the list call fails", async () => {
  const throwing = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  assert.deepEqual(await createEspnClient({ fetchImpl: throwing }).getTeamInjuries("12"), []);
});

test("ESPN_TEAM_IDS covers all 32 teams", () => {
  assert.equal(Object.keys(ESPN_TEAM_IDS).length, 32);
  assert.equal(ESPN_TEAM_IDS["KC"], "12");
  assert.equal(ESPN_TEAM_IDS["HOU"], "34");
});
