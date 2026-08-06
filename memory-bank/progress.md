# Progress

Where things stand and what's next.

## Current focus

Repo scaffolding only. No drill work has started. `projectbrief.md` states the scope; the drill program itself (the card list) is not yet in the repo.

## Next step

Drill 01 — get Postgres, Redis, the API and the web app up under one command.

## Active plan

None. `plans/2026-08-06_workflow-hardening.md` shipped and was then partly reverted.

## What works

`pnpm dev` runs both apps via Turborepo. Backend is the NestJS starter with its default tests, plus a port change and an added `dev` alias; frontend is the untouched `create-next-app` scaffold.

## Known issues

Frontend has no test runner.

## Preferences

- Structure is added when there is content for it, not in anticipation.
- Memory bank updates are made *with* the user: verified facts written directly, judgments proposed first.
- Keep these files short. Bloat is what stops them being read.

## Evolution of decisions

**The memory bank started over-built and was cut back repeatedly.** The first version had seven files and four enforcement hooks (SessionStart injection, Stop nudge, PreCompact steer, PostToolUse line cap) for a repo with two untouched scaffolds and no stated goal. All worked; all were removed, because structure invented ahead of content rots unread — the implementations are in commit `0db9797` if wanted back. The remaining files were then cut for length, and `activeContext.md` folded into this one: long files and scattered files both fail the same way, by not being read.

**Three files now**, from the Cline structure, with `productContext` folded into `projectbrief.md`, `systemPatterns` into `techContext.md`, and `decisions.md` dropped as premature — decisions live in `techContext.md` when they shape the system and here when they shape the project's direction. Reintroduce a separate file only when this section outgrows itself.

**The workflow is driven manually.** `CLAUDE.md` states what situation calls for which step rather than mandating a sequence, and the hooks that once enforced the record step are gone. Nothing triggers a memory bank update automatically; that gap is accepted, not overlooked.
