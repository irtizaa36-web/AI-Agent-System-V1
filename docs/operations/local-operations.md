# Local Operations

## Scope

This runbook describes the local operational shape of Moby AI without storing credentials, private files, browser sessions, message content, or machine-specific secrets. The repository remains the source of truth for code and durable coordination; local runtime state is deliberately separate.

## Checkouts

- A Team B worktree is for isolated development and should start from `origin/main`.
- The primary Mac mini checkout is the runtime location for locally managed services. A merge to `main` does not update a running process by itself.
- Before changing a local service, confirm its checkout, current commit, working-tree status, and the corresponding commit on `origin/main`.

## Inkbox webhook

The webhook receiver is a local Node process managed by a user LaunchAgent. Its default listener is port `8787`, and its health endpoint is:

```text
http://localhost:8787/inkbox/mail/health
```

The response states whether bearer authentication is required but never reveals the token. Runtime configuration comes from a local `.env` file; only `.env.example` is committed. Its logs and persisted runtime data live under `.orchestrator/`, which is also local-only.

Use the health endpoint and `launchctl print gui/<uid>/com.aiagentsystem.inkbox-webhook` for read-only inspection. A service update requires human review because it may change a live process using real communication credentials.

## Inkbox Contacts API (confirmed 2026-09-16)

`src/integrations/inkbox/contact-client.ts` wraps `https://inkbox.ai/api/v1/contacts` (`X-API-Key`, no `agent_identity_id` param — org scoping is implicit in the key). Confirmed against both the docs and live calls on this identity's real data, not guessed:

- **Working and used:** `GET /contacts/lookup` (exact email/phone reverse lookup), `PATCH /contacts/{id}` (replace named fields), `POST /contacts/{id}/merge` (`{"losing_contact_ids": [...]}` — survivor keeps combined identifiers/correspondence/memories; response includes `memory_count`/`latest_memory`). `jobs enrich-contact --profile <name>` uses lookup+update to link `DIGEST_IMESSAGE_TO`'s phone onto the contact found via `DIGEST_EMAIL_TO` and tag it with the profile — idempotent, safe to re-run.
- **Contact Memory is real and populated**, not a dormant feature — Inkbox auto-extracts memories from real correspondence (confirmed: a merged contact carried 8 memories over, including an accurate auto-generated preference summary). No memory create/update endpoint exists though — read-only from this side.
- **Not writable via API, confirmed by checking the documented `PATCH` field list against a live contact object's actual fields:** `contact_rules` (blacklist/allowlist — `list`-only, zero create/update endpoint anywhere in the docs) and a contact's own `review_status`/`is_confirmed` (present on every contact object, but absent from the documented PATCH contract). Both look like the natural "is this real correspondence or retail noise" signal — neither is settable directly. The one observed exception: `merge` has the side effect of setting the survivor to `is_confirmed: true` — not a general "confirm a contact" mechanism, just what merging happens to do.
- **A real per-person split exists today:** Inkbox auto-creates a *separate* contact per channel the first time it sees an identifier (an email-only contact from the first inbound mail, a phone-only contact from the first inbound text/iMessage) rather than linking them automatically. Anyone doing contact-based work should check for this split (`lookup` by each known identifier, compare ids) before assuming one contact record is the whole picture.

## Job-search pipeline: two profiles, one engine

Two searches run through the same pipeline with entirely separate data:
`shivani` (marketing/program-management roles on ATS boards) and `irtiza`
(clinical-expertise gig platforms). A profile key names three directories —
`config/job-search/<key>/`, `profile/<key>/` and `.orchestrator/jobs/<key>/` —
and every command takes the key explicitly. See ADR 0017.

```text
node dist/cli/index.js jobs profiles              # what's configured
node dist/cli/index.js jobs run --profile shivani # one person's run
node dist/cli/index.js jobs run --all             # every profile, what launchd runs
node dist/cli/index.js jobs digest --profile irtiza
```

