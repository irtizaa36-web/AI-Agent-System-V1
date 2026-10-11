# ppt-master Deck Pattern (2026-10-10)

Source: hugohe3/ppt-master (~60K stars, MIT) — a workflow prompt pack that builds
genuinely native .pptx (masters/layouts, editable shapes, data-backed charts).

## Patterns to steal for any agent-built deck/artifact

1. **Argue first, design second.** Run a narrative/argument pass (what is the deck
   trying to convince the reader of, in what order) BEFORE touching layout.
2. **Published capability boundary.** Ship an honest ledger of what the pipeline
   supports (their PowerPoint↔SVG mapping) plus a deliberate omission list
   (theirs: SmartArt omitted on purpose, not a gap). Every agent-built artifact
   should declare what it can and cannot do up front.
3. Four build routes: new deck from docs / distill reusable brand templates /
   fill an existing deck preserving design / add transitions-narration.

Cost: model usage only (large-context model + image model for slide imagery).
