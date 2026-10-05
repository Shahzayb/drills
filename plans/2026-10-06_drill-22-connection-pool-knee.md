# Drill 22 — Find the knee in the connection pool

**Status:** shipped

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

## Results

Measured 2026-10-06 in one sitting. Dev server, seeded volume, `COMPOSE_PROJECT_NAME=drills`,
`PG_MAX_CONNECTIONS=200`, `QUERY_COUNTER=header`, `pg_stat_statements` off. `nest_server` was
recreated per arm. Load: `pnpm load pool --org 2-10 --vus 100`, 20s warm-up, 60s measured. Reports:
`k6/reports/2026-10-06-0257*` to `…-0326*` (host clock) and
`apps/backend/db/reports/2026-10-05-2158*` to `…-2227*` (container clock, UTC). Pass `a` ran
ascending, pass `b` descending.

### Characterisation (pgss on, pool 10 and 100)

| statement | calls | mean ms | blocks read per call | share of DB time |
|---|---|---|---|---|
| search (`messages … @@ … ORDER BY created_at DESC`) | 3,373 | 221.79 | 17,483.6 | 96% |
| `count(*)` (offset list) | 6,745 | 4.05 | 94.7 | 3.5% |
| list page, tags, keyset page | — | 0.07–0.14 | < 8 | < 0.3% |

The API spent 0.33 cores at 177 req/s (pool 10) and 0.72 at 485 req/s (pool 100): ~1.5–1.9ms of
Node CPU per request. The decision rule (API below 0.8 cores at pool 100) held, so the mix was not
changed. A lighter mix would have saturated Node's one thread near 530 req/s before Postgres.

### DONE WHEN: the sweep

| pool | req/s (a · b) | p50 ms | p99 ms (a · b) | acquire wait mean ms | hold mean ms | Postgres cores | API cores | active backends | runnable tasks | involuntary switches/s |
|---|---|---|---|---|---|---|---|---|---|---|
| 2 | 140 · 138 | 713 | 985 · 1,251 | 710 | 14 | 3.3 | 0.21 | 1.9 | 4.7 | 18 |
| 4 | 160 · 160 | 611 | 840 · 1,105 | 601 | 25 | 4.8 | 0.27 | 3.9 | 6.2 | 20 |
| 8 | 162 · 161 | 584 | 928 · 966 | 571 | 49 | 6.1 | 0.28 | 7.8 | 7.6 | 93 |
| 12 | 193 · 197 | 460 | 816 · 765 | 452 | 61 | 7.4 | 0.34 | 11.8 | 9.8 | 1,403 |
| 16 | 231 · 237 | 370 | 708 · 649 | 360 | 68 | 8.3 | 0.38 | 15.7 | 13.4 | 7,625 |
| 24 | 289 · 298 | 270 | 662 · 591 | 258 | 82 | 9.7 | 0.44 | 23.5 | 20.6 | 20,991 |
| **32** | **334 · 339** | **217** | **649 · 611** | 201 | 95 | 10.7 | 0.49 | 31.3 | 26.1 | 29,236 |
| 48 | 387 · 378 | 153 | 690 · 694 | 135 | 125 | 11.7 | 0.56 | 46.7 | 39.2 | 30,497 |
| 64 | 401 · 403 | 109 | 773 · 765 | 89 | 159 | 12.0 | 0.62 | 62.2 | 51.8 | 25,187 |
| 100 | 468 · 472 | 28 | 953 · 934 | 1 | 210 | 12.2 | 0.72 | 95.5 | 68.5 | 20,653 |

Throughput spread between passes: 0.1–3.1% at every size. p99 spread: up to 32% at pools 2 and 4,
12% or less elsewhere. Zero errors and zero acquire timeouts in all 20 runs. Little's law holds on
every row: pool ≈ req/s × hold (48: 383 × 0.125 = 48), and 100 VUs ≈ req/s × (wait + hold).

Active waits (pass `a`), share of `active` samples:

