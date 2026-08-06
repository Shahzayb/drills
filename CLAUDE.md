# CLAUDE.md

How to work in this repository. Only the workflow lives here — everything technical (stack, layout, commands, constraints) lives in `memory-bank/`.

I drive the workflow. Nothing below runs on its own; each line says what a situation calls for, so that when I ask for it you already know the shape. If a step looks warranted and I haven't asked, say so in a sentence and let me decide.

## What calls for what

**Starting on something unfamiliar, or asking where things stand** → `memory-bank/` is the only link to previous work; nothing loads automatically. Read it before answering from assumption.

**Work spanning more than one file, adding a dependency, or setting a pattern** → that's the bar for a plan file at `plans/YYYY-MM-DD_short-name.md`. Plan mode can't write files, so the file gets written right after approval, before any code. A single-file fix, a rename, a config tweak is below the bar.

**Implementing against an existing plan** → follow it. If the work needs something the plan doesn't cover, stop and say so rather than quietly re-planning mid-implementation.

**Something landed, or a decision got made** → `memory-bank/` is now stale. Verified facts can be written directly; anything that's a judgment gets proposed to me first.

## Boundaries

`memory-bank/` holds current state, architecture, and technical context. `plans/` holds per-feature intent, one dated file each. They are maintained separately — link between them by filename rather than copying.

`memory-bank/` is the only project memory store here. Don't file project facts in a harness-level memory directory, in this file, or anywhere else — a fact kept in two places drifts, and only `memory-bank/` is in the repo.

The `memory-bank` skill covers what belongs in each file and how an update pass runs.
