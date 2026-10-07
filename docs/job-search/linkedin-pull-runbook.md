# LinkedIn supervised morning pull — browser-task runbook

**Status:** authorized by Toozy 2026-09-28 (see ADR 0020). This runbook is the
exact brief template for the scheduled morning browser task. It does NOT
revisit ADR 0013: the pipeline itself never automates against linkedin.com in
any form. Only this supervised, human-paced, read-only browser task visits
LinkedIn — and only with Toozy's standing authorization, which he may revoke
at any time.

## Schedule

- **Weekdays, ~9:30 AM CT** — before the 11:00 AM pipeline run, so the pull
  file is on disk when the `linkedin-pull` source adapter reads it.
- Dispatched as a scheduled browser task (cron-owned by parent/ops, not by
  engine code). The cron's job: (1) dispatch the task per the brief below,
  (2) deliver the returned JSON to the Mac mini session, which writes it to
  `profile/shivani/linkedin-pull/<date>.json` (`<date>` = `YYYY-MM-DD` in
  America/Chicago).

## Sign-in

- Toozy saved Shivani's LinkedIn login to the Secure Vault **himself**
  (submitted 2026-09-28) via a secure card. The credential value never
  appears in chat, in this runbook, in logs, or in any handoff.
- The task signs in with the vault `credential_fill` **reference only** —
  never a pasted value, never a value written to disk.
- If the vault reference ever goes missing: **STOP and escalate to Toozy as
  a his-hands step.** Never ask him to paste the password; never invent one.
- Standing rule (unchanged): never sign in as her without Toozy's prior
  ask. This runbook IS that ask, for this one read-only pull, until he says
  otherwise.

## Scope — READ ONLY

Pull, in this order:
1. Her LinkedIn **job alerts** (new matches since yesterday).
2. Her **saved searches** — new results only.
3. Matching **posting detail pages** for genuinely new matches.

Explicitly OUT of scope — never do these, even if the UI offers them:
- Easy Apply, applications, "Apply" on any listing.
- Recruiter InMail / messages — do not open threads, do not reply.
- Follows, connects, likes, saves ("Save job" is a write — skip it).
- Profile edits of any kind.

The task READS the job market. It never acts in it.

## Human pace (hard limits)

- **8–15 seconds between page loads**, with jitter. No rapid-fire
  navigation, no parallel tabs hammering the site.
- **Max ~25 job detail pages** per run. If there are more matches, take the
  25 newest and stop.
- Prefer reusing the existing signed-in session; fresh sign-in only via the
  vault reference.

## Hard stop rules

On ANY of these, **STOP the run immediately** and escalate to Toozy as a
his-hands step. Never attempt to defeat, bypass, wait out, or "solve" one:

- Verification challenge, CAPTCHA, or "verify you're human" interstitial.
- "Unusual activity" / "unusual sign-in" notice.
- Account restriction, warning banner, or temporary limit notice.
- A sign-in flow that demands anything beyond the vault credential
  (phone verification, authenticator, email code) — hand it to Toozy; do
  not complete it.

A stopped run is a successful run: the pipeline continues on the ATS boards,
and the pull resumes tomorrow.

## Output — JSON schema and delivery

Write one JSON file per run:

```jsonc
{
  "pulledAt": "2026-09-28T14:30:00.000Z", // ISO timestamp of the pull
  "items": [
    {
      "id": "1234567890",                 // stable id (LinkedIn job id)
      "title": "Marketing Manager",
      "company": "Acme Corp",
      "url": "https://www.linkedin.com/jobs/view/1234567890/",
      "location": "Remote",               // as LinkedIn states it; "" if absent
      "postedAt": "2026-09-27T00:00:00.000Z", // ISO when stated; null when absent — NEVER guessed
      "summary": "Plain-text posting summary…", // plain text, no HTML
      "salaryMin": 90000,                 // numbers when stated; null when absent — NEVER guessed
      "salaryMax": 120000,
      "salaryCurrency": "USD"             // null when absent
    }
  ],
  "appliedHistory": [                  // her applied-jobs history — revealed preferences for the affinity module
    {
      "title": "Senior Marketing Program Manager",
      "company": "Acme Corp",
      "location": "Remote",            // as LinkedIn states it; "" if absent
      "dateApplied": "2026-09-20",     // ISO date when stated; null when absent — NEVER guessed
      "status": "applied"              // LinkedIn's application status; null when absent
    }
  ],
  "savedJobs": [                       // her saved (not yet applied) jobs — synced as `saved` leads, never applications
    {
      "title": "Field Marketing Manager",
      "company": "Baseten",
      "location": "NYC hybrid",        // as LinkedIn states it; "" if absent
      "url": "https://www.linkedin.com/jobs/view/1234567890/", // null when absent
      "savedAt": "2026-09-28"          // ISO date when stated; null when absent — NEVER guessed
    }
  ]
}
```

