# Progress

Where things stand and what's next.

## Current focus

Drill 02 — schema and migrations. Shipped and verified against a freshly wiped volume.

## Next step

TBD

## Active plan

`plans/2026-08-07_drill-02-schema-and-migrations.md` (shipped)

## What works

`pnpm docker:up`, then `pnpm db:migrate` and `pnpm db:seed`.

## Known issues

- Frontend has no test runner.
- Backend doesn't log any endpoint locally. Must be disabled in production.
- Backend: health, info, postgres, and redis doesnt have any tests

## Preferences

- Structure is added when there is content for it, not in anticipation.
- Memory bank updates are made _with_ the user: verified facts written directly, judgments proposed first.
- Keep these files short. Bloat is what stops them being read.

## Evolution of decisions
