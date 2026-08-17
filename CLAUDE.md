# CLAUDE.md

How to work in this repository. Only the workflow lives here — everything technical (stack, layout, commands, constraints) lives in `memory-bank/`.

I drive the workflow. Nothing below runs on its own; each line says what a situation calls for, so that when I ask for it you already know the shape. If a step looks warranted and I haven't asked, say so in a sentence and let me decide.

## What calls for what

**Starting on something unfamiliar, or asking where things stand** → `memory-bank/` is the only link to previous work; nothing loads automatically. Read it — including `history.md` — before answering from assumption.

**Work spanning more than one file, adding a dependency, or setting a pattern** → that's the bar for a plan file at `plans/YYYY-MM-DD_short-name.md`. Plan mode can't write files, so the file gets written right after approval, before any code. A single-file fix, a rename, a config tweak is below the bar. As soon as the plan file exists, append a `planned` line for it to `memory-bank/history.md`.

**Implementing against an existing plan** → follow it. If the work needs something the plan doesn't cover, stop and say so rather than quietly re-planning mid-implementation.

**Something landed, or a decision got made** → `memory-bank/` is now stale. Verified facts can be written directly; anything that's a judgment gets proposed to me first. When an implementation finishes, append (or update) its line in `memory-bank/history.md` to `implemented`.

**Teachable Things** → `drills` is a guide where you'd teach me about the tech and the what/why/how/when/where of the stuff. Don't bloat and make it digestible. Also be honest about what's bad implementation and how can it be good just so I won't learn bad practices.

## Boundaries

`memory-bank/` holds current state, architecture, and technical context. `plans/` holds per-feature intent, one dated file each. They are maintained separately — link between them by filename rather than copying.

`memory-bank/` is the only project memory store here. Don't file project facts in a harness-level memory directory, in this file, or anywhere else — a fact kept in two places drifts, and only `memory-bank/` is in the repo.

The `memory-bank` skill covers what belongs in each file and how an update pass runs.

Learn about the project history from the `memory-bank/history.md` file.

## Rules

- Code comments are only for short, to-the-point descriptions, not an essay. But you can reference to the `plans/` to justify the current implementation just so future iterations won't 'fix' or 'improve' it.
- Never include Co-Authored-By line in the commit or PR title/description. Don't use any watermark.
- Prefer the simpler construction. If a thing can be a plain script, a plain function or a plain file, it is that.
- Scripts are `.mjs` (plain Node ESM, like `apps/backend/db/seed.mjs`), not shell. Shell is for one-liners in `package.json`.
- Run `pnpm format` before calling a task done.
- Always generate 1 learning guide (`drills/`) per plan. If there are many guides per drill, merge them.
- Never reference to files from the `drills/` in the code/config or anywhere.
- In every `drills/` there must be a section called `Is this production ready?`, `Honest gaps`, and `What I'd do differently at 10x`.
- Don't pollute the codebase with comments. That's what the guides (`drills/`) are for, explain it there. Comments have to earn their place. Most of the times, you don't need commends and even if you do, keep it 150 characters (including space) max.
- Always include the visualization of the whole drill inside the `If you read nothing else` section of guides (`drills/`)
