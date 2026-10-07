import { test } from "node:test";
import assert from "node:assert/strict";
import { sourcesFromWatchlist } from "./registry";
import type { WatchlistEntry } from "../records";

function entry(overrides: Partial<WatchlistEntry> = {}): WatchlistEntry {
  return { company: "Acme", boardToken: "acme", atsType: "greenhouse", ...overrides };
}

test("a per-board maxAgeDays override propagates onto the source", () => {
  const sources = sourcesFromWatchlist([entry({ maxAgeDays: 7 })]);
  assert.equal(sources[0]!.maxAgeDays, 7);
});

test("an entry without an override leaves the global default in place", () => {
  const sources = sourcesFromWatchlist([entry()]);
  assert.equal(sources[0]!.maxAgeDays, undefined);
});

test("priority flags propagate from the watchlist onto the source", () => {
  const sources = sourcesFromWatchlist([entry({ priority: true })]);
  assert.equal(sources[0]!.priority, true);
});

test("every ATS type accepts the same per-board options", () => {
  const entries: WatchlistEntry[] = [
    entry({ atsType: "greenhouse" }),
    entry({ atsType: "lever", maxAgeDays: 10, priority: true }),
    entry({ atsType: "ashby", maxAgeDays: 14 }),
    entry({ atsType: "feed" }),
  ];
  const sources = sourcesFromWatchlist(entries);
  assert.equal(sources[1]!.maxAgeDays, 10);
  assert.equal(sources[1]!.priority, true);
  assert.equal(sources[2]!.maxAgeDays, 14);
});
