# CLAUDE.md

How to work in this repository. Only the workflow lives here — everything technical (stack, layout, commands, constraints) lives in `memory-bank/`, so this file stays stable and needs no upkeep.

## Workflow

1. **Session start** — a `SessionStart` hook loads `memory-bank/activeContext.md`.
2. **Plan first** — work that spans more than one file, adds a dependency, or sets a pattern starts with a plan file at `plans/YYYY-MM-DD_short-name.md`. Draft it in plan mode. Plan mode cannot write files, so **writing that file is the first action after approval**, before any code. Below the bar — a single-file fix, a rename, a config tweak — go straight to work. If a plan is warranted and there isn't one, say so and offer to draft one rather than starting.
3. **Link** — once refined, the plan is referenced from `memory-bank/activeContext.md`.
4. **Implement** — follow the plan.
5. **Record** — update `memory-bank/` with the user, not from assumptions. A `Stop` hook nudges when a session changed source but not `memory-bank/`; it is advisory, so running the step is still yours.

`memory-bank/` holds current state, architecture, and technical context; `plans/` holds per-feature intent. They are maintained separately.

`memory-bank/` is the only project memory store for this repo. Don't file project facts in a harness-level memory directory, in this file, or anywhere else — a fact kept in two places drifts, and only `memory-bank/` is in the repo where it can be reviewed and shared.

Before assuming anything about the stack, layout, commands, or known gotchas, read `memory-bank/systemPatterns.md` and `memory-bank/techContext.md`. The `memory-bank` skill covers which files to read for which task, what belongs in them, and how the update pass works.
