# Progress

Where things stand and what's next. **Not a changelog** — every drill's decisions, numbers and
dead ends are one row each in `history.md`, and this file is only what a session needs *now*.

## Current focus

Nothing in flight. Drill 06 landed on 2026-08-13 (both phases: correlation + structured JSON logs,
then the OpenTelemetry stretch), and the tree is clean at that commit.

The thing to carry forward is that the stack is now **instrumented but off by default** — pino at
`info`, `LOG_LEVEL` per service, tracing dark unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set. That was
deliberate so drill 05's baseline stays the instrument cards 08/09/10 are compared against. Turning
either up is a per-measurement decision, not a default to drift into.

## Next step

**Card 07**, next in order.

When the optimisation cards arrive, drill 05 already decided their order against expectation:

- **Card 09 (the composite index) is where the whale's 176ms lives.** The missing
  `(org_id, updated_at DESC, id DESC)` is the 102ms list query.
- **Card 08 (`count(*)`, keyset paging) is real but smaller** at page 1 — `count(*)` is a 33ms
  index-only scan once vacuumed, which refuted drill 03's prediction #2.

One measurement is still open and drill 06 just made it cheap: **the pool under load.** Drill 06
proved `Promise.all` takes two connections per request (two backend PIDs), and phase 2 put a number
on one request's pool wait (5.48ms of a 7.90ms query, in `pg-pool.connect`). What nothing does yet
is sample that *during* a k6 run — either `PostgresService.stats()` on a timer, or reading the
`pg-pool.connect` spans across a traced run.

## Active plan

None open — every plan file in `plans/` is shipped. `history.md` lists them with results.

## What works

`pnpm docker:up`, then `pnpm db:migrate` and `pnpm db:seed` — or `pnpm db:reset` for both.
`pnpm db:test` runs the e2e suite inside the container (27 tests, 4 suites). Baseline numbers and
query plans for drill 03 are recorded in its plan file — that is the `before` column cards 08/09/10
get compared against, and drill 04's plan records what those same queries do at 2.5M rows.

`pnpm logs:trace <id>` reconstructs one request across all services. `pnpm trace:on` adds spans,
a collector and Jaeger on `:16686`; `pnpm trace:off` puts it back.

## Known issues

1. Frontend has no test runner.
2. Backend: `HealthService`, `InfoController` and `RedisService` have no tests of their own — the
   e2e suites reach `/health` over HTTP but never exercise the failure branches. `PostgresService`
   is the exception: `schema.e2e-spec.ts` drives it directly, which is how a DI change to it got
   caught in drill 06.
3. `AppController`/`AppService` are still `nest new` scaffolding returning `'Hello World!'`, kept
   only because `test/app.e2e-spec.ts` asserts on them.
4. **Logging is now a cost to watch, not an absence.** `LOG_LEVEL=debug` in anything resembling
   production would be expensive, and `url` is logged with its query string in full — safe for
   today's parameters and not for a token or an email.
5. `main.ts` has a standing `@typescript-eslint/no-floating-promises` warning on `bootstrap();`.
   Pre-dates drill 06, left alone rather than widening a drill's scope.

## Preferences

- Structure is added when there is content for it, not in anticipation.
- Memory bank updates are made _with_ the user: verified facts written directly, judgments proposed
  first.
- Keep these files short. Bloat is what stops them being read.

## Evolution of decisions

- **Measure, then decide — and record the number, including when it refutes the plan.** Drill 04
  deleted six hand-optimised hot paths worth 9.7s of CPU because they bought ~0s of wall clock;
  drill 05 refuted drill 03's prediction #2; drill 06 found its own logging bug by benchmarking and
  killed its own "one id for logs and traces" design by reading the output. A claim without a
  number does not go in these files.
- **New instrumentation ships off by default.** Postgres statement logging, `LOG_LEVEL`, and
  OpenTelemetry are all runtime toggles rather than always-on, because an always-on instrument
  silently changes the baseline that every later "before/after" depends on. Same reasoning as
  pinning `grafana/k6:2.1.0`.
- **Naive-on-purpose is a recorded decision, not debt.** `GET /conversations` has no composite
  index, no cursor and no caching so cards 08/09/10 have something real to break. Read the plan
  file before "improving" anything here.
