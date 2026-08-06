---
name: memory-bank
description: Persistent project memory (memory-bank/) and the plan-first workflow (plans/) for this repo. Use at the start of any non-trivial task here, before writing a plan file, and before implementing anything — work spanning more than one file, adding a dependency, or setting a pattern gets a plan file before any code, so consult this skill on such a request to build, add, change, or fix, not just when planning is mentioned. Also use when the user says "update memory bank", asks where things stand or what the current focus is, asks why something was built the way it was, or after finishing an implementation.
---

# Memory Bank

Context does not survive between sessions. `memory-bank/` is the only thing that carries forward, so a future session's judgment is only as good as what is written there.

`CLAUDE.md` holds the five-step workflow and nothing else — this file is the mechanics behind steps 2, 3, and 5. Because the technical reference lives here rather than there, discipline matters more, not less: every line is re-read on future tasks. Record what a session needs to start working and the reasoning it can't recover, not a transcription of what the code already shows.

## Files

| File | Holds | Cap |
|---|---|---|
| `activeContext.md` | Active plan, current focus, next steps, unfilled files, open questions | 20 lines |
| `progress.md` | What works, what's left, known issues | 30 lines |
| `projectbrief.md` | Scope, goals, non-goals. Source of truth when files disagree | 20 lines |
| `productContext.md` | Why this exists, who it's for, UX intent | 20 lines |
| `systemPatterns.md` | Repo layout, architecture as it stands, component relationships | — |
| `techContext.md` | Commands, constraints, gotchas, version pins, tooling config | — |
| `decisions.md` | Append-only decision log: what was decided, why, what was rejected | — |

The caps sit on the files that churn: a stale line there misroutes the next session, so they have to stay small enough that pruning is obvious. A `PostToolUse` hook reports the overflow when a capped file goes over — treat that as the signal to cut what has stopped being load-bearing, not to raise the cap. The bottom three are reference material that grows with the project — they're governed by the "what earns a line" rules below rather than a length limit. When one section of `systemPatterns.md` or `techContext.md` outgrows a screen, split it into its own file under `memory-bank/` and link it from `activeContext.md`.

`systemPatterns.md` and `decisions.md` divide along *is* versus *why*: the current shape of the system versus the reasoning that produced it. Keeping the log out of `systemPatterns.md` matters because that file is read on most implementation work, and an append-only history would make every one of those reads more expensive as the project ages.

## Reading: load by need

`activeContext.md` arrives through the `SessionStart` hook. If it isn't in context, read it first — everything else follows from it.

| Task | Also read |
|---|---|
| Writing or refining a plan | `projectbrief.md`, `systemPatterns.md` |
| Implementing | the active plan file, `systemPatterns.md` |
| Resuming, "where were we" | `progress.md` |
| Architecture or design choice | `systemPatterns.md`, `projectbrief.md`, grep `decisions.md` |
| "why is it done this way" | grep `decisions.md` |
| Stack or layout question | `systemPatterns.md` |
| Commands, build, deps, tooling | `techContext.md` |
| Product or UX question | `productContext.md` |
| "update memory bank" | the six revisable files (not `decisions.md`) |

Two things keep this cheap. Skip any file listed under **Unfilled** in `activeContext.md` — it's still all placeholders, and reading it buys nothing. And to check a single fact, `grep -r "<term>" memory-bank/` instead of reading files whole.

## Plans

`plans/` and `memory-bank/` are separate stores and stay that way. Plans accumulate, one per feature, each a dated record of intent. The memory bank is a small working set rewritten in place.

Plan mode cannot write files. A plan is therefore *drafted* in plan mode and *written* immediately after approval — `plans/YYYY-MM-DD_short-name.md` is the first thing created after exiting plan mode, before any implementation. Skipping that write is the likeliest way this whole directory stays empty while work ships: the plan was approved, so it feels recorded, and nothing on disk says otherwise.

