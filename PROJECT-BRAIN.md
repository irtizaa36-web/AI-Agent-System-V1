# PROJECT-BRAIN.md — Moby AI

A permanent, plain-English briefing document for this repository. It exists for two audiences: Irtiza (the product/domain owner, not a software engineer, and not expected to read TypeScript or run terminal commands personally), and any future Claude Code session picking this project back up cold. Read this before any major architectural work.

**Moby AI** is the name of the overarching system this repository builds — the orchestration engine, its Packs/Agents (career-advisor, job-search, case-report-writer, personal-admin, dispatcher), and the live Inkbox-based communication layer (email, iMessage) all together. The underlying GitHub repository and directory are still named `AI-Agent-System` — that's the technical/historical name; "Moby AI" is what to call the system when talking about it as a product.

This document describes the repository **as it actually exists**, checked directly against the code and `docs/adr/*` at the time of writing (all tests passing — run `npm test` for the current count, which changes often enough that pinning a number here would quickly go stale). Where something is planned rather than built, it is explicitly labeled as such.

---

## 1. What we are building

**Moby AI** (repository name: `AI-Agent-System`) is a **general-purpose AI agent orchestration system** — a reusable engine for running AI agents against tasks, not a single application. It is **not** pivoting into a medical application, an email assistant, or a computer-automation product; medicine (IM Brain, A&I Research, Medical Career Advisor) is one planned family of things built *on top of* this engine, not what the engine itself is.

Conceptually, the intended shape is:

```
YOU
 ↓
ORCHESTRATOR
 ↓
AGENTS / PACKS
 ↓
MODELS + TOOLS
 ↓
RESULT
 ↓
VERIFICATION
 ↓
DELIVERY
```

You give the system a task; the Orchestrator (Section 2) runs it through an Agent belonging to some Pack; that Agent uses a Model and, optionally, Tools to produce a Result; important results get checked before being treated as final; then the result is delivered back to you. "Verification" and "Delivery" here describe the intended shape of the pipeline, not a built component yet — see Section 3.

It's built to be:
- **CLI-first now, service-ready later** — usable from a terminal today, without redesigning it to add a web API in the future.
- **Model-agnostic** — Claude is the default AI model, but the engine isn't wired specifically to Claude; other providers (e.g. Fable, or others) can be added later without changing the core logic.
- **Domain-agnostic at its core** — the engine itself knows nothing about medicine, research, or careers. Domain expertise lives in separate, pluggable "Packs" (Section 5).
- **Able to grow substantially without repeatedly redesigning the Core** — adding a new domain, model, tool, or external service should mean adding to the system, not rewriting its center.

## Cross-team continuity

Team B is the name for work performed through GitHub Pro/Copilot sessions. This project can alternate between Team B and other teams because the repository is the shared source of truth; the workflow is defined in `docs/agents/team-handoff.md`. Private chat context is never required to continue a task.

## 2. Future external capabilities the architecture must remain compatible with

None of the following are built. This section exists so that current and future decisions don't accidentally make them hard to add later.

