---
name: memory-bank
description: The Memory Bank (memory-bank/) — what each file holds, what earns a line in one, and how an update pass runs. Use at the start of any non-trivial task in this repo, when the user says "update memory bank", when they ask where things stand or what the current focus is, when they ask why something was built the way it was, and after finishing an implementation.
---

# Memory Bank

My memory resets completely between sessions. After each reset the Memory Bank is my only link to previous work, so I read **all** of it at the start of a task, before anything else. Nothing loads automatically — reading is a deliberate first step.

Its value is entirely in being accurate and being read. A file too long to read is as useless as one that's wrong.

## The files

All Markdown, all directly under `memory-bank/`.

1. **`projectbrief.md`** — core requirements, goals, non-goals, why the project exists. Source of truth for scope; when the files disagree, this one wins.
2. **`techContext.md`** — architecture, how the pieces relate, technologies, how to run and test things, technical constraints, decisions that shape the system.
3. **`progress.md`** — where things stand: current focus, the next concrete step, the active plan, what works, known issues, standing preferences, and how the project's direction has evolved.
4. **`history.md`** — every plan and implementation, one row each, oldest first: date, path to the plan file, a description, and status (`planned` / `implemented`). Read at the start of a session alongside the other three. It is append-only and the one deliberate exception to "no changelogs" below — it exists precisely to be the changelog the other files must not become.

   The description is one *row*, not one sentence — write it as long as it needs to be to carry the decision or result, not just the topic. "Wired backend to Postgres and Redis" is the topic; "no ORM, no Terminus (its indicators need TypeORM/Sequelize/Mongoose); `lazyConnect`+`enableOfflineQueue` can't combine on ioredis" is what a later session actually needs and would otherwise have to re-read the whole plan to recover. Favor the numbers, the rejected alternative, and the deliberate gap over the plain summary — those are exactly what's cheap to drop and expensive to reconstruct.

Add another file only when there is content that doesn't fit these four and is too big to inline. Four is deliberately the smallest set that works; it grows from pressure, not from planning.

## What earns a line

Record what a future session cannot cheaply reconstruct:

- **Decisions and their reasoning**, including alternatives rejected. What changed is recoverable; why it changed is not. Decisions shaping the system go in `techContext.md`, decisions shaping the project's direction under `progress.md`'s evolution section.
- **Current focus, the active plan, and the next concrete step** — all in `progress.md`, at the top where they're read first.
- **Dead ends.** An attempt that failed with no decision attached is exactly what gets re-attempted next session. Say what happened and whether it's worth retrying.
- **Constraints found the hard way** — version pins, gotchas, things that broke and the fix.
- **Scope, and especially non-goals.**

Leave out:

- File listings and function signatures. Reading the code is cheaper than trusting a stale summary. Where a contract genuinely can't be reconstructed cheaply, record *where it lives* rather than a copy of it.
- Secret values. Record which vars are required and where the real values come from, never the value.
- Facts that already load themselves into context elsewhere. Point at them instead.
- Changelogs and session narration. This is a working set, not a history — that's what `history.md` is for, and only for.
- Anything unverified. Write `_Not yet established._` and move on — a confidently wrong memory bank is worse than an empty one, because the next session acts on it without checking.

Keep one fact in one file and cross-reference by filename. Replace stale lines rather than appending. Plans are a separate store: link to one by filename, never copy its contents in.

## Updating

Update after implementing something significant, on discovering a pattern worth keeping, and whenever the user asks.

**Write directly** what you verified yourself — a test that now passes, a line that is now factually false, a constraint you actually hit. Write it, then say you did.

**Propose first** for everything else — whether the work counts as done, what the next focus is, why a tradeoff was accepted. Show the exact lines and let the user correct them. Keep the batch small; two lines the user actually reads beat six they wave through.

Inference is how a memory bank rots. An invented "next step" nobody agreed to becomes next session's starting assumption, and by then it reads as established fact.

On an explicit **update memory bank**, review every file even where none is needed, and report one line per file including "no change" — silence reads as an oversight. `progress.md` decays fastest, so start there.

`history.md` runs on its own trigger, independent of the rest of an update pass: append a `planned` line the moment a plan file is written (see `CLAUDE.md`'s plan-file step), and append or update that line to `implemented` the moment its implementation lands. Both are verified facts — the file existing, the work being done — so both are written directly, no proposal needed. Newest entry last, one line each; never rewrite history, only append.
