# Skill-Authoring Conventions (2026-10-10, stolen from mattpocock/skills, ECC, karpathy-skills)

## Frontmatter spec (load-bearing fields)

---
name: my-skill            # lowercase-hyphens, MUST match the directory name
description: What it does. Use when <trigger phrases, verb-first>.  # inline or folded (>) scalar ONLY — never literal block (|): breaks flat-table renderers
---

- `description` is the routing field: write it as a **trigger spec** — verb + trigger phrases + domain terms. It is what the agent scans when deciding to load the skill.
- Optional: `tags`, `version`. Provenance tags get stripped on copies.

## Invocation axis: user-invoked vs model-invoked

- **User-invoked** skills orchestrate (dotphrases, /commands). Mark with `disable-model-invocation: true` so the model never reaches for them on its own.
- **Model-invoked** skills hold reusable discipline; the agent loads them when the task fits.
- One-way call rule: user-invoked may call model-invoked, **never user-invoked → user-invoked** (prevents cycles).

## SKILL.md is the index, not the encyclopedia

Keep the entry file short; delegate to sibling docs (`phases.md`, `references/`, `examples/`). If the SKILL.md is getting long, the detail belongs in a linked file.

## Mandatory sections (for substantive skills)

1. `## When to Activate` — bullet trigger scenarios (critical for auto-activation).
2. Core concepts with **copy-pasteable examples** (FAIL: vague prose without examples).
3. `## Anti-Patterns` — FAIL/PASS pairs. The reasoning travels with the rule so the agent generalizes instead of just obeying.
4. `## Related Skills` — footer linking complementary skills.

## Component decision table

| Component | Purpose | Activation |
|---|---|---|
| Skill | Knowledge repository | Context-based (automatic) |
| Agent | Task executor | Explicit delegation |
| Command | User action | User-invoked (/command) |
| Hook | Automation | Event-triggered |
| Rule | Always-on guidelines | Always active |

Skills are **passive knowledge** the agent references when relevant — not task executors. Behavioral guardrails that must shape *every* action belong in an always-on doc, not a skill.

## Safety patterns

- **Frontmatter gates** for powerful orchestration skills (`disable-model-invocation`).
- **Machine-enforced blocks over prose pleas**: where a guardrail must hold, the skill's job is to *install the enforcement* (hook/script), not to beg the model in prose.
- **Gated phases** inside long skills: the loop refuses the next phase until the current one's exit condition is met.
- **Checklist gates**: end substantive skills with a verifiable checklist; every item checkable, no vibes.

## Goal-driven execution

Don't tell the agent what to do — give it **success criteria** and let it loop: "Write a test that reproduces it, then make it pass." LLMs are exceptionally good at looping until they meet specific goals.

## Width rule

One domain per skill, not too broad: `react-hook-patterns` yes, `react` no. If the description needs "and" twice, split it.