Eventually, this system should be able to interact with:
- **Computer/files** (partially true today — see the `read-file` tool in Section 3)
- **Email** (now real — see Section 3)
- **Messaging/texts**
- **Calendar**
- **Web/browser** (now real, including gated writes — see Section 3 and ADR 0011; `personal-admin` can list a form's fields, safely preview-fill it, and — only with explicit human approval — submit it. Phone calls can now be recorded and transcribed locally after the fact (ADR 0030); there is still no placing or answering calls.)
- **GitHub**
- **Other external services**, as they become relevant

For any of these, once built, the architecture should distinguish three tiers of action, not two:
- **Read/analyze** — safe, freely-executable (e.g. reading a file, checking a calendar).
- **Draft** — prepares something (an email, a form submission) without sending or committing it.
- **Send/execute/modify/delete** — consequential and hard to reverse; must eventually require appropriate authorization, auditability, and human control before it happens.

This three-tier split, and the decision to defer building the actual human-approval mechanism until a real consequential tool exists, is already recorded in `docs/adr/0004-consequential-tools-and-deferred-approval-gating.md`. **Nothing here is being built now** — this section is a constraint on future design, not a task list.

## 3. What currently exists

Plain-English explanations of every implemented piece, in `src/`:

- **Core** (`src/core/`) — the heart of the system, with zero direct interaction with the outside world (no network calls, no file access, no calling other programs). It defines the basic vocabulary the whole system uses (see below) and the logic that drives one agent through one task, step by step, to a result. Keeping this piece "pure" like this means it's fast and simple to test, and it can't accidentally do something risky (like sending a real email) itself — only the pieces built specifically to talk to the outside world can do that.
  - **Task** — a unit of work you hand to the system: instructions plus a unique ID. A request, not yet an execution.
  - **Agent** (definition) — a configured persona: which AI model it uses, its instructions ("system prompt"), and which Tools it's allowed to use. This is a description on paper, not something running.
  - **Session** — the growing conversation history (system instructions, your message, the AI's replies, tool results) that gets shown to the AI model on every turn.
  - **Run** — one actual execution of a Task by an Agent. It has a status (queued → running → succeeded/failed), timestamps for when it started and finished, and a full record of every step taken.
  - **Step** — one single back-and-forth turn within a Run: the AI's response, any tools it asked to use, and when that happened.
  - **Result** — the final outcome of a Run: whether it succeeded or failed, and the output text (or error).
- **Orchestrator** (`src/core/orchestrator.ts`) — the actual "conductor" logic living inside Core. It starts a Run, repeatedly advances it one Step at a time (ask the AI model something, run any tools it requests, feed the results back), and stops when the Run succeeds, fails, or hits a safety cap on how many steps it's allowed to take (to prevent an agent looping forever).
- **Agents** — `default` and `demo` (in `core-demo`, both examples/placeholders, not real products) plus real agents from real Packs: `personal-admin`, `dispatcher`, `career-advisor`, and `case-report-writer` (all described below).
- **Packs** (`src/packs/`) — a "Pack" is a self-contained bundle of Agents (and, eventually, their own Tools) for one product or domain. Six exist now: `core-demo` (placeholders, proves the pattern), `personal-assistant` (real-world admin/customer-service drafting, ADR 0005), `dispatcher` (plans and chains multi-agent workflows, ADR 0008), `career-advisor` (medical career/application prep, ADR 0009), `ai-research` (case report drafting, ADR 0010), and `job-search` (job matching and resume tailoring, ADR 0012 — the first Pack outside medicine). IM Brain remains unbuilt.
- **Model providers** (`src/providers/`) — the adapters that actually talk to an AI model vendor's API. There are two: `anthropic.ts` (talks to Claude's real API — requires an API key, which is deliberately not configured in this project) and `fake.ts` (a scripted, deterministic stand-in used for tests and for running the CLI demo without needing a real API key or spending any money).
- **Tools** (`src/tools/`) — capabilities an AI agent can use mid-conversation to act on the world, beyond just talking. `read-file` reads a text file from disk. `read-web-page` reads a logged-in page's visible text (see the Browser integration below). The rest are the email tools below. No other tool category (calendar, GitHub, phone, etc.) exists yet.
- **Inkbox email integration** (`src/integrations/inkbox/`) — the mailbox capability, now real, not just a placeholder:
  - `client.ts` defines the `InkboxClient` port (search/read/draft/send/forward); `fake-client.ts` is the deterministic in-memory stand-in tests use; `real-client.ts` is the production implementation, calling Inkbox's actual Mail API directly with `fetch` (no SDK dependency — see ADR 0006). Inkbox's real API has no server-side draft concept, so `draft-store.ts` keeps "draft" as a concept this project owns, persisted to disk (`JsonFileDraftStore`) so the draft → review → approve → send CLI flow survives across process restarts.
  - `webhook.ts` / `webhook-handler.ts` / `webhook-server.ts` implement a real-time webhook receiver at the fixed path `/inkbox/mail`: it verifies Inkbox's HMAC-signed headers, a timestamp-freshness window, request-id replay protection, and an optional bearer token (`INKBOX_WEBHOOK_AUTH_TOKEN`) before processing `message.received/sent/forwarded/delivered/bounced/failed` events. A received message is forwarded to `OWNER_FORWARD_EMAIL` at most once (`JsonFileForwardingLog` persists that across restarts) and can resume a matching `waiting_for_response` Run in real time; the other five event types are recorded to `JsonFileMessageEventLog` for audit history.
  - `tunnel.ts` opens the actual public tunnel connection (`*.inkboxwire.com` → this local receiver) via `@inkbox/sdk` — the one runtime dependency this project has, deliberately scoped to just this file (see ADR 0006).
  - The CLI's polling fallback (`orchestrator inkbox check-replies`) still exists and still works, alongside the new live receiver (`orchestrator inkbox serve-webhook`, with `orchestrator inkbox webhook-health` to confirm it's up).
  - None of this has been run against a real Inkbox mailbox or a real signing key — every test uses fakes, and real credentials are read only from environment variables at runtime.
