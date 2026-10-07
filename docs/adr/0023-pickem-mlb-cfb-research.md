---
status: accepted
---

# Pick'em research for MLB and CFB: owner-supplied projections, no new data source

## Context

The owner asked for Sleeper Picks research beyond NFL (MLB and college football),
so the pick'em module now accepts `--sport nfl|mlb|cfb`. The question was what
projection to grade MLB/CFB lines against, given the NFL path grades against
Sleeper's own weekly projections.

## Findings

- **Sleeper's public API is NFL-only.** Every read endpoint ADR 0021 relies on —
  `/players/nfl`, `/projections/nfl/<season>/<week>`, `/schedule/nfl/...`,
  trending adds/drops, NFL state — has no MLB or CFB counterpart. Sleeper
  doesn't run MLB/CFB fantasy on that API surface, so there is nothing to call.
- **MLB Stats API (`statsapi.mlb.com`) is free and keyless, but it serves stats
  and schedules, not projections.** Season averages can be computed from it, but
  a season average is not a projection, and presenting one as a graded edge
  would be dishonest. It also can't see lineups, pitching matchups, or weather
  the way a real projection would need to.
- **CFB has no free keyless projection source.** collegefootballdata.com needs an
  API key (a credential the repo must not hold), and even it offers team/game
  data, not player-prop projections.
- **The pick'em module is deliberately network-free.** `pickem.test.ts` asserts
  no file under `src/sleeper/pickem/` does network I/O or exports a placement
  function. Adding a fetch to a third-party stats API would break that structural
  guarantee and ADR 0002's zero-runtime-dependency rule for no real edge.

## Decision

MLB/CFB research grades **only against a projection the owner supplies**
(`--projection <n>` on the CLI, `projection` on the `pickem-research-line`
tool) — from the Sleeper app, another projections source he trusts, or his own
number. Grading reuses the exact NFL thresholds (`assessLine`: ≥20% high,
≥10% standard, else weak/skip) so a "high" means the same thing in every sport.

Without a supplied projection, research returns an **ungraded thesis**: no lean,
no grade, explicit caveats that it can't earn a conviction grade. This mirrors
how the 2026-09-25 NFL note already worked when Sleeper's projections endpoint
returned empty — news/form reasoning, honestly labeled.

## Consequences

- `researchNonNflLine` is pure (no Sleeper client, no network); the no-network
  test keeps passing unchanged.
- The honest failure mode is explicit: ungraded output can never become a
  high-conviction slip pick, because `buildSlip` requires graded picks for
  conviction and refuses weak ones.
- If a trustworthy free projection source for MLB/CFB props appears later, it
  belongs behind the same port shape as `researchLine` (projection in, graded
  research out), not as a fetch inside the pickem module.
- Bankroll rules, the never-places-anything contract, and the NFL write path
  are untouched.
