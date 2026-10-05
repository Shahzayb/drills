# Drill 22 — Find the knee in the connection pool

**Status:** planned

Card 22. Prereq 05. Branch `drill-22`. Saved as `plans/2026-10-06_drill-22-connection-pool-knee.md`.

## Context

The API's pool is `POOL_MAX = 10` in `src/postgres/postgres.service.ts`, chosen in drill 01 for a
dev stack and never measured under load. Nothing records how long a request waits for a
connection. `stats()` exposes `waiting` on `/info` as a point-in-time count only.

The card asks for a curve: hold the load fixed, vary only the pool, and chart throughput, p50,
p99 and acquire wait per size. The acquire wait is the metric that explains the shape. Below the
knee, requests queue in Node for a connection while Postgres has idle cores. Above it, every
request gets a connection at once and the queue moves into Postgres's CPU run queue.

Facts from reading the code that shape the drill:

1. **`connectionTimeoutMillis: 2000` also times out a queued acquire.** pg-pool 3.14 fails a
   waiter with `timeout exceeded when trying to connect` after 2s. A too-small pool produces
   500s as well as latency.
2. **`query()` calls `pool.query()`**, which acquires inside pg-pool where it cannot be timed.
   `withClient()` calls `pool.connect()` and can be timed.
3. **ESLint forbids importing `postgres.service` from `entitlements.controller.ts`**, which owns
   `GET /metrics`. `statsCacheMetrics()` shows the pattern: a module-level function appended to
   the page.
4. **`max_connections` is 100** (`PG_MAX_CONNECTIONS`). With `superuser_reserved_connections = 3`
   and the LISTEN client, the app role gets 96 pool connections. A pool of 100 cannot fully open
   at the default.
5. Docker's VM has 14 CPUs (M4 Pro). Postgres, Node, k6 and Redis share them with no CPU limits.

## Decisions

1. **One knob, `PG_POOL_MAX`** (default 10), read once at module load with `||`. Reported as
   `arms.poolMax` on `/info`, forwarded in compose, checked by `check:arms`. Every other pool
   setting stays fixed, including the 2s timeout.
2. **Acquire wait and hold time are measured at one point.** `query()` stops calling
   `pool.query()`. It goes through the same timed `acquire → run → release` as `withClient()`,
   which is what `pool.query()` does internally. Wait = `pool.connect()` duration. Hold =
   acquire to release.
3. **Two outputs from the same recorders**, added to `observability/request-context.ts` beside
   `recordQuery()`:
   - Process-wide Prometheus histograms `pg_pool_acquire_wait_seconds` and
     `pg_pool_hold_seconds`, and `pg_pool_acquire_errors_total{reason="timeout|connect"}`.
     These are always on. They are the shipped metric. `poolMetrics()` is appended to
     `/metrics` like `statsCacheMetrics()`.
   - Per-request sums `poolWaitMs` and `poolHoldMs` on `RequestContext`. `LoggingInterceptor`
     sets `x-pool-wait-ms` and `x-pool-hold-ms` in `QUERY_COUNTER=header` mode only, next to
     `x-query-count`. k6 reads them, so the percentiles cover the measured window only.
4. **The load profile is fixed: closed model, 100 VUs, a read-only mix.** 100 VUs is at least
   the largest pool, so no pool size is capped by concurrency. New `k6/pool-mix.ts`
   (`pnpm load pool`) chooses each request by iteration number. The mix is identical every run:
   - 2/4 `GET /conversations?page=1&pageSize=20` (offset: `count(*)` + page)
   - 1/4 `GET /conversations?paging=keyset&status=open&pageSize=20`
   - 1/4 `GET /messages/search?q=export&limit=20`
   - Orgs cycle through `ORGS` (default `2-10`, the nine mid orgs, ~111k conversations each).
     The whale is excluded because its parallel aggregate exhausts `/dev/shm` (known issue 36).
     The tail is excluded because its queries are too light: Node would saturate before Postgres.
   - Requests are tagged per endpoint. The error threshold is loosened so a run with timeouts
     reports its errors instead of aborting.
   - Writes are left out because they grow the tables between arms and add row-lock contention as
     a second variable. Recorded as a gap.
5. **Pool sizes: 2, 4, 8, 12, 16, 24, 32, 48, 64, 100.** Ten values. `PG_MAX_CONNECTIONS=200`
   for the whole sweep, so only the pool varies. `pg_stat_statements` is off during the sweep
   because its shared hash contends at high concurrency. It is on for the characterisation run
   only.