There is deliberately no default profile: `jobs run` with no `--profile` refuses
and lists the configured keys rather than guessing. The failure mode that avoids
is not a crash — it is a run that quietly scores one person's postings against
the other's resume and produces a plausible-looking digest anyway.

The launchd job (`scripts/com.mobyai.jobsearch.plist`) runs `--all` at 10:00
local, Monday to Friday. Each profile gets its own digest file; a profile whose
config is empty reports that plainly instead of failing the whole run.

## Job-search pipeline: texting the digest

Off by default. Turning it on for real requires all four values in
`.env.example`'s "texting the daily digest" block, and — separately from
anything this repo can configure — the destination number recorded as
opted in through Inkbox directly (Inkbox's own `smsOptIns.optIn`, which
itself needs an active 10DLC campaign on the account). See ADR 0016 for
why this is three independent gates rather than one, and
`src/jobsearch/sms-client.ts` for what each failure mode actually reports.

`orchestrator jobs run --profile <key>` sends the text as its last step, after the digest
file is already written — a failed or skipped text never fails the run
itself. Check `INKBOX_SMS_PHONE_NUMBER_ID` against the phone number
actually assigned to this identity in Inkbox before assuming it's right;
nothing here can look that value up on its own.

## Orchestrator brief watcher

`orchestrator watch-briefs poll|loop` (ADR 0027) needs `GITHUB_TOKEN`
(read-only content access) in `.env`. `scripts/com.mobyai.watchbriefs.plist`
runs one poll every 180 seconds via `launchd`, the same install pattern as
the job-search pipeline's plist above. It only reads GitHub and writes a
delegation-log stub via local `git push` to the branch a brief names —
never a PR, never a merge, never the brief's own instructions.

## Dashboard and coworker loop

The dashboard is local-only and starts with:

```text
node dist/cli/index.js dashboard
```

It defaults to `http://localhost:4317`. It reads and writes committed coordination records under `coworker/`; status data is self-reported, so stale reports are not proof that a persona is idle or active.

Issue #1 is the durable coordination fallback when cross-session messaging is unavailable. Use `coworker undispatch <id> --persona <name>` to return work stranded by an interrupted session to the normal pending-task pickup queue.

### Dashboard autostart (desktop window)

To always have the dashboard reachable without manually starting it, `coworker/triggers/dashboard-autostart.sh` runs `node dist/cli/index.js dashboard --port 4317` under a user LaunchAgent (`com.aiagentsystem.dashboard`, `KeepAlive: true`), the same pattern as the Inkbox webhook and the macmini check-in. The `.plist` itself is local-machine-only and not committed - create it at `~/Library/LaunchAgents/com.aiagentsystem.dashboard.plist` with this content (adjust the script path if the repo lives somewhere other than `/Users/irtizaahmed/AI-Agent-System`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.aiagentsystem.dashboard</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/Users/irtizaahmed/AI-Agent-System/coworker/triggers/dashboard-autostart.sh</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/aiagentsystem-dashboard.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/aiagentsystem-dashboard.err</string>
</dict>
</plist>
```

Then load it once with `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.aiagentsystem.dashboard.plist`, same as the other two, and confirm with `launchctl print gui/$(id -u)/com.aiagentsystem.dashboard` plus a check that `http://localhost:4317` responds.

Once it's running, `http://localhost:4317` can be pinned as its own Dock window (Safari's "Add to Dock," or the equivalent in another browser) instead of living in a regular browser tab - a real standalone window for handing the coworker system a task, distinct from Claude Desktop's own separate "Cowork" tab.

## Call recording and transcription

Setup and per-call steps: `docs/operations/call-transcription.md` (ADR 0030). Runs only on the Mac that relays iPhone calls. Recordings and transcripts live in `.orchestrator/calls/` and are never committed.

## Local-only dependencies

These resources must never be committed or copied into a handoff:

- `.env` credentials and tokens
- `.orchestrator/` runtime records, drafts, logs, and browser sessions
- personal files used by a Pack
- local scheduler and LaunchAgent registrations

When a task depends on one of these, record the dependency and its required machine in the GitHub Issue or coworker task without recording its contents.
