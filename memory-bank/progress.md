# Progress

Where things stand and what's next. **Not a changelog** — every drill's decisions, numbers and
dead ends are one row each in `history.md`, and this file is only what a session needs *now*.

## Current focus

Nothing in flight. Drill 08 landed on 2026-08-17 (N+1 detection: assignee name + tags on the list,
a per-request query counter with a budget, `pg_stat_statements` vs the statement log as the two
zero-app-code detection methods).

Four things to carry forward.

**`LIST_STRATEGY=naive|batched` and `QUERY_COUNTER=off|on|header` are real deployment switches, not
scaffolding to remove.** `naive` stays so the A/B and the budget test's red case (`pnpm
db:test:naive`) keep working — drill 07's rule that arms must differ only in the variable, not in
whether the process restarted, applies here too. Both are forwarded through `docker-compose.yml`
the same way `LOG_LEVEL` is, reading the shell first.

**The whale's absolute latency is dominated by card 09's still-open gap, not by anything drill 08
touched.** An isolated `EXPLAIN` put the missing `(org_id, updated_at DESC, id DESC)` index's seq
scan at 154.6ms against the LEFT JOINs' +30ms — and that gap is also why the whale's *k6* numbers
this session were too noisy to trust (10 concurrent VUs thrashing a 128MB `shared_buffers` against
a 230MB+ heap). Fixing card 09 should make the whale's k6 numbers trustworthy for the first time
since drill 05.

**The API no longer connects as the database owner.** `POSTGRES_APP_USER`/`POSTGRES_APP_PASSWORD`
are required and `PostgresService` throws without them — no fallback, because falling back to the
superuser would leave every policy in place enforcing nothing with every test still passing.
`POSTGRES_USER` is now only for migrations and the seed, which is also what lets them bypass RLS.

**A write to any table carrying `org_id` must declare its tenant.** `TenantDb.withOrg()` is the
only way, including in test fixtures — the older suites were changed for this, and that is the
mechanism working rather than scaffolding. `pnpm check:tenancy` fails when a new table forgets.

The stack also remains **instrumented but off by default** — pino at `info`, `LOG_LEVEL` per
service, tracing dark unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set, `pg_stat_statements` dark unless
`PG_PRELOAD` is set — so drill 05's baseline stays the instrument cards 09/10 are compared against.

## Next step

**Card 09 is next**, believed to be the composite-index card — but say that with the right amount
of confidence: drill 05's prediction that "card 08" would be about `count(*)`/keyset paging turned
out to be a guess about *numbering*, not about the technical content, and it was wrong — the actual
card 08 (2026-08-17) was N+1 detection instead. The technical prediction below is still real and
still worth having; only the number attached to it should be read as unconfirmed until the next
card's text arrives:

- **The composite index is where the whale's ~155ms list-query cost lives**, confirmed by drill
  08's isolated `EXPLAIN`: `Parallel Seq Scan` on `conversations`, no usable index for
  `WHERE org_id = $1 ORDER BY updated_at DESC, id DESC`. Fixing this is also what should make the
  whale's *k6* numbers trustworthy again — drill 08's whale comparison landed inside the noise floor
  because 10 concurrent VUs each doing a ~230MB-class scan against a 128MB `shared_buffers` thrash
  the cache in a way the missing index is the root cause of.
- **`count(*)`/keyset paging is real but separate** — `count(*)` was a 33ms index-only scan once
  vacuumed as of drill 04 (refuting drill 03's original prediction), which is a different cost than
  the list query's missing composite index. Whichever future card covers paging, this is its
  starting point, not card 09's.

One measurement is still open, unchanged since drill 06: **the pool under load** —
`PostgresService.stats()` sampled *during* a k6 run, or the `pg-pool.connect` spans across a traced
run. Drill 08 predicted the N+1 there would show up as connection **hold time**, not pool
**saturation** (drill 07 already pins one connection per request via `withOrg`), but did not
actually sample `poolStats` to confirm it — recorded as a real gap in that drill's guide, not a
closed measurement.

## Active plan

None open — every plan file in `plans/` is shipped. `history.md` lists them with results.

## What works

`pnpm docker:up`, then `pnpm db:migrate` and `pnpm db:seed` — or `pnpm db:reset` for both.
`pnpm db:test` runs the e2e suite inside the container (51 tests, 5 suites); `pnpm db:test:naive`
runs the same suite with `LIST_STRATEGY=naive` and is *expected* to fail one assertion — that is the
query-budget proof, not a broken build. Baseline numbers and query plans for drill 03 are recorded
in its plan file — that is the `before` column cards 09/10 get compared against, and drill 04's
plan records what those same queries do at 2.5M rows.

`pnpm logs:trace <id>` reconstructs one request across all services. `pnpm trace:on` adds spans,
a collector and Jaeger on `:16686`; `pnpm trace:off` puts it back. `pnpm db:stats:on` /
`pnpm db:stats` / `pnpm db:stats:reset` drive `pg_stat_statements`, off by default behind
`PG_PRELOAD=pg_stat_statements docker compose up -d postgres_db` (postmaster-context, needs a
recreate — see known issue below for the trap in that).

`pnpm check:tenancy` audits RLS coverage and the serving role's attributes, read-only — it is also
the "check rather than assume" command, which is why there is no separate `rls:status`. Now covers
five tables: `conversations`, `messages`, `memberships`, `tags`, `conversation_tags`.

## Known issues

1. Frontend has no test runner.
2. Backend: `HealthService`, `InfoController` and `RedisService` have no tests of their own — the
   e2e suites reach `/health` over HTTP but never exercise the failure branches. `PostgresService`
   is the exception: `schema.e2e-spec.ts` drives it directly, which is how a DI change to it got
   caught in drill 06.
3. **`pnpm test` (backend unit specs) always passes trivially — `--passWithNoTests`, zero tests.**
   Drill 08 deleted the last one (`app.controller.spec.ts`, `nest new` scaffolding for a route that
   no longer exists) along with `AppController`/`AppService`/`test/app.e2e-spec.ts`. A real gap, not
   hidden by a placeholder: nothing under `src/` has a unit test today, only e2e coverage.
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
7. **Env vars forwarded through `docker-compose.yml` (`LOG_LEVEL`, `LIST_STRATEGY`, `QUERY_COUNTER`,
   `PG_PRELOAD`, …) do not persist across separate shell invocations**, and Compose reconciles the
   *whole* project's desired state even when `up` is scoped to one service — so
   `PG_PRELOAD=pg_stat_statements docker compose up -d postgres_db` followed later by a
   plain `docker compose up -d nest_server` silently reverts and **recreates** `postgres_db` (losing
   its cache). Found the hard way mid-drill-08-measurement. Set every var you want kept in the same
   command, every time, or accept the recreate.

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
- **New instrumentation ships off by default.** Postgres statement logging, `LOG_LEVEL`,
  OpenTelemetry, and now `pg_stat_statements` are all runtime toggles rather than always-on, because
  an always-on instrument silently changes the baseline that every later "before/after" depends on.
  Same reasoning as pinning `grafana/k6:2.1.0`. Drill 08 nearly broke this rule on paper (leaving
  `pg_stat_statements` on for a whole k6 A/B, reasoned as "constant, not a variable") and the
  environment itself enforced it anyway — see the known issue about env vars not surviving a
  separate `docker compose up`.
- **A noisy k6 result and a clean isolated `EXPLAIN` can disagree, and the isolated one wins.**
  Drill 08's whale comparison showed batched as *worse* than naive under 10 concurrent VUs — inside
  the within-arm noise floor, caused by concurrent scans thrashing a deliberately undersized cache,
  not by the code change being measured. An `EXPLAIN (ANALYZE, BUFFERS)` with no concurrent load
  isolated the real, small cost (+19%) that the load test could not see clearly. Concurrency is part
  of what a k6 baseline is *for*, but it is also a confound the moment the thing under test is small
  next to a bigger, unrelated bottleneck sharing the same resource.
- **A control belongs below the code that must not forget it.** Drill 07 measured the rejected
  repository layer as *free* and chose the 23.5%-slower row-level security anyway, because only
  the database-side mechanism protects code that never went through the seam. Speed lost to one
  test case. The corollary is also recorded: on a 185ms endpoint the cost was unmeasurable, so
  this is a decision per endpoint shape, not one global answer.
- **Naive-on-purpose is a recorded decision, not debt.** `GET /conversations` has no composite
  index, no cursor and no caching so cards 09/10 have something real to break. Card 08's own
  naive path (`LIST_STRATEGY=naive`) is the same idea applied to the assignee/tags lookup, and it
  stays in the codebase for the same reason. Read the plan file before "improving" anything here.