6. **The Postgres side is read with SQL**, by a new instrument `apps/backend/db/pool.mts`
   (`pnpm db:pool watch`). It runs in the container beside the k6 run, with `DELAY=20` and
   `SECONDS=60` to match k6's warm-up and measured window. As the owner (superuser) it reads:
   - Postgres CPU: `pg_read_file('/sys/fs/cgroup/cpu.stat')` at start and end, giving cores busy.
   - API CPU: its own container's `/sys/fs/cgroup/cpu.stat`, read the same way.
   - Context switches: `/proc/stat` `ctxt` (whole VM), and `nonvoluntary_ctxt_switches` from
     `/proc/<pid>/status` for every app backend. Involuntary switches are preemptions. They are
     the direct measure of "context-switching itself to death".
   - Every second, `pg_stat_activity` for the app role: active backends, plus a tally of
     `wait_event_type:wait_event`.
   - `pg_stat_database.xact_commit` delta, as a server-side throughput cross-check.
   - `/metrics` before and after: the acquire-wait histogram delta (count, mean, bucket p99).
   - Header: `max_connections`, `superuser_reserved_connections`, `reserved_connections`, and
     current connections by role and `application_name`.
   All of these files were confirmed readable in the running containers.
7. **The chart is a mermaid `xychart-beta`** in the plan's Results and in the guide. It renders on
   GitHub and needs no generator code. Throughput is drawn as bars and p99 as a line against pool
   size, and a second chart holds acquire wait and hold time. The knee is marked in the caption.
   I will use the dataviz skill if mermaid cannot show the knee legibly.

## What ships

**Edits**
- `src/postgres/postgres.service.ts`: `PG_POOL_MAX`, timed `acquire()` used by `query()` and
  `withClient()`, release records hold, acquire errors counted by reason.
- `src/observability/request-context.ts`: `poolWaitMs`/`poolHoldMs`, `recordPoolWait()`,
  `recordPoolHold()`, `recordPoolError()`, histograms, `poolMetrics()`.
- `src/observability/logging.interceptor.ts` and `query-counter.ts`: the two headers in
  `header` mode.
- `src/entitlements/entitlements.controller.ts`: append `poolMetrics()` to `/metrics`.
- `src/info/info.controller.ts` + `test/arms.e2e-spec.ts`: `arms.poolMax`.
- `docker-compose.yml` (`PG_POOL_MAX`), `.env.example`, root `package.json` (`db:pool`),
  `scripts/measure.ts` catalog (`pool`), `scripts/load.ts` catalog (`pool` →
  `pool-mix.ts`, knobs `orgs`, `q`). `check:arms` stays green.

**New**
- `k6/pool-mix.ts`: the fixed mix. Its summary adds `pool wait p50/p99/mean`,
  `pool hold p50/p99/mean`, and p99 per endpoint.
- `apps/backend/db/pool.mts`: `watch`, as described above.
- `test/pool.e2e-spec.ts`:
  1. *Saturation:* `2 × max` concurrent holds through `PostgresService` → the histogram count
     rises by `2 × max`, and at least `max` waits are ≥ 80% of the hold time.
  2. *Headers:* a request in `header` mode carries `x-pool-wait-ms` and `x-pool-hold-ms`, and
     hold > 0.
  3. *Switch:* `/info` `poolMax` equals the pool's real `max` and the env value.
  Red run `db:test:pool2` (`PG_POOL_MAX=2`) MUST stay green, because the tests read the
  resolved max. This proves the switch reaches the pool.

## Predictions, recorded before measuring

1. **Knee at 12–24 connections**, near the cores Postgres can use (~12 of 14). Throughput rises
   roughly linearly to there and is flat after it (±10%).
2. **p99 is U-shaped.** Left of the knee it is acquire wait: pool 2 shows p99 above 1s and some
   2s timeouts. Right of the knee acquire wait is ~0, and p99 climbs again from 32 up. Postgres
   time-slices 100 active backends over ~12 cores, which stretches the slow search queries most.
   Mean latency barely changes past the knee. In a closed loop mean = VUs / throughput
   (Little's law), so with flat throughput the mean is flat too.
3. **Involuntary context switches per second rise several-fold** between pool 16 and pool 100.
   Postgres CPU is pinned at roughly the same cores from the knee on.
4. Parallel query makes one connection worth more than one core at small pools, so the knee may
   sit lower than the core count.
5. **Pool 100 at the default `max_connections = 100`:** ~4 connections refused
   (`remaining connection slots are reserved…`), with errors on every refused acquire for the
   whole run.

## Measurement

The running stack belongs to another worktree's Compose project (`drills`, bind-mounted from
`busy-kapitsa-91f350`). I will ask before recreating it from this worktree.

