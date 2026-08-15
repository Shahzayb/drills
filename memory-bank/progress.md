# Progress

Where things stand and what's next. **Not a changelog** — every drill's decisions, numbers and
dead ends are one row each in `history.md`, and this file is only what a session needs *now*.

## Current focus

Nothing in flight. Drill 07 landed on 2026-08-15 (RLS tenant isolation, including the stretch).

Two things to carry forward.

**The API no longer connects as the database owner.** `POSTGRES_APP_USER`/`POSTGRES_APP_PASSWORD`
are required and `PostgresService` throws without them — no fallback, because falling back to the
superuser would leave every policy in place enforcing nothing with every test still passing.
`POSTGRES_USER` is now only for migrations and the seed, which is also what lets them bypass RLS.

**A write to any table carrying `org_id` must declare its tenant.** `TenantDb.withOrg()` is the
only way, including in test fixtures — the older suites were changed for this, and that is the
mechanism working rather than scaffolding. `pnpm check:tenancy` fails when a new table forgets.

The stack also remains **instrumented but off by default** — pino at `info`, `LOG_LEVEL` per
service, tracing dark unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set — so drill 05's baseline stays
the instrument cards 08/09/10 are compared against.

## Next step

**Card 08**, next in order. Drill 07 leaves it one gift and one warning:

- **Gift:** `list()` now runs both its queries in one transaction on one connection, so removing
  `count(*)` also removes the serialisation drill 07 measured. Card 08's win may be larger than
  drill 05 predicted.
- **Warning:** the `before` arm of any A/B must not be a git checkout. Drill 07 had to discard
  that arm entirely — 33% spread, because it was the only arm whose process restarted. Arms must
  differ only in the variable.

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
`pnpm db:test` runs the e2e suite inside the container (45 tests, 5 suites). Baseline numbers and
query plans for drill 03 are recorded in its plan file — that is the `before` column cards 08/09/10
get compared against, and drill 04's plan records what those same queries do at 2.5M rows.

`pnpm logs:trace <id>` reconstructs one request across all services. `pnpm trace:on` adds spans,
a collector and Jaeger on `:16686`; `pnpm trace:off` puts it back.

`pnpm check:tenancy` audits RLS coverage and the serving role's attributes, read-only — it is also
the "check rather than assume" command, which is why there is no separate `rls:status`.

## Known issues

1. Frontend has no test runner.
2. Backend: `HealthService`, `InfoController` and `RedisService` have no tests of their own — the
   e2e suites reach `/health` over HTTP but never exercise the failure branches. `PostgresService`
   is the exception: `schema.e2e-spec.ts` drives it directly, which is how a DI change to it got
   caught in drill 06.
3. `AppController`/`AppService` are still `nest new` scaffolding returning `'Hello World!'`, kept
   only because `test/app.e2e-spec.ts` asserts on them.
4. **`organizations` and `users` have no RLS policy**, and that is a recorded decision, not a gap
   to close casually: `organizations` is the tenant registry rather than tenant-owned data, and
   `users` genuinely has no `org_id` because a person can belong to several orgs. Both are real
   leak surfaces the mechanism does not cover.
5. **Anything running as `POSTGRES_USER` is outside tenant isolation** — migrations, the seed, and
   any ad-hoc psql. That is deliberate (they must write across tenants) and is the price of not
   setting `FORCE ROW LEVEL SECURITY`.
6. **Logging is now a cost to watch, not an absence.** `LOG_LEVEL=debug` in anything resembling
   production would be expensive, and `url` is logged with its query string in full — safe for
   today's parameters and not for a token or an email.
7. `main.ts` has a standing `@typescript-eslint/no-floating-promises` warning on `bootstrap();`.
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
- **A control belongs below the code that must not forget it.** Drill 07 measured the rejected
  repository layer as *free* and chose the 23.5%-slower row-level security anyway, because only
  the database-side mechanism protects code that never went through the seam. Speed lost to one
  test case. The corollary is also recorded: on a 185ms endpoint the cost was unmeasurable, so
  this is a decision per endpoint shape, not one global answer.
- **Naive-on-purpose is a recorded decision, not debt.** `GET /conversations` has no composite
  index, no cursor and no caching so cards 08/09/10 have something real to break. Read the plan
  file before "improving" anything here.
