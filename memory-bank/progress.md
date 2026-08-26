# Progress

Where things stand and what's next. **Not a changelog** — every drill's decisions, numbers and
dead ends are one row each in `history.md`; this file is only what a session needs *now*.

## Current focus

None. Drill 09 shipped — `plans/2026-08-25_drill-09-index-selectivity.md`.

## Next step

Drill 10 — caching. `cacheComponents` is off on purpose and Next 16 does not cache `fetch` by
default, both so this card has something real to turn on. Card text not yet written into this file.

## Active plan

None open — every plan file in `plans/` is shipped. `history.md` lists them with results.

## What works

`pnpm docker:up`, then `pnpm db:migrate` and `pnpm db:seed` — or `pnpm db:reset` for both.
`pnpm db:test` runs the e2e suite inside the container; `pnpm db:test:naive` runs the same suite
with `LIST_STRATEGY=naive` and is *expected* to fail two assertions — that's the query-budget proof,
not a broken build. Baseline numbers and query plans for drill 03 are in its plan file — the
`before` column cards 09/10 are compared against; drill 04's plan records the same queries at 2.5M
rows.

`pnpm logs:trace <id>` reconstructs one request across all services. `pnpm trace:on` adds spans, a
collector and Jaeger on `:16686`; `pnpm trace:off` puts it back. `pnpm db:stats:on`/`db:stats`/
`db:stats:reset` drive `pg_stat_statements`, off by default behind
`PG_PRELOAD=pg_stat_statements docker compose up -d postgres_db` (postmaster-context, needs a
recreate — see known issue below for the trap in that).

`pnpm db:explain <plans|sweep|experiments|stats>` reads query plans for the list endpoint — three
captures, the selectivity sweep, and rejected indexes priced inside a rolled-back transaction.
`ORG_ID`/`STATUS`/`SORT`/`DAYS` parameterise it.

`pnpm check:tenancy` audits RLS coverage and the serving role's attributes, read-only — the "check
rather than assume" command, which is why there's no separate `rls:status`. Covers five tables:
`conversations`, `messages`, `memberships`, `tags`, `conversation_tags`.

## Known issues

1. Frontend has no test runner.
2. Backend: `HealthService`, `InfoController` and `RedisService` have no tests of their own — the
   e2e suites reach `/health` over HTTP but never exercise the failure branches. `PostgresService`
   is the exception: `schema.e2e-spec.ts` drives it directly.
3. **Nothing under backend `src/` has a unit test** — only e2e coverage. `pnpm test` passes
   trivially (`--passWithNoTests`); the last unit spec was deleted in drill 08 along with the
   scaffolded `AppController`/`AppService` it tested.
4. **`organizations` and `users` have no RLS policy**, and that's a recorded decision, not a gap to
   close casually: `organizations` is the tenant registry rather than tenant-owned data, and `users`
   genuinely has no `org_id` (a person can belong to several orgs). Both are real leak surfaces the
   mechanism doesn't cover.
5. **Logging is now a cost to watch, not an absence.** `LOG_LEVEL=debug` in anything resembling
   production would be expensive, and `url` is logged with its query string in full — safe for
   today's parameters, not for a token or an email.

## Releases

| Tag | Version | Milestone | Notes |
|---|---|---|---|
| [drill/09](https://github.com/Shahzayb/drills/releases/tag/drill/09) | 0.9.0 | `drill/09` (closed) | First release actually cut. Tags `drill/01` and `drill/02` exist locally, were never pushed, and have no release. |

## Preferences

- Structure is added when there is content for it, not in anticipation.
- Memory bank updates are made _with_ the user: verified facts written directly, judgments proposed
  first.
- Keep these files short. Bloat is what stops them being read.
