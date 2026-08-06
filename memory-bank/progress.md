# Progress

Where things stand and what's next.

## Current focus

Repo scaffolding only. No drill work has started. `projectbrief.md` states the scope; the drill program itself (the card list) is not yet in the repo.

## Next step

Drill 01 — get Postgres, Redis, the API and the web app up under one command.

## Active plan

`plans/2026-08-06_drill-01-health-endpoint.md` — shipped. `plans/2026-08-06_workflow-hardening.md` shipped and was then partly reverted.

## What works

One command brings up Postgres, Redis, the API and the web app. `GET localhost:3002/health` returns 200 with both dependencies up; stopping either returns 503 naming the one that's down, and the backend recovers on its own when it comes back (verified both directions). `pnpm dev` still runs both apps via Turborepo. Frontend is the untouched `create-next-app` scaffold.

## Known issues

Frontend has no test runner.

## Preferences

- Structure is added when there is content for it, not in anticipation.
- Memory bank updates are made _with_ the user: verified facts written directly, judgments proposed first.
- Keep these files short. Bloat is what stops them being read.

## Evolution of decisions
