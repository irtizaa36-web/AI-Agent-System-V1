---
status: accepted
---

# Stage 14 CRM boundary: the tracker records, it never acts

## Context

Shivani is actively applying and wants a job ASAP, so the pipeline grows an
application tracker (Stage 14): where each application stands, when to nudge,
which postings she rejected, which companies she muted. A tracker that can
send email, submit applications, or accept offers on her behalf would be a
liability machine — and she never asked for one. The morning pull is already
read-only by ADR 0020; the CRM must be at least as strict.

## Decision

1. **The CRM records what she did; it never does anything for her.**
   `jobs applied` is an explicit tap she makes *after* she applied on the
   employer's own site. The follow-up list in the digest is a readout, not a
   sender — no email, no message, no nudge is ever sent automatically.
2. **No auto-submit, no outreach, no acceptance, no auto-apply.** The status
   machine (`saved → queued → … → applied → screening → interview →
   offer/rejected/withdrawn`) has no transition that reaches the outside
   world; `offer` is terminal for the tracker (what she does with an offer
   is her hands, recorded in notes).
3. **Mail scan is read-only.** `jobs mail-scan` requires `--dry-run`, reads
   an exported mailbox file, classifies messages, and prints proposals. It
   writes nothing and transitions nothing. Applying a proposal is her tap
   via `jobs stage`.
4. **LinkedIn sync never infers rejection.** Applied history and saved jobs
   from the supervised pull become source-tagged `linkedin` application
   records. "In Progress" → `applied`. "No longer accepting", an empty
   status, or silence → still `applied` (the posting closing is not a
   rejection of her). An explicit rejection *email* proposes `rejected` —
   a proposal only, until she taps `jobs stage`.
5. **Rejecting a posting never mutes the company.** `jobs reject` sets one
   record to `rejected`; `jobs mute-company` is a separate explicit action
   with separate storage, merged into the run's company exclusions.

## Consequences

- Every CRM command is safe to document, safe to script around, and safe to
  re-run: none of them has a side effect beyond the tracker's own JSON.
- The boundary is enforced in code, not just in prose: `mail-scan`
  refuses to run without `--dry-run`; the status machine throws
  `IllegalApplicationTransitionError` on undefined moves; the sync has no
  code path that creates a `rejected` record.
