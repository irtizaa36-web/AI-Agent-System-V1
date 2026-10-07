import { test } from "node:test";
import assert from "node:assert/strict";
import { createNwsClient } from "./nws";

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>): {
  fetchImpl: typeof fetch;
  urls: string[];
  userAgents: (string | null)[];
} {
  const urls: string[] = [];
  const userAgents: (string | null)[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(`${url.pathname}${url.search}`);
    userAgents.push(new Headers(init?.headers).get("user-agent"));
    const route = routes[url.pathname];
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as typeof fetch;
  return { fetchImpl, urls, userAgents };
}

const PERIODS = [
  {
    name: "Today",
    startTime: "2026-09-27T10:00:00-05:00",
    endTime: "2026-09-27T22:00:00-05:00",
    temperature: 92,
    temperatureUnit: "F",
    windSpeed: "0 to 10 mph",
    windDirection: "SE",
    shortForecast: "Mostly Sunny",
  },
];

test("getForecast does the two-step points lookup and sends the NWS User-Agent", async () => {
  const { fetchImpl, urls, userAgents } = fakeFetch({
    "/points/29.7604,-95.3698": {
      body: { properties: { forecast: "https://api.weather.gov/gridpoints/HGX/63,95/forecast", forecastHourly: "https://api.weather.gov/gridpoints/HGX/63,95/forecast/hourly" } },
    },
    "/gridpoints/HGX/63,95/forecast": { body: { properties: { periods: PERIODS } } },
  });
  const periods = await createNwsClient({ fetchImpl }).getForecast(29.7604, -95.3698);
  assert.equal(periods.length, 1);
  assert.equal(periods[0]?.shortForecast, "Mostly Sunny");
  assert.equal(periods[0]?.windSpeed, "0 to 10 mph");
  assert.deepEqual(urls, ["/points/29.7604,-95.3698", "/gridpoints/HGX/63,95/forecast"]);
  assert.ok(userAgents.every((ua) => ua === "sports-agent (contact: local)"));
});

test("getHourlyForecast uses the hourly URL from the points lookup", async () => {
  const { fetchImpl, urls } = fakeFetch({
    "/points/40.7,-74": {
      body: { properties: { forecastHourly: "https://api.weather.gov/gridpoints/OKX/1,1/forecast/hourly" } },
    },
    "/gridpoints/OKX/1,1/forecast/hourly": { body: { properties: { periods: PERIODS } } },
  });
  const periods = await createNwsClient({ fetchImpl }).getHourlyForecast(40.7, -74);
  assert.equal(periods[0]?.temperature, 92);
  assert.deepEqual(urls, ["/points/40.7,-74", "/gridpoints/OKX/1,1/forecast/hourly"]);
});

test("a failed points lookup degrades to [] without throwing", async () => {
  const { fetchImpl } = fakeFetch({ "/points/0,0": { status: 500, body: "boom" } });
  assert.deepEqual(await createNwsClient({ fetchImpl }).getForecast(0, 0), []);
  const throwing = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  assert.deepEqual(await createNwsClient({ fetchImpl: throwing }).getHourlyForecast(0, 0), []);
});
