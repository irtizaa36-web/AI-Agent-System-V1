---
status: accepted
---

# Scheduled supervised LinkedIn pull via Muse browser task (pipeline never touches linkedin.com)

## Context

ADR 0013 deliberately excluded all browser automation against linkedin.com
(account-safety: LinkedIn enforces anti-automation terms aggressively and has
pursued legal action against scrapers; its job results are largely login-gated).
LinkedIn coverage has come only from forwarded Job Alert emails (ADR 0013, ADR
0015). On 2026-09-28 Toozy explicitly authorized a narrower, supervised
exception: **Muse** (the assistant, via a scheduled browser task — human-paced,
supervised) may sign in as Shivani and pull her LinkedIn job alerts,
saved-search results, and new matching postings each morning. Toozy saved her
LinkedIn login to the Secure Vault on 2026-09-28 via a secure card; the
browser task signs in with that credential via credential_fill reference only
— the value is never pasted, logged, or written to disk, and nobody asks for
it in chat.

## Decision

1. A weekday-morning scheduled browser task ("shivani-linkedin-pull", ~9:30 AM
   CT, before the 11:00 AM pipeline run) signs in with the vault credential
   (credential_fill reference only — the value is never pasted, logged, or
   written to disk) and performs a READ-ONLY pull: job-alert emails' linked
   listings, saved-search result pages, and new matching postings. No Easy
   Apply, no applications, no recruiter messages, no follows, no mass actions.
2. The pull's output is structured JSON (schema in
   `docs/job-search/linkedin-pull-runbook.md`), delivered to the Mac mini and
   written to `profile/shivani/linkedin-pull/<date>.json`. The pipeline
   ingests that file through a new `linkedin-pull` source adapter
   (`src/jobsearch/sources/linkedin-pull.ts`) like any other source —
   normalize → dedupe → filters → scoring. **The pipeline itself never makes
   any request to linkedin.com, programmatically or otherwise.** If the file
   is absent, the source yields nothing and the run continues.
3. Guardrails (hard):
   - Human pace: 8–15s between page loads with jitter; max ~25 job detail
     pages per run; no rapid-fire navigation.
   - Verification challenge / CAPTCHA / "unusual activity" notice: STOP
     immediately, report to Toozy as a his-hands step. Never attempt to
     defeat, bypass, or wait out a challenge.
   - Restriction or warning banner on the account: stop the run, report.
   - Session reuse preferred; fresh sign-in only via the vault reference.
   - Never sign in as her without Toozy's prior ask (the standing rule).

## Why this is acceptable (and what changed since ADR 0013)

ADR 0013's ban targeted *unattended automation* — the failure mode is a bot
hammering LinkedIn from a datacenter IP. This design keeps a human-paced,
supervised, read-only session with explicit per-day user authorization,
bounded page counts, and immediate stop-on-challenge. The residual risk
(LinkedIn flagging the account) is real and is Toozy's informed call; the
stop-on-challenge rule exists so a flag never becomes a lockout we caused.

## What this deliberately does NOT do

- No pipeline code touches linkedin.com — the ban in ADR 0013 stands for the
  engine; only the supervised browser task (outside the engine) visits it.
- No credential storage in the repo, no credential values in logs/handoffs.
- No applying, no Easy Apply, no outreach, no acceptance — the hard boundaries
  from the V2 revamp still hold.
- No CAPTCHA/verification defeating, ever.
- No expanding this pattern to other login-gated sites without its own ADR.