Every plan carries a status line directly under its title — `planned`, `in progress`, `shipped`, or `abandoned — <reason>`. That line is the only part of a plan edited after writing, and it's what keeps `plans/` readable a year on (`grep -l '^\*\*Status:\*\* shipped' plans/*.md` — anchored, so the template line in `plans/README.md` doesn't match). Set it to `in progress` when implementation starts, and to its final value in the same pass that updates the memory bank.

- Don't rewrite a plan's body afterwards to match what shipped — the gap between planned and actual is the useful signal. Record divergence in the memory bank.
- Don't copy plan contents into the memory bank. Two copies drift and the reader can't tell which is current; link by filename.
- Don't load `plans/` wholesale. Read the one named in `activeContext.md`; for an older one, `ls plans/` and read just that file.
- If the work needs something the plan doesn't cover, say so and get direction rather than quietly re-planning mid-implementation.

**Asked to implement with no plan file:** first decide whether one is warranted — the bar is in `CLAUDE.md` step 2: more than one file, a new dependency, or a pattern being set. Below that bar (a single-file fix, a rename, a config tweak) just do the work; a planning stop on trivial changes only teaches everyone to skip plans. At or above it, say so and offer to draft one rather than coding. If the user decides to skip the plan anyway, that's their call; proceed, and note it in `activeContext.md` so the next session knows why there's no plan to point at.

## Writing: what earns a line

Record what a future session cannot cheaply reconstruct:

- Decisions **and their reasoning**, including alternatives rejected — `git log` shows what changed, never why
- Constraints found the hard way: version pins, gotchas, things that broke and the fix
- Current focus, the active plan, and the next concrete step
- Scope and, especially, non-goals

Leave out:

- File listings, function signatures, API surface — reading the code is cheaper than trusting a stale summary
- Changelogs and session narration — `git log` is the changelog
- Anything unverified. Write `_Not yet established._` and move on. A confidently wrong memory bank is worse than an empty one, because the next session acts on it without checking.

Keep one fact in one file and cross-reference by filename. Replace stale lines rather than appending — when a capped file pushes past its limit, that's the signal to cut what has stopped being load-bearing.

`decisions.md` is the deliberate exception, and the only file that grows without pruning. Log an entry whenever a choice would be expensive to rediscover — architecture, a dependency, a convention, a tradeoff accepted under pressure — using this shape, newest at the top:

```
## YYYY-MM-DD — <what was decided>

**Why:** <reasoning, including what was rejected and why it lost>
**Plan:** <plans/YYYY-MM-DD_name.md, if one produced it>
```

Never edit or delete an entry. When a decision stops holding, append the new one and add `**Superseded by:** <date — title>` to the old — the outdated reasoning is what keeps the question from being reopened later. Routine choices with an obvious default don't need an entry; the log is only useful if reading it is still cheap in a year.

## Recording: with the user, not for them

This is the one protocol for changing anything under `memory-bank/`, whether you've just finished implementing or the user typed "update memory bank". Split it by what you can stand behind:

- **Write directly** what you verified yourself — a test that now passes, a line that is now factually false, a constraint you actually hit. Write it, then say you did.
- **Propose first** for everything else — whether the work counts as done, what the next focus is, why a tradeoff was accepted, what's worth doing next. Show the exact lines and let the user correct them before anything lands.

Inference is how memory banks rot: an invented "next step" that nobody agreed to becomes next session's starting assumption, and by then it reads as established fact. Ask short, specific questions — "is the error path in scope, or a follow-up?" — rather than open-ended ones.

Update `progress.md`, `activeContext.md`, and the plan's status line in the same pass, so the active plan link never outlives the work it points at.

On an explicit **"update memory bank"**, do all of the above and additionally read the six revisable files and sweep for staleness. `activeContext.md` and `progress.md` decay fastest, so start there. Report one line per file, including "no change" for the ones you left alone — silence reads as an oversight.

`decisions.md` is not part of that sweep: an append-only log can't hold stale lines, only superseded ones. Read it during the pass only to check whether this session's work superseded an entry, and append if it did.
