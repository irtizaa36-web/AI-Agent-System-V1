---
status: accepted
---

# Tailored resume variants, drafted on demand and stamped as drafts

ADR 0014 closed by naming exactly what the scheduled pipeline would not do: "It does not tailor a resume, write a cover letter, prefill a form, or draft outreach — those are Phases 2 and 3." This ADR does the first of those, and draws the boundary around it as carefully as 0014 drew the boundary around scoring.

**The decision is a human-invoked drafting command, not a pipeline stage.** `jobs tailor --profile <name> --job <record-id>` reads one scored job record and the base resume on file, asks a model to reframe that resume against that posting, and writes the result to `profile/<name>/tailored/<job-id>.md`. It never runs on the schedule, never fires per posting, and never touches a browser or an application form. The reason tailoring stayed out of the unattended path is the same reason scoring's model call was the only model call: the pipeline's job is to find and rank, cheaply and repeatably. A resume draft is judgment-heavy, long-form, and exists for one posting and one person — running it per posting per run would multiply the model's workload by the size of the market instead of the size of her attention. She asks for a draft when a posting is worth her time; the pipeline's own score is how she decides that.

**The no-fabrication rule is enforced the same way the records layer enforces "a salary never published is null": as structure, not hope.** The rules live in the cached system prompt and are absolute there: never invent experience, employers, titles, dates, metrics, degrees, or skills; every bullet must be traceable to something written in the base resume; the model may only reorder, reword, and emphasize. The full resume goes into the prompt verbatim — the complete source text is the fabrication boundary, and the model can only reframe what it can actually read. And a posting's "gaps" get the same treatment records.ts gives them at the JobRecord level: the draft must end with a "## Gaps" section naming every stated requirement the resume does not cover, so an unmet requirement arrives named rather than quietly papered over.

**Every draft is stamped at birth.** The first line of every written file says DRAFT, names the job, names the record id, and says do not submit. This is the same discipline as ADR 0017's "a missing resume fails loudly": a file found out of context — forwarded, opened months later, sitting in a folder — cannot be mistaken for a finished, submission-ready resume. The draft is her starting point, not her application.

**No new client, no new port.** Drafting reuses `ScoringClient` from scoring-client.ts — the same `fetch`-based Messages API client, the same `ANTHROPIC_API_KEY`, the same error handling — because a one-call-per-invocation drafting step needs nothing the scoring port doesn't already provide. Widening nothing and inventing nothing keeps ADR 0001's ports-and-adapters shape and ADR 0002's built-ins-only rule intact. The model is Haiku (`claude-haiku-4-5`), per the standing rule that cheap drafting work routes to the cheapest capable model; a steady-state draft costs a few cents, and `--dry-run` prints the prompt plus a labeled cost estimate so the prompt can be reviewed before any spend. The call is also recorded in the same cost ledger scoring uses, because drift is drift wherever the model runs.

**What this deliberately does not do.** It does not auto-submit, auto-send, or prefill anything — no code path here reaches a browser, an email, or a form, and `ApplicationRecord.status` still has no value any code path sets except by a human action; the record this command creates starts at `queued` and stays there. It does not write cover letters or outreach (those are still Phase 3). It does not verify the draft against the resume after the fact — the structural rules make fabrication a prompt violation, not a tested property, and the Gaps section plus the draft stamp are what a human reviewer checks, which is why the output is stamped for her review and never for direct use. And it does not pretend a missing resume is fine: no base resume, no draft, loudly.

**The open item this ADR leaves.** The real resume is gitignored and lives only on the machines that need it. The fabrication rules and the Gaps section were therefore proven here against synthetic fixtures, not her actual resume — the first real draft against a real posting should be read end to end by her before this is treated as trusted.

---

## Addendum 2026-09-28 — post-draft verification (Stage 11)

The "What this deliberately does not do" section above says the draft step
"does not verify the draft against the resume after the fact — the structural
rules make fabrication a prompt violation, not a tested property." That
statement is superseded as of this addendum. Stage 11 adds the verification
as structure, next to the prompt rules rather than instead of them:

- **Evidence ledger.** Every draft is now born with
  `profile/<name>/tailored/<job-id>.ledger.json`, written by the same command
  that writes the draft. It deterministically extracts employers, titles,
  dates, metrics, degrees, and skills from the base resume, then classifies
  every draft claim (bullets/sentences, minus the stamp header and the ##
  Gaps section) as `confirmed` (traces verbatim to the resume),
  `supportable` (partially traces — plausibly a rewording), or
  `unsupported` (nothing traces). A claim stating a metric the resume never
  states is unsupported no matter how well-worded the rest is. The classifier
  is deliberately conservative — a heavily reworded-but-true claim can land
  in `unsupported`, because a ledger that waves fabrications through is worse
  than one that asks a human to glance twice. The ledger records the SHA-256
  of the exact base resume text the draft was checked against.
- **Drafts are born `pending-approval`.** The application record for a fresh
  draft starts (or is reset to) `pending-approval`; a new draft never
  inherits a previous approval.
- **Explicit approval.** `jobs tailor --approve --job <id>` renders the
  base-vs-tailored diff and flags the unsupported claims prominently. Without
  `--confirm` it is review-only and changes nothing; `--confirm` is the
  explicit tap that marks the ledger `ready` (timestamped) and advances the
  application to `materials_ready`. Fail closed throughout: only a
  `pending-approval` ledger can become ready, and a second confirmation is a
  no-op that never re-stamps.
- **Nothing exportable before approval.** The pipeline, the dashboard, and
  every other command treat `pending-approval` as not-ready; the ready state
  exists only after the human tap.

The open item from the original ADR stands: the fabrication rules and the
ledger were proven against synthetic fixtures, not her actual resume — the
first real draft against a real posting should still be read end to end by
her before this is treated as trusted.