- **Browser integration** (`src/integrations/browser/`) — read-only web page access, deliberately built with no way to click, type, or submit anything (ADR 0007):
  - `client.ts` defines the `BrowserClient` port with exactly one method, `getPageText(url)`; `fake-client.ts` is the fixture-based stand-in tests use; `real-client.ts` uses Playwright (this project's second scoped dependency exception, alongside `@inkbox/sdk` — see ADR 0006/0007) to render a page and read back its visible text.
  - Authentication is a one-time, human-driven step: `orchestrator browser login <site> <url>` opens a real, visible browser window for a person to log in themselves (including any 2FA), then saves the session to `.orchestrator/browser-sessions/<site>.json`. The agent never sees or handles a password.
  - The `read-web-page` Tool exposes this to any Agent; `personal-admin` has it. As of this writing it's wired to a session named `sermo`, for reading Sermo's survey feed — not yet exercised against a real, logged-in Sermo session.
  - **Gated form-filling** (`form-client.ts`, ADR 0011) reverses the read-only boundary above, deliberately: `browser-list-form-fields` (read-only), `browser-fill-form-preview` (safe — fills but never submits), and `browser-submit-form` (consequential, `requiresApproval: true`, the only operation that actually clicks submit on a live page) give `personal-admin` a real path to initiating something like a retailer return, gated by the same exact-match human approval as `send-email`. Not bound to one site — works against any site a session exists for, or none at all for a form needing no login. Deliberately not pointed at any platform whose own terms restrict bot access (e.g. Facebook Marketplace) without a human deciding to accept that risk first.
- **Dispatcher and Workflows** (`src/packs/dispatcher/`, `src/core/workflow.ts`, `src/core/workflow-runner.ts`) — the entry point for stating a goal in plain English rather than picking an Agent and running it by hand (ADR 0008):
  - `orchestrator dispatch run --task "<goal>"` runs the `dispatcher` Agent (no Tools, Claude-backed) once to plan an ordered list of steps across whichever real Agents have a `description` (`personal-admin` today; `dispatchableAgents` in `config/load.ts` decides who's eligible), then executes each step as a real Run via the same Core `runToCompletion`/`advance` every Agent already uses, feeding each step's output into the next step's instructions as context.
  - A `Workflow` (`JsonFileWorkflowStore`, under `.orchestrator/workflows/`) is the record of how those Runs chain together — it pauses exactly like a Run does (`awaiting_approval`/`waiting_for_response`) the moment any step's gated Tool needs a human, via `orchestrator dispatch approve <id> [--yes]` / `orchestrator dispatch resume <id> --reply "..."`; a later step never starts before an earlier one is resolved.
  - Not yet built: anything unattended (a Workflow only ever runs when explicitly invoked) or any cross-project status reporting — see the roadmap's "not being built right now" list.
- **Career Advisor** (`src/packs/career-advisor/`) — the first real code for the "Medical Career Advisor" Pack (ADR 0009), scoped to one concrete case: helping a resident prepare an application to AAAAI's Chrysalis Project. One draft-only agent (`career-advisor`) tracks the application's requirements and its October 23, 2026 deadline, drafts a personal statement and CV from real facts the user supplies (never invented), and drafts a request message to a chosen faculty letter-writer — never the letter itself. No AAAAI portal access exists (no browser session for it, unlike Sermo); if the user hasn't given the exact wording of AAAAI's prompt question for the letter-writer, the agent asks rather than guessing. Submitting the application is always a manual step. No new profile/application persistence was built — requirements tracking happens within each conversation, not in a stored record (see ADR 0009 for why).
- **A&I Research / Case Report Writer** (`src/packs/ai-research/`) — the first real code for the "A&I Research" Pack (ADR 0010), scoped to one capability: drafting a structured medical case report (Introduction/Case Presentation/Discussion/Learning Points) from de-identified clinical facts the user supplies. Never invents a clinical finding, lab value, or outcome, and actively strips and flags any patient name or MRN it's given rather than passing it through — a stronger, active version of career-advisor's passive "don't invent" rule, since raw clinical source material is more likely to carry identifiers embedded in it. Has no submission Tool at all (not just a gated one) — submitting anywhere is always the user's own step. Reference facts for the 2027 AAAAI Annual Meeting case-report track (deadline, separate portal) are sourced from a live search; exact formatting/word-limit rules could not be verified from a live source and the agent says so rather than guessing.
- **Job Search** (`src/packs/job-search/`) — the first Pack outside medicine (ADR 0012): finds job openings from public job-board search-results pages and assesses fit against a real resume, tailoring the resume for a promising-but-not-perfect match using only that person's real, existing work experience — never an invented title, employer, metric, or skill. No submission Tool exists; it cannot apply to anything. Introduced `read-job-board-page`, a session-optional counterpart to `read-web-page` for public pages needing no login (`RealBrowserClient`'s `requireSession` option). Not yet solved: genuinely unattended daily delivery of its output anywhere but local Run history — see the roadmap's "Unattended/scheduled execution" entry. LinkedIn deliberately has no browser-automation Tool at all (ADR 0013) — their anti-automation stance is enforced with legal action, not just a technical block like Indeed's, so the safe path is procedural: LinkedIn's own sanctioned Job Alerts feature emails matching listings, forwarded into the existing Inkbox mailbox, and the agent reads those emails with its existing (unmodified) `inkbox-search-mail`/`inkbox-read-thread` tools as a second listing source alongside job-board pages.
- **LinkedIn guest jobs source** (`src/jobsearch/sources/linkedin-guest.ts`, ADR 0028): the one owner-authorized exception to ADR 0013's "no automation against linkedin.com". Reads only LinkedIn's anonymous jobs-guest search and detail pages for Shivani's profile — no login, cookies, credentials or account, ever — once a day inside the 8:30 AM weekday pipeline run, capped at 8 search + 30 detail requests, sequential and paced, never retried; a 429/999/authwall/CAPTCHA ends its run at once. Emits `RawPosting`s (age, applicant count, description, compensation, apply/job URL taken from the page) into the existing dedupe → filter → scoring → digest stages; no filter logic was added. `orchestrator jobs sources` deliberately skips it. Verified live against the guest endpoints on 2026-09-30 (4 requests). Revoked and then reinstated on 2026-09-30 at the owner's explicit instruction; the reinstated source adds a persistent circuit breaker — any throttle or block writes `.orchestrator/jobs/<profile>/linkedin-guest.disabled` and the source then makes no requests until a person deletes that file.
- **Prediction Markets / Polymarket Trader** (`src/packs/prediction-markets/`, `src/integrations/polymarket/`) — the first capability that spends the owner's money (ADRs 0019, 0020). The `polymarket-trader` agent searches Polymarket US markets and reads live prices (public, read-only), previews a limit order, then proposes placing it. Placing always pauses for exact-match human approval via `orchestrator dispatch approve`, and a per-order spending cap (`POLYMARKET_MAX_ORDER_USD`, default $10) is enforced in code. Limit orders only; it cannot cancel, modify, or move funds. Market search and quotes have been run against the live gateway; no live order has been placed.
- **Sleeper** (`src/packs/sleeper/`, `src/integrations/sleeper/`, `src/sleeper/`) — fantasy football management and Sleeper Picks research (ADR 0021, setup in `docs/sleeper-agent.md`). Reads use Sleeper's public, credential-free API plus two undocumented read endpoints (schedule, projections) that degrade to "unavailable". `sleeper-manager` previews matchups with injury/bye flags, ranks waiver pickups, and proposes lineup/IR/taxi/add-drop/waiver/trade writes through Sleeper's unofficial GraphQL API; every write is a dry run unless confirmed (`--confirm` on the CLI, exact-match approval plus `confirm: true` for the agent) and re-checked against live rosters, using only `SLEEPER_TOKEN`. `pickem-researcher` has no placement path at all — Sleeper Picks has no API — and enforces the owner's staking rules in code ($15 start, $3–$4 standard, ≤50% high conviction, ≤2 plays/day, skip weak days); the owner places and logs every entry. Live reads were exercised on 2026-09-25; no write has ever been sent.
- **Settlements** (`src/settlements/`, `src/packs/settlements/`, `src/cli/settlements-commands.ts`) — the owner's class-action settlement claims (ADR 0022, guide in `docs/settlements-agent.md`). A local tracker (`.orchestrator/settlements/tracker.json`, seeded with his 2026-09-25 pipeline) records deadlines, sourced payouts, eligibility verdicts, statuses and confirmation numbers; statuses change only with evidence and `dropped` is permanent. A deadline engine nudges once each at 14/7/3/1 days left and tracks what only he can do (attestations, verification codes, product counts, notice searches). An evaluator scores class definitions against his profile as eligible / not eligible / unverified with the evidence needed. A research sweep reads Top Class Actions and ClassAction.org, skips tracked and do-not-research settlements, and fills a research inbox he decides on. There is no filing path of any kind: he attests and submits every claim himself.
- **X Search Intel** (`src/integrations/x-research/`, `src/tools/x-search-sweep.ts`, `src/cli/x-commands.ts`, ADR 0025): a durable replacement for the workspace X Search Intel skill's original ad hoc "spawn a browser task per topic" method, built on the existing read-only browser Tool (ADR 0007) against a session named `x` (`browser login x <url>`, signed in as @WoozyBets). Runs a pre-flight session health check, treats a blank/crashed page as `"blocked"` rather than silently reporting it as "no real news," retries once via a Top-tab fallback query, and stops early (circuit breaker) after three consecutive blocked topics rather than continuing to hammer an already-throttled session. `orchestrator x search-sweep` runs it from the CLI. Not yet run against the live @WoozyBets session — see ADR 0025.
- **Orchestrator brief watcher** (`src/watcher/`, `src/integrations/github/`, `src/cli/watch-briefs-commands.ts`, ADR 0027): the first (deliberately narrow) GitHub-API integration. `orchestrator watch-briefs poll` reads (never writes via the API) `claude/*` branches for new `docs/delegation/briefs/<task>.md` files, and when it finds one, checks out the branch the brief names and pushes a starter `trial/delegation-log.md` there — via local `git`, the same `commitAndPush` helper the job-search feedback loop already uses, not a GitHub write call. It never opens or merges a PR and never runs a brief's instructions itself; every approval gate and the merge-on-green-only rule are untouched. `orchestrator watch-briefs loop` repeats that poll roughly every 3 minutes, matching Muse's own watcher cadence (`docs/delegation/PROTOCOL.md`). Needs `GITHUB_TOKEN` (read-only) from the environment; without it the command fails with a clear message rather than degrading silently.
- **Blocked-vs-quiet browser hardening** (`src/integrations/browser/page-health.ts`, ADR 0026): the X sweep's health check, blocked-vs-empty classification, per-domain circuit breaker, and pacing, shared by every browser Tool. `read-web-page` and `read-job-board-page` report a `status:` line and retry a blocked read once. The form tools check the page before filling, never retry a submit, and report an ambiguous post-submit page as `submitted:unknown` for a human to verify. `orchestrator browser health <site> <url>` probes one page. Not run against a live account.
- **Google Voice channel** (`src/voice/`, `src/cli/voice-commands.ts`): texts and voicemail from Toozy's Google Voice number, forwarded into Gmail and handed to `orchestrator voice ingest` as JSON (ADR 0023).
  - **Verification-code broker.** A code is used only if the agent itself started a verification for that service less than 10 minutes earlier, and the message names that service. Every other code is a security alert, and the code isn't used. Banks, payment apps, exchanges and X are refused because they get the real mobile. Code values never reach a file or a log.
  - **Reply drafter.** Buyer texts first go through a scam classifier; a flagged text gets an alert and no draft. Otherwise it drafts templated replies to availability, price and pickup questions about a recorded listing. Each reply needs Toozy's exact-text approval, and send is its own switch. Approved replies are released to an outbox for the agent's Gmail connector.
  - Three switches (`VOICE_CODE_BROKER_ENABLED`, `VOICE_REPLY_DRAFTER_ENABLED`, `VOICE_REPLY_SEND_ENABLED`) are off unless set to exactly `"true"`.
  - State lives in gitignored `.orchestrator/voice/`. The real number and addresses are never committed.
  - Not yet run against a real forwarded Voice email.
- **Call recording and transcription** (`src/calls/`, `src/cli/calls-commands.ts`, ADR 0030): `orchestrator calls record --consent` records an iPhone call relayed to the Mac (both sides, via a BlackHole aggregate device) with ffmpeg, then transcribes it locally with whisper.cpp. It refuses to record without `--consent`, stores the consent time next to the recording, and keeps audio and transcripts in gitignored `.orchestrator/calls/`; nothing is uploaded. `calls doctor` checks the setup. Setup guide: `docs/operations/call-transcription.md`. Not yet run on the real Mac.
- **Registry** (`src/registry/`) — a simple lookup system: a place where Agents, Providers, and Tools are each registered under a name, so the system can find "the agent called X" or "the tool called Y" when it needs to.
- **Config** (`src/config/load.ts`) — the "wiring" step that runs when the program starts: it registers the built-in Providers and Tools, then loads all six current Packs (`core-demo`, `personal-assistant`, `dispatcher`, `career-advisor`, `ai-research`, and `job-search`).
- **Store** (`src/store/run-store.ts`) — where the history of a Run gets saved so it can be looked at later. There are two versions: one that only keeps history in memory (used for fast tests), and one that saves each Run as a JSON file on disk (used by the actual CLI, under a `.orchestrator/` folder that is not saved to Git).
- **CLI** (`src/cli/index.ts`) — the command-line program you actually run. It supports four commands: `run` (execute a task through an agent), `list-agents` (show what agents exist), `status` (a live snapshot of agents/providers/tools/packs, test results, and Git state), and `help`.
- **Tests** — the automated suite covers Core's step-by-step logic, Providers, Tools, Registry, Packs, configuration wiring, persisted Runs/Workflows, dashboard/coworker coordination, and CLI commands. It uses Node's built-in test runner, so no separate test framework is required.
- **Documentation** — `CONTEXT.md` is the project glossary; `docs/adr/` records architectural decisions; `docs/agents/team-handoff.md` defines the shared cross-team handoff protocol.
- **Git/GitHub** — a real Git repository, pushed to a private GitHub repository (`github.com/irtizaa36-web/AI-Agent-System`); `main` was fully in sync with `origin/main` as of the last push.

## 4. What we have actually accomplished

Concrete, tested, working capabilities as of today:

- You can run a task through the AI orchestration engine from the command line and get a real result back.
- You can do this entirely for free and offline, using the built-in fake/demo agent — no API key, no cost, fully repeatable.
- The engine is wired to run tasks through real Claude models when an operator configures credentials locally. Credentials and live runtime status are deliberately not source-controlled; verify them on the target machine rather than inferring their state from Git.
- The email integration includes a real Inkbox Mail API client and a real-time, signature-verified webhook receiver, with tests using fakes. Live mailbox credentials and event history are local operational state, not repository state.
- Every Run's full history (what was asked, what the AI said, what tools ran, when each step happened) is automatically saved to disk as a readable JSON file.
- The system can look up available agents and reject unknown ones with a clear error message.
- The pattern for adding a new Pack is proven end-to-end by the current real Packs, while their broader product visions remain intentionally scoped to concrete use cases.
- TypeScript is configured for strict type-checking; current test results must be established in the workspace where the suite runs.

This section is stale on Packs specifically — see Section 5, where real Packs now exist — but accurately reflects everything else as of this writing.

## 5. Long-term product vision: Domain Packs

The Core stays domain-agnostic (Section 7). All domain-specific capability is meant to live in Packs — self-contained bundles of Agents and, eventually, their own Tools. Four domain Packs were originally planned with no code; three still have none, and one — Medical Career Advisor — now has an initial real version, built the moment a concrete real need (see the Career Advisor bullet in Section 3) justified it:

- **A&I Research** — a research assistant focused on Allergy & Immunology. Potential eventual capabilities: literature research, evidence synthesis, identifying research questions, novelty/gap analysis, case-report opportunities, retrospective study ideas, study design, variables and statistics, abstracts, manuscripts, conference/journal targeting, citation/reference verification, and research project tracking. **Now has real code**, scoped narrowly to one capability — case report drafting (`case-report-writer`, ADR 0010) — rather than the full breadth described here; the rest remains aspirational until a further real need justifies it, same pattern as Medical Career Advisor below.
- **IM Brain** — a clinical reasoning and education assistant for Internal Medicine. Potential capabilities: differential diagnosis, diagnostic reasoning, management reasoning, teaching, evidence verification, and rounds preparation. This is clinical decision support/education with human verification, **not** autonomous patient care (see Section 9). Still no code.
- **Medical Career Advisor** — a broader medical career/application advisor spanning premed, medical school, residency, fellowship, research/career strategy, application review, interview preparation, program research, and timelines — potentially with a human consultant in the loop (the real-world "Scholr" consulting role is one example of what this could look like). **Now has real code**, scoped narrowly to one concrete case (see the Career Advisor bullet in Section 3 and ADR 0009) rather than the full breadth described here — the rest remains aspirational until a further real need justifies it.
- **Personal Assistant** — handles tedious real-world administrative and customer-service tasks (returns/refunds, order tracking, disputes, routine emails and calls, navigating customer-service chatbots/phone menus), eventually choosing the right method (website, chatbot, email, phone) itself rather than requiring Irtiza to specify it. Confirmed to fit the existing architecture with no Core changes (ADR 0005) — it registers as a Pack like any other, and every external capability it eventually needs (email, phone, browser, chat) becomes a Tool/Provider adapter when actually built, not before.

Each should be built as its own Pack sitting on top of the generic, unchanged Core — not as special-case logic hard-coded into the engine itself.

## 6. Important architectural principles

Standing rules this project has committed to, most of them recorded formally in `docs/adr/`:

- **Core remains domain-agnostic.** The engine must never contain medical, research, or career-specific logic.
- **Domain-specific logic belongs in Packs**, not in Core (ADR 0003).
- **Model providers should remain replaceable.** Adding a new AI vendor should never require changing Core (ADR 0001).
- **Prefer small, composable components** — deep, focused modules behind simple interfaces, rather than large, tangled ones.
- **Avoid unnecessary dependencies and infrastructure.** The project has exactly two runtime dependencies, each scoped to the one narrow thing Node built-ins genuinely can't do: `@inkbox/sdk`, scoped to the single file that opens the Inkbox tunnel connection (ADR 0006), and `playwright`, scoped to the browser integration's real client and login command, for rendering and reading an authenticated page (ADR 0007). Everything else, including the Inkbox Mail API client itself, still calls `fetch` directly with zero dependencies (ADR 0002).
- **Test important behavior.** All 33 pieces of behavior described above are covered by automated tests, not just claimed to work.
- **Build infrastructure when a real use case requires it, not speculatively.** Several deferred items in Section 10 are deferred specifically because building them without a real use case to design against would mean guessing.
- **Consequential capabilities must be split into safe read/draft operations and separate, gated send/execute/modify/delete operations** (e.g. a `draft-email` tool must be a different tool from `send-email`) (ADR 0004, Section 2).
- **Human approval / "approval-gating" for risky actions is intentionally not built into Core yet.** It will be designed once a real consequential tool (e.g. actually sending an email) exists to design it against, rather than guessed at now (ADR 0004).
- **Useful functionality over infrastructure for its own sake.** A solid foundation was deliberately built first, but the project must not get trapped endlessly building infrastructure. For every proposed change, ask:
  1. Does this solve an immediate problem?
  2. Does it preserve future extensibility?
  3. Does it avoid unnecessary complexity?
  4. Does it avoid hard-coding around one model, domain, or service?
  5. Does it preserve appropriate control over consequential actions?
  Don't add infrastructure merely because it might someday be useful.

## 7. Research and medical safety

**For research functionality** (A&I Research and the research aspects of the other Packs):
- Never fabricate studies or citations.
- Do not overstate novelty.
- Verify important claims; distinguish evidence from inference.
- Account for changing journal/conference requirements rather than assuming they're fixed.
- Avoid unnecessary exposure of PHI or other sensitive information.

**For medical functionality** (IM Brain, and the medical aspects of the other Packs):
- Educational / clinical decision-support role only.
- Important medical/research outputs require appropriate human verification before being relied upon or acted on.
- **Do not autonomously make clinical decisions.** A clinician remains the decision-maker at all times.
- **No autonomous patient care.**
- **No EHR (Electronic Health Record) actions** unless and until a separately designed, explicitly authorized integration exists for that purpose. None exists today.
- **Avoid PHI** (Protected Health Information — real, identifiable patient/research-subject data). Development and examples should use de-identified or fictional cases.

## 8. Development philosophy: how we decide what to build

We deliberately spent time establishing a solid foundation (Sections 3–4), but the priority now is **useful functionality over infrastructure for its own sake**. The five-question checklist in Section 6 is how every proposed change — big or small — should be evaluated before building it.

## 9. Development workflow

**PLAN → DELEGATE → IMPLEMENT → TEST → VERIFY → INTEGRATE → DELIVER**

Division of responsibility:

- **Irtiza** is the product/domain owner and domain expert, not a computer-science expert. He gives high-level instructions in plain English and expects Claude Code to handle the engineering work — including running terminal commands — rather than being asked to type or execute technical steps himself.
- **Claude Code** is the engineering agent: understands the goal, inspects the real repository and documentation, proposes an approach in plain English with tradeoffs, asks for approval before major architectural changes, implements the smallest sensible version, runs tests/build, explains in practical terms what was actually produced, and commits when appropriate — without pushing to GitHub unless explicitly asked.
- When explaining a technical decision, explain what it actually produces or accomplishes in practical terms — not jargon for its own sake.
- **ChatGPT** plays a separate, complementary role outside this coding environment: translating technical decisions into plain English and helping think through architecture/product decisions.

## 10. How future Claude sessions should behave

When Irtiza gives a high-level idea rather than a technical specification, the expected loop is:

1. Understand the goal.
2. Inspect the actual repository and documentation (`PROJECT-BRAIN.md`, `CONTEXT.md`, `docs/adr/`, the real code) — never assume it matches what a past conversation described.
3. Explain the proposed approach in plain English.
4. Identify important tradeoffs.
5. Ask for approval before major architectural changes.
6. Implement the smallest sensible version — avoid unnecessary redesign.
7. Run tests/build.
8. Explain what was actually produced, in plain English, distinguishing clearly between what now exists and what is merely planned or proposed.
9. Commit changes when appropriate.
10. Do not push to GitHub unless explicitly asked.

Also: use appropriate installed Matt Pocock skills (domain-modeling, codebase-design, etc.) when they fit the task, and ask for clarification when a major product decision is ambiguous rather than guessing.

## 11. Current roadmap (high-level only)

This is a directional sketch, not a committed plan or a detailed implementation schedule. Not all of it may end up being built, and nothing here should be treated as scheduled work.

1. **Foundation** — the reusable engine itself: Core, Providers, Tools, Registry, Packs, Store, CLI. *(Largely in place today, as described in Sections 3–4.)*
2. **First useful domain Pack** — build one real Pack (A&I Research is the current leading candidate) to prove the architecture holds up for a real product, not just a placeholder. Design comes before implementation for this step.
3. **Verification** — introduce real evidence/citation verification behavior once a domain pack actually needs it.
4. **More domain Packs** — build out the remaining planned domains once the pattern is proven.
5. **Controlled external capabilities** — if and when justified, carefully introduce tools that touch the outside world (Section 2's list), each split into read/analyze vs. draft vs. gated send/execute/modify/delete per ADR 0004, with human-approval infrastructure designed at that point.
6. **Production hardening** — if this grows beyond a local CLI tool (e.g. toward the "service" half of the CLI-first/service-ready design), address deployment, persistence beyond local JSON files, and related concerns at that time.

Each stage is intended to be justified by an actual need at the time, not built ahead of it — consistent with Section 6's "build infrastructure when a real use case requires it."

For what's currently and intentionally *not* being built, see the list below.

### Not being built right now

- **Unattended/scheduled execution** — a Workflow only ever runs when a person explicitly invokes `orchestrator dispatch`; nothing polls, watches, or runs on a timer yet (multi-agent chaining itself is now built — see the Dispatcher/Workflow bullet in Section 3 and ADR 0008). ADR 0012 surfaced a sharper version of this gap while building the Job Search pack: even a scheduled (e.g. launchd) invocation of an Agent has nowhere unattended to deliver its output, since `send-email`'s approval gate (ADR 0004) has no exception for "no human is present" and this codebase has no other outbound channel of its own (Google Drive/Gmail access exists only as the operator's own session tools, not as something this project's compiled CLI can call). Solving that is a real, still-open architecture decision, not something quietly worked around.
- **Cross-project status reporting** — an agent that keeps tabs on multiple external projects and reports back unprompted. The persisted Workflow/Run history ADR 0008 introduced is what such a capability would eventually read from, but building the reporting layer itself is a separate, later decision.
- **SMS/phone automation** (no voice/telephony provider exists; the only phone-related piece is after-the-fact local recording and transcription of calls the operator makes on the Mac, ADR 0030) **or calendar integration.** (Email, browser reading, and — as of ADR 0011 — gated browser form-filling are now built; see Section 3. Automating against a platform whose own terms restrict bot access, e.g. Facebook Marketplace, is a deliberate case-by-case human judgment call, not something this system defaults into even though the underlying form-filling capability is generic enough to technically point there.) **GitHub integration now has real code, but only the read-only slice ADR 0027 needed** — listing branches and reading file content for the orchestrator brief watcher (see Section 3). No PR creation, merging, issue/comment writing, or any other GitHub write path exists; those remain undone until a real need justifies them the same way this one did.
- **EHR integration** of any kind.
- **Deployment infrastructure** (servers, hosting, CI/CD pipelines, containers).
- **Unnecessary databases or external services** — the project currently uses only local JSON files for storage.
- **Configuring `ANTHROPIC_API_KEY` or incurring any API billing**, unless and until explicitly decided later.

This list will shrink over time as real use cases justify building each item (Section 6) — it is not a permanent ban, just today's boundary.
