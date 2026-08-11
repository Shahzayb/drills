# Progress

Where things stand and what's next.

## Current focus

Drill 03 — `GET /conversations` and the RSC list page. Shipped: 20 e2e tests pass against
the containerised database, and the page renders 50 rows into HTML with no JavaScript.

## Next step

TBD

## Active plan

`plans/2026-08-09_drill-03-conversation-list.md` (shipped)

## What works

`pnpm docker:up`, then `pnpm db:migrate` and `pnpm db:seed`. `pnpm db:test` runs the e2e
suite inside the container. Baseline numbers and query plans for drill 03 are recorded in
its plan file — that is the `before` column cards 08/09/10 get compared against.

## Known issues

1. Frontend has no test runner.
2. Backend doesn't log any endpoint locally. Must be disabled in production.
3. Backend: health, info, postgres, and redis doesnt have any tests
4. `AppController`/`AppService` are still `nest new` scaffolding returning `'Hello World!'`,
   kept only because `test/app.e2e-spec.ts` asserts on them.

## Preferences

- Structure is added when there is content for it, not in anticipation.
- Memory bank updates are made _with_ the user: verified facts written directly, judgments proposed first.
- Keep these files short. Bloat is what stops them being read.

## Evolution of decisions