| pool | `IO:AioIoCompletion` | `LWLock:AioWorkerSubmissionQueue` | CPU | `IO:DataFileRead` | `LWLock:BufferMapping` |
|---|---|---|---|---|---|
| 2 | 3% | 6% | 91% | — | — |
| 16 | 36% | 23% | 30% | 8% | 0% |
| 32 | 42% | 19% | 22% | 10% | 6% |
| 64 | 36% | 25% | 17% | 10% | 11% |
| 100 | 39% | 16% | 13% | 7% | 24% |

### Why throughput kept rising past 48

Diagnostic runs (30s, outside the sweep):

- **Parallel query is not the reason.** `pg_stat_activity` showed 0 parallel workers at pool 32 and
  at pool 100. No plan in the mix runs parallel. The extra cores at small pools are PG 18's three
  `io_method = worker` processes copying pages from the OS cache.
- **Cache sharing is.** `pg_stat_database` deltas per commit:

  | pool | blocks read | blocks hit | hit ratio | req/s | blocks read/s |
  |---|---|---|---|---|---|
  | 32 | 4,389 | 318 | 6.7% | 339 | ~1.49M |
  | 100 | 3,177 | 1,538 | 32.6% | 479 | ~1.52M |

  Postgres reads the same ~1.5M blocks/s (~12 GB/s) at both sizes: the read path is the ceiling.
  At pool 100 about 25 searches run at once across 9 orgs, so concurrent searches on one org hit
  each other's pages. Each request reads 28% less, and 339 × 4,389 / 3,177 = 468 req/s. That is an
  artifact of a mix with 9 hot tenants.

### The knee and the number

**The knee is at 32–48 connections. Ship 32.**

- p99 is lowest at 24–32 (626–630ms mean of passes). 24 is 13% less throughput for the same p99.
- At 32 Postgres burns 10.7 of the ~12.5 cores left after Node, k6 and Redis, and acquire wait is
  still two-thirds of latency. By 48 the cores are pinned (11.7) and stay there.
- Past 32, every added connection buys throughput only by slowing the slowest requests:
  48 is +14% req/s for +10% p99, 64 +19% for +22%, 100 +40% for +50%. Search p99 goes 691 → 1,153ms.
- The default (10) leaves half the cores idle: requests wait 450–570ms for a connection to run
  60ms of work.

The code default stays 10 so drill 05's baselines remain comparable; `PG_POOL_MAX=32` is the
recommendation.

### `max_connections` relative to these numbers

`max_connections = 100` with 3 superuser slots reserved gives the app role 97. Pool 100 at that
default (`maxconn100-pool100`): 95 connections opened; 23,497 acquires failed with `remaining
connection slots are reserved for roles with the SUPERUSER attribute` (19,678 in the Postgres log)
or `sorry, too many clients already` (10,917). **47.5% of requests failed**, each as a fast 500, so
k6 sent 823 req/s and Postgres committed 435/s. The knee (32) is a third of `max_connections`; the
oversized pool (100) is past it.

### Stretch: pgbouncer 1.25.2, transaction mode, `default_pool_size = 32`

`pnpm db:pool bouncer` (report `apps/backend/db/reports/2026-10-05-223533-pool-bouncer`). Two app-role
clients, A then B; pgbouncer hands B the server connection A just released.