Field rules: `id`, `title`, `company`, `url` are required — an item missing
any of them is dropped by the adapter. Every other field is nullable, and
**null means "LinkedIn didn't state it," never "probably X."** No field is
ever inferred or filled in.

`appliedHistory` and `savedJobs` are optional: pull files written before
2026-09-28 predate them, and a missing or empty array simply means no
signal — the pipeline scores exactly as before, and the sync creates
nothing. Entries missing `title` or `company` are skipped individually.
Saved jobs sync into application records with status `saved` (leads, not
applications); "In Progress" applied jobs map to CRM stage `applied`.

## QA — cross-check against the canonical resume

The pipeline treats `~/workspace/jobsearch-v2/profile/shivani/resume.md`
(canonical markdown of her real resume, gitignored, delivered to the Mac
mini separately) as the ONLY factual source for scoring and tailored
resumes. When the pull lands, cross-check it against that resume and flag
discrepancies — this is a human-paced QA step, not pipeline code:

1. **Profile extraction vs resume:** when the LinkedIn profile extraction
   lands, compare titles, employers, and dates against the resume. Flag
   title mismatches, employer contradictions, and date overlaps.
2. **Applied history vs resume:** compare each `appliedHistory` entry's
   title/employer/date against the resume. Seniority pivots (e.g. applying
   to Senior roles while the resume shows a non-Senior title) are SIGNAL,
   not errors — they feed the affinity module. Date overlaps (applied
   somewhere while the resume shows her employed elsewhere full-time) and
   employer contradictions get flagged for her review.
3. **Posting data vs resume:** nothing from the pull may contradict the
   resume in a tailored draft — the Stage-11 evidence ledger enforces this
   deterministically at draft time.

Flagged discrepancies go to Toozy/Shivani for review; the pipeline never
auto-corrects the resume from LinkedIn data.

### Alert hygiene check (2026-09-28 snapshot finding)

Her 16 active job alerts are broader than her applications. Two are
seniority-mismatched noise and should be flagged in the QA report:

- **"business consultant" (Boston/Chicago/NYC)** — consulting track, not
  her marketing/program-management target titles, and the metros add noise
  outside her Dallas/Austin/NYC + remote skew.
- **"marketing coordinator/specialist" (NYC)** — coordinator/specialist is
  below her level (AWS Marketing Program Manager, ex-$192M P&L owner);
  these alerts dilute the morning pull with roles she will not apply to.

Recommendation: pause/delete those two alerts on LinkedIn. **This is a
write to her account — her explicit tap required, never done unattended.**
The recommendation stays a recommendation in the QA report; the pipeline
never prunes alerts itself.

### Known discrepancy — resume wins (2026-09-28 snapshot finding)

- LinkedIn lists **Vendor Manager — Amazon as Seattle WA**; the canonical
  resume says **Dallas TX**. **The resume is the source of truth.**
  Recommend correcting LinkedIn to Dallas — her hands, approved-write only.
  This stays in the QA report until she confirms the correction.

Delivery: the task returns the JSON to the dispatcher, which hands it to the
Mac mini session to write at:

```
profile/shivani/linkedin-pull/<date>.json      # <date> = YYYY-MM-DD, America/Chicago
```

The pipeline's `linkedin-pull` source adapter ingests that file on the next
run (normalize → dedupe → filters → scoring). If the file is absent, the
source yields nothing and the run continues — the ATS sweep is the primary
coverage, this pull is additive.

## The brief template (copy into the scheduled task)

> Morning LinkedIn pull for Shivani's job search (read-only, supervised).
> Runbook: docs/job-search/linkedin-pull-runbook.md.
>
> 1. Sign in ONLY via the Secure Vault `credential_fill` reference for her
>    LinkedIn login (Toozy saved it himself). If the reference is missing,
>    STOP and escalate to Toozy — never ask for or accept a pasted password.
> 2. Read-only pull, human pace (8–15s between loads, jitter, max 25 detail
>    pages): her job alerts (new since yesterday), then saved searches (new
>    results only), then detail pages for genuinely new matches. Also extract
>    her applied-jobs history (title / company / location / date applied /
>    status per application) into the pull file's `appliedHistory` array —
>    read-only, from the "My Jobs → Applied" view.
> 3. NEVER: Easy Apply / applications / messages / follows / saves / profile
>    edits.
> 4. HARD STOP + escalate to Toozy on: verification challenge, CAPTCHA,
>    "unusual activity" notice, restriction/warning banner, or any sign-in
>    step beyond the vault credential. Never defeat or bypass.
> 5. Return the pull as JSON matching the runbook schema (nulls, never
>    guesses) for delivery to
>    `profile/shivani/linkedin-pull/<date>.json` on the Mac mini.
