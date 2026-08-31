# CLAUDE.md

## What this file is

This is the workflow guide for working in this repo. It tells you **when** to do something, not **how** — all the technical stuff (stack, folder layout, commands, constraints) lives in `memory-bank/` instead.

I (the human) drive the workflow. Nothing here runs automatically — each situation below just tells you what's expected once I ask for it. If you think a step is warranted and I haven't asked for it yet, just say so in a sentence and let me decide.

---

## 1. Before you start any task

`memory-bank/` is the only record of previous work — nothing about the project loads into context automatically.

- If the task touches something unfamiliar, or I ask "where do things stand," **read `memory-bank/` first**, including `memory-bank/history.md`.
- Don't answer from assumption — check the memory bank before asking me.

## 2. Deciding whether you need a plan

Not every task needs a plan file. Use this as the bar:

| Needs a plan | Doesn't need a plan |
|---|---|
| Touches more than one file | Single-file fix |
| Adds a dependency | Rename |
| Sets a new pattern | Config tweak |

**If it needs a plan:**
1. Write it to `plans/YYYY-MM-DD_short-name.md`.
2. Do this *right after I approve the plan, before writing any code* — plan mode itself can't write files, so this is a separate step.
3. Once the file exists, add a `planned` line for it in `memory-bank/history.md`.

## 3. Implementing a plan

`plans/` contain specs and implementation details.

- Follow the plan as written.
- If the work turns out to need something the plan didn't cover, **stop and tell me** — don't quietly re-plan mid-implementation.

## 4. After something lands

Once work is done or a decision is made, `memory-bank/` is out of date and needs updating:

- **Verified facts** (things you confirmed are true) → write directly.
- **Judgment calls** (things you're inferring or recommending) → propose to me first, don't write unilaterally.
- When an implementation finishes, add or update its line in `memory-bank/history.md` to `implemented`.

## 5. Writing a learning guide (drills)

`drills/` is where you teach me — the what, why, how, when, and where of the tech involved. Use it any time there's something teachable in the work.

- Keep it digestible — don't bloat it.
- Be honest: if part of the implementation is a shortcut or not best practice, say so and explain what "good" would look like. I don't want to accidentally learn bad habits.
- **One guide per plan.** If a plan would otherwise spawn multiple guides, merge them into one.
- Every guide must include these three sections:
  - `Is this production ready?`
  - `Honest gaps`
  - `What I'd do differently at 10x`
- I'm a visual learner, so every guide needs **at least one diagram/visualization** — put it in the `If you read nothing else` section, or wherever it fits best.
- Always list commands you've used to come up with a number along with the results.
- Don't just give me results, teach me how to get them too.
- ELI5

---

## Where things live (don't mix these up)

- **`memory-bank/`** — current state, architecture, technical context. The single source of truth for project facts. Don't duplicate these facts anywhere else (not in this file, not in a harness-level memory directory) — a fact stored twice will drift, and this is the only copy that lives in the repo.
- **`plans/`** — one dated file per feature/task, describing intent.
- These two are linked **by filename**, not by copying content between them.
- The `memory-bank` skill explains exactly what belongs in each memory-bank file and how to run an update pass.
- Project history specifically is in `memory-bank/history.md`.

---

## Hard rules

**Process**
- Run `pnpm format` and `pnpm lint` before marking any task done.
- No `Co-Authored-By` lines in commits or PR titles/descriptions. No watermarks, period.

**Code style**
- Default to the simplest construction: if something can be a plain script, plain function, or plain file, make it that.
- Scripts are `.mjs` (plain Node ESM), e.g. `apps/backend/db/seed.mjs` — not shell scripts. Shell is only for one-liners inside `package.json`.
- Comments must earn their place. Most code doesn't need one; when it does, keep it under 150 characters (spaces included). No essay-length comments.
  - Exception: you can point to a `plans/` file in a comment to explain *why* something is built the way it is, so a future pass doesn't "fix" it by mistake.
- Never reference a `drills/` file from code or config — drills are for humans reading docs, not for the codebase.
- Never create a new helper, utility, service layer, or component if an existing one can absorb the logic.
- Prefer adding clean conditional paths or extending existing parameters inside established files rather than creating new wrapper classes.
- Do not install new packages or write custom wrappers without searching the project tree for pre-existing internal solutions.
- Follow professional project standards: use conventional commit messages, enforce type hints, and ensure credentials remain strictly in `.env`.
- Commit chunks of work as you go to prevent context drift, isolate AI bugs, and create clean rollback points.
  - Only applies to any branch other than the `main`.
- When cutting a release: bump the version in `package.json`, tag the commit in Git (`drill/xx` format), push tags to remote, create a GitHub Release (`gh release create drill/xx --generate-notes`), link resolved issues, create a GitHub Milestone (if needed), and record the milestone in the Memory Bank.
- Use clear subject/verb/object constructions. Do not use cleft sentences, contrastive appositives, appended-glosses, or trailing clauses.
- Assume I may edit documents myself. Especially markdown documents.
- When writing markdown documents, don't include references to conversations or threads a reader would not know about.
- Short sentences. RFC 2119 keywords for obligations. Commit = imperative subject; body only for a fact the diff cannot show. Comments only where code needs clarification — never narration.
- Write-ups go into the `drills/`, not the `plans/`.
- Clean up any Docker containers, images, and volumes you create, but never touch anything created by the default `docker-compose` setup.