# Progress

Where things stand and what's next.

## Current focus

Drill 01 shipped, verified against the drill card, and written up at `drills/01-four-containers.md`. Cold start from a clean clone: 112s (build 88s, up 20s, first page 4s) — `pnpm install` alone is 65% of it, because `node_modules` is deliberately excluded from the build context. Next step is the user's call.

## Next step

_Not yet established._ Card 12 (load testing) is referenced by the pool-sizing reasoning in `drills/01-four-containers.md` as the place the `max: 10` guess should get tested.

## Active plan

`plans/2026-08-06_drill-01-health-endpoint.md` — shipped. `plans/2026-08-06_workflow-hardening.md` shipped and was then partly reverted.

## What works

One command brings up Postgres, Redis, the API and the web app, all four with health checks. `localhost:3001` renders a value the API read from Postgres, fetched by Compose service name. `GET localhost:3002/health` returns 200 with both dependencies up; killing either returns 503 naming it, marks the container unhealthy in ~7s, and recovers unattended (verified both directions). `docker compose down && up` preserves data in both stores — verified by round-tripping a row and a key. `pnpm dev` still runs both apps via Turborepo.

## Known issues

Frontend has no test runner.

## Preferences

- Structure is added when there is content for it, not in anticipation.
- Memory bank updates are made _with_ the user: verified facts written directly, judgments proposed first.
- Keep these files short. Bloat is what stops them being read.

## Evolution of decisions
