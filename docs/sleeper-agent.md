# Sleeper agent: setup and use

This guide covers fantasy league management and Sleeper Picks research (ADR 0021). Reads need nothing from you except your Sleeper username. League writes need your own session token. Pick'em entries are always placed by you, in the Sleeper app.

## What needs nothing

These work with no credentials, against Sleeper's public read-only API:

```bash
npm run cli -- sleeper leagues <your_username>
npm run cli -- sleeper preview <your_username>                  # every league, this week
npm run cli -- sleeper waivers <your_username> --league <league_id>
npm run cli -- sleeper pickem research --player "<name or id>" --stat "receiving yards" --line 64.5
# MLB / college football (Sleeper's API is NFL-only, so these grade against a
# projection you supply, or come back as an ungraded thesis without one):
npm run cli -- sleeper pickem research --sport mlb --player "Gerrit Cole" --stat "strikeouts" --line 6.5 --projection 8.1
npm run cli -- sleeper pickem research --sport cfb --player "Arch Manning" --stat "passing yards" --line 275.5
```

The first run downloads Sleeper's player list (about 15MB) into `.orchestrator/sleeper/players-nfl.json` and reuses it for 24 hours. If a name matches more than one player, use the Sleeper player id the error lists.

## MLB/CFB research caveats (ADR 0023)

- Sleeper exposes no MLB or CFB projections — every endpoint the NFL path uses
  is NFL-only. There is no independent projection to grade against.
- With `--projection <n>`, the line is graded with the same thresholds as NFL
  (≥20% edge = high, ≥10% = standard, closer = weak/skip). The projection is
  yours (from the app, another source, or your own number) — the line setter
  may see the same number, so treat it as research, not a guaranteed edge.
- Without `--projection`, you get an ungraded news/form thesis: no lean, no
  grade. It can never earn a conviction grade on a slip — that's structural,
  not a suggestion.
- `--week` is NFL-only; `--sport` defaults to `nfl`, so existing NFL usage is
  unchanged.

## League writes (lineup, IR, taxi, add/drop, waivers, trades)

Writes use Sleeper's **unofficial** web GraphQL API with your session. Sleeper can change or block it at any time, and automating your account is at your own risk. Only you can do the steps below.

1. Log in at https://sleeper.com in a desktop browser.
2. Open DevTools (F12) and go to the **Network** tab. Filter for `graphql`.
3. Click anything in the app that loads data, such as your league page.
4. Select a `graphql` request and find the **`authorization`** request header. Copy its value. That value is your session token.
5. Add it to `.env` in the repo root (gitignored, never committed):

   ```bash
   SLEEPER_TOKEN=<paste the value here>
   ```

6. Run commands with the env file loaded, e.g. `npm run cli:env -- sleeper write --action action.json`.

The token is equivalent to being logged in as you. Don't paste it into chats, issues or commits. If a write fails with an expired-token error, repeat steps 1–5. Logging out of Sleeper in that browser may invalidate it.

Every write is a dry run unless you add `--confirm`:

```bash
npm run cli:env -- sleeper write --action action.json            # preview only; sends nothing
npm run cli:env -- sleeper write --action action.json --confirm  # sends exactly the previewed change
```

`action.json` holds one action. Example (the matchup preview prints a ready-made `suggestedAction` when a starter is out or on bye):

```json
{ "kind": "set_lineup", "leagueId": "<league_id>", "rosterId": 1, "starters": ["4046", "..."] }
```

Other kinds: `update_ir`, `update_taxi`, `add_drop_player`, `submit_waiver_claim` (with `bid` in FAAB dollars), `cancel_waiver_claim`, `propose_trade`, `respond_to_trade`. A write is refused if any player isn't on the roster it names, or if the league's rosters couldn't be checked.

Through the agent (`orchestrator dispatch run` or `run --agent sleeper-manager`), a write always pauses for your exact-match approval (`orchestrator dispatch approve <id>`).

## Sleeper Picks (pick'em)

There is no API for Sleeper Picks, so the agent can't place anything. It researches, sizes the stake under your rules, and writes the slip. You enter it in the app.

Rules enforced in code: $15 starting bankroll; standard plays $3–$4; high-conviction plays up to 50% of the available bankroll (never 100%); at most 2 plays a day; weak lines (under 10% off the projection) are skipped.

```bash
npm run cli -- sleeper pickem slip --picks picks.json --conviction standard   # prints the slip and its id
# ...you place it in the Sleeper app, noting the payout multiplier shown...
npm run cli -- sleeper pickem log <slipId> --multiplier 3
npm run cli -- sleeper pickem settle <entryId> --result won|lost|void [--payout 9]
npm run cli -- sleeper pickem bankroll
```

`picks.json` is a list like `[{ "player": "Wes Wideout", "stat": "rec_yd", "line": 64.5, "direction": "more" }, ...]`. The log lives in `.orchestrator/sleeper/pickem.json` (gitignored). Set `PICKEM_TIMEZONE` if you aren't on US Eastern time, so "today" matches your day.