Every call carries `COMPOSE_PROJECT_NAME=drills PG_MAX_CONNECTIONS=200 QUERY_COUNTER=header`.

1. **Settle:** `VACUUM (ANALYZE)` on conversations and messages. This sets the visibility map
   that the index-only `count(*)` needs.
2. **Characterise (pgss on):** pool 10 and pool 100, one run each. Record DB time per request by
   statement, and API vs Postgres cores. **Decision rule:** API container CPU must stay below
   0.8 cores at pool 100, which means Postgres is the bound resource. If it is not, the mix gets
   heavier through the existing knobs (`--orgs`, `--q`) before the sweep. This is not a re-plan.
3. **Sweep (pgss off):** for each size, `PG_POOL_MAX=<n> docker compose up -d nest_server` →
   `pnpm arms` shows `poolMax` → `pnpm db:pool watch &` → `pnpm load pool --vus 100
   --name pool<n>`. Run two passes in one sitting, ascending then descending, so drift cancels.
   Report both values and the mean. A spread above 15% gets a third run at that size.
4. **`max_connections` demo:** pool 100 with Postgres back at the default 100. One run, errors
   and messages recorded.
5. `pnpm db:test` green, `db:test:pool2` green, `pnpm test:ui` green.

## Stretch (only on your go after the sweep): pgbouncer in transaction mode

This adds a pinned pgbouncer image under `profiles: ['pgbouncer']`, with `POSTGRES_HOST`
pointed at it for one run. `db:pool bouncer` probes what breaks through it:
- Session `SET`, which leaks across clients.
- Session `pg_advisory_lock`, where the unlock lands on another server connection.
- `LISTEN`: the entitlements listener goes silent.
- Named prepared statements, with and without `max_prepared_statements`.
- The repo's `set_config(…, true)`, predicted to survive because it is transaction-local.
This is a new dependency, so it is not started without your approval.

## Write-up and guide

The plan's `Results` + `Write-up` answer the card:
- Where the knee is, and the limiting resource on each side (pool queue vs Postgres CPU),
  backed by acquire wait, cores busy, active backends and involuntary switches.
- What p99 does past the knee, and why throughput does not improve.
- 3 replicas: total connections = 3 × pool, so the knee and `max_connections` are budgets for the
  whole cluster. The replica answer is reasoned from the measured knee, not measured. Card 24
  measures replicas.

`drills/22-connection-pool-knee.md` is gitignored. It is drafted in the worktree and copied to
the main checkout. It contains: ELI5, the knee chart, a queue diagram (Node waiters → pool →
backends → cores), every command with its result, a tech stack cheat sheet (pg-pool internals,
`max_connections`, cgroup/`/proc` reads, k6 closed model, Little's law), `Is this production
ready?`, `Honest gaps`, and `What I'd do differently at 10x`.

## Workflow

1. Plan file + `planned` history row; commit.
2. Implement in commits: pool instrumentation + metrics + tests → k6 script + instrument +
   wiring.
3. Measure (after confirming the stack takeover); record results in the plan.
4. Guide; README row.
5. `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm check:arms`.
6. Memory bank: write verified facts directly (techContext pool paragraph, the shipped pool
   size, red-run list) and propose judgment calls first. History row → `implemented`.
7. PR, then the `drill/22` release (0.22.0) tagged on the branch before the merge.

## Verification

- `pnpm db:test` green; `test/pool.e2e-spec.ts` passes at the default and at `PG_POOL_MAX=2`.
- `curl -s localhost:3002/metrics | grep pg_pool_` shows both histograms moving under load.
- `curl -si localhost:3002/conversations -H 'x-org-id: 2'` in header mode shows
  `x-pool-wait-ms` and `x-pool-hold-ms`.
- `pnpm arms` reports `poolMax` before every sweep run.
- The `db:pool watch` commit rate agrees with k6 throughput within a few percent on every run.