| probe | direct | through pgbouncer |
|---|---|---|
| `SET work_mem = '77MB'` on A | B sees 4MB | **B sees 77MB** |
| `pg_advisory_lock(22)` on A, `pg_try_advisory_lock(22)` on B | B false, A unlocks | **B true; A's unlock false** (`you don't own a lock of type ExclusiveLock`); 1 lock left on a pooled server connection |
| `LISTEN` on A, `NOTIFY` on B | listener 1, notifier 0 | **listener 0, notifier 1** |
| named prepared statement, `max_prepared_statements = 0` | ok | **`prepared statement "pool_probe" does not exist`** |
| same, `max_prepared_statements = 200` | ok | ok |
| `set_config('app.org_id', '7', true)` (what the API does) | B sees 0 rows | B sees 0 rows |
| `set_config('app.org_id', '7', false)` | B sees 0 rows | **B sees org 7: 111,111 rows** |

The e2e suite through pgbouncer (`-e POSTGRES_HOST=pgbouncer -e POSTGRES_PORT=6432`): 156 of 157
pass. The one failure is drill 19's `notify` arm: the entitlements `LISTEN` client connects and
never hears a plan change. RLS survives because `withOrg` scopes the GUC to the transaction.

A second API process (port 3003, `PG_POOL_MAX=100`) through pgbouncer: 338 req/s, p99 607ms, 0
errors, 33 server connections. Direct pool 32 measured 337 req/s, p99 630ms. The app's acquire
wait read 0.86ms and its hold 294ms: the queue moved into pgbouncer, where the app's metric cannot
see it (`SHOW POOLS` `cl_waiting`/`maxwait` can).

### Tests

`pnpm db:test` 157/157 (155 → 157); `db:test:pool2` 157/157 (green by design). With `max: 10`
hard-coded and `PG_POOL_MAX=2`, the saturation test failed (`Expected: >= 2, Received: 0`).
`pnpm test:ui` 6/6.

### Predictions

1. Knee at 12–24, flat after: **miss.** Postgres saturates at 32–48 and throughput never went flat
   (+40% from 32 to 100, from cache sharing).
2. p99 U-shaped: **hit** (minimum 626–630ms at 24–32, 943ms at 100). Pool 2 p99 above 1s: hit
   (985 · 1,251ms). Some 2s timeouts: **miss**, zero. Mean latency flat past the knee: **miss**,
   because throughput rose.
3. Involuntary switches several-fold from 16 to 100: **partial.** 7,625 → 20,653/s (2.7×), with a
   peak of 30,497/s at 48. From pool 2 to 48 they rose 1,700×. CPU pinned from the knee on: hit.
4. Parallel query lowers the knee: **miss.** No query in the mix ran parallel.
5. Pool 100 at `max_connections = 100` fails some acquires all run: **hit**, larger than predicted
   (47.5% of requests).
6. Stretch: transaction-local `set_config` survives transaction pooling: **hit.**

### Divergences from the plan

- `test/pool.e2e-spec.ts` has two tests: the switch check is inside the saturation test, which reads
  `poolMax` from `/info` and fails when the pool ignores it.
- A failed acquire still records its wait, so timeouts reach the histogram's tail.
- `db:pool watch` gained blocks read and hit per commit after the sweep. The cache-sharing numbers
  above came from a `psql` diagnostic first.
- Two diagnostic run pairs (parallel workers, blocks per commit) were added to explain the right
  side of the curve.
- The stretch's load run used a second API process on port 3003 instead of re-pointing
  `nest_server`, so compose needed no `POSTGRES_HOST` override.

## Write-up

**Where is the knee, and what limits each side?** 32–48 connections. Left of it the pool is the
limit: at pool 8 a request waits 571ms for a connection and holds it 49ms, while Postgres uses 6 of
~12.5 cores. Throughput is pool ÷ hold. Right of it Postgres is the limit: cores pinned at 12, reads
pinned at ~1.5M blocks/s through three I/O workers, `LWLock:BufferMapping` contention climbing from
0% to 24%. The acquire wait falls to zero and the same queue reappears inside Postgres as a longer
hold (95 → 210ms).

**What does p99 do past the knee, and why doesn't throughput improve?** p99 climbs 630 → 943ms.
100 backends time-slice 12 cores and three I/O workers, and a time-sliced scheduler stretches the
longest request most: search p99 691 → 1,153ms while list p99 fell 285 → 93ms. Here throughput did
improve 40%, but no capacity was added: Postgres read the same 1.5M blocks/s. Concurrent searches on
the same 9 orgs shared buffers and needed 28% fewer reads each. With a realistic tenant spread that
gain shrinks toward zero and the curve goes flat.

**With 3 replicas?** The knee belongs to Postgres, not to a replica. Three replicas at pool 32 put
96 active connections on Postgres: the pool-100 row (p99 943ms). At the default `max_connections`
96 app connections plus three LISTEN clients exceed the role's 97 slots, which is the 47.5%-failure
run. So per-replica pool = knee ÷ replicas (≈ 11, close to today's 10), and `max_connections` is a
budget for the whole fleet: knee + listeners + migrations + admin headroom. Raising it does not move
the knee. A transaction pooler decouples the two: the app pools at 100 and Postgres still sees 32.
