# Drill 24 — Run three replicas and find what silently breaks

**Status:** planned

Card 24. Prereqs 21, 23. Branch `drill-24` (from `main` at `8677d6e`). Saved as
`plans/2026-10-12_drill-24-three-replicas.md`.

## Context

The API has run as one process for 23 drills; drill 23 ran two only to restart them. The card asks
for three replicas behind nginx, a written list of every piece of state believed per-process
**before** the first run, then load to find what the list missed. Two fixes are required and
measured: the drill 21 limiter correct in aggregate (N, not 3N), and one scheduled behaviour that
runs exactly once, including when its holder dies mid-job. You chose: I write the prediction list
(below, committed before any run), and the scheduled job is a usage rollup.

Facts from reading the code and probing:

1. **The shipped limiter is already shared.** `RATE_LIMIT=bucket` is one Lua script on Redis
   (`RedisService.takeToken`) on Redis `TIME`. No arm today keeps limiter state in process memory,
   so "3N" needs a red arm that does.
2. **No scheduled job exists.** The only timers are drill 23's lag window and the import sampler.
3. **Per-process state today:** every `/metrics` counter (`entitlements.service.ts` `counters`,
   `search.service.ts` `statsCounters`, `request-context.ts` pool histograms), `HealthService`'s
   phase and open-response set, `ImportsService.running`/`stopping`, one LISTEN client per process
   (`PostgresService.listen`), and the pg pool itself.
4. **`usage_events` holds 107 rows** (1.5MB). A rollup over it is cheap; k6 ingest fills it during
   runs. It has `occurred_at`, `metric` and `quantity`, and only an `(org_id, period, metric)` index.
5. **nginx OSS:** the upstream `server … resolve` parameter is open source since 1.27.3 (needs a
   `zone` and a `resolver`). Health checks are passive only (`max_fails=1`, `fail_timeout=10s`);
   active `health_check` is NGINX Plus. Upstream keepalive is on by default since 1.29.7. Current
   stable is `1.30.5`.
6. **The running stack already bind-mounts this worktree** (`drills_backend`). Replicas run
   `node apps/backend/dist/main` from the dev server's build, like drill 23's `api_a`/`api_b`.
7. `pnpm logs:trace` reads `docker compose logs` with no profile. `db:ratelimit` reads `/metrics`
   once before and once after an attack from a single URL.

## Decisions

1. **Topology, `profiles: ['replicas']`.**
   - `api`: `extends: api_a` (dist build, tini, `/health/live` healthcheck, 30s grace, the shared
     `drain_imports` volume), `container_name: !reset null`, `profiles: !override ['replicas']`,
     `deploy.replicas: 3`. Containers are `drills-api-1..3`; `--scale api=N` changes N.
   - `nginx`: `nginx:1.30.5-alpine` (pinned), `nginx/nginx.conf` read-only, published on
     `${NGINX_PORT:-8088}`. Config: `resolver 127.0.0.11 valid=1s ipv6=off`; `upstream api { zone;
     server api:3002 resolve; keepalive 64; }` so one name becomes one peer per replica and follows
     Docker DNS; `proxy_connect_timeout 1s`; `proxy_next_upstream error timeout` written out (nginx's
     default; a POST already sent is never retried); `add_header x-served-by $upstream_addr always`;
     an access log with upstream address, status and times; `worker_connections 4096` (2,000
     concurrent clients need two connections each).
   - drill 23's HAProxy rig stays as is.
2. **Rate limiter: a red arm `RATE_LIMIT=memory`.** A token bucket in a `Map` on the
   `EntitlementsService` instance, same B = L and r = L/60. Node runs it on one thread, so it is
   exact on one replica. It is the single-instance assumption as a switch. It lives on the instance,
   not at module scope, so three apps in one jest process are three limiters.
3. **The job: a usage rollup every `JOB_SLOT_S` (60, standing in for nightly).** One migration:
   - `usage_rollups (org_id, slot_start, metric, quantity, holder, term, created_at)`. No unique key,
     on purpose: it stands in for an effect a constraint cannot dedupe (an email, a billing export).
     RLS and a policy per migration 003; `app_user` gets SELECT. Joins `seed.mts`'s TRUNCATE list.
   - `job_runs (job, slot_start, holder, term, rows, started_at, finished_at, PRIMARY KEY (job,
     slot_start))`. Tenant-free. `app_user` gets SELECT, INSERT, UPDATE (the claim is inserted
     first, and `rows`/`finished_at` are set before the same commit).
   - `app_rollup_usage(p_start, p_end, p_holder, p_term) RETURNS integer`, SECURITY DEFINER,
     `SET search_path = pg_catalog, public`: inserts `sum(quantity)` per org and metric for
     `occurred_at ∈ [p_start, p_end)`. It crosses tenants by design, like `app_org_for_api_key()`.
4. **One switch, `SCHEDULER=off|all|lease|fenced`** (default `fenced`), in a new `src/jobs/` module
   (`jobs.module.ts`, `jobs.service.ts`). No `@nestjs/schedule`: it is a per-process timer, which is
   the bug this card is about, and the loop is ~20 lines.
   - `all`: every process runs each due slot. "Last slot run" lives in process memory.
   - `lease`: only the Redis lease holder runs. "Last slot run" still lives in its memory.
   - `fenced` (shipped): the lease, plus a claim. The slot's `job_runs` row is inserted `ON CONFLICT
     DO NOTHING RETURNING` in the same transaction as the rollup. Progress comes from `job_runs`, so
     a new leader runs every missing slot in the last `JOB_CATCHUP` (10) and skips finished ones.
   - `off`: no loop.
5. **The lease.** Key `lease:v1:job:usage-rollup`, value `<hostname>:<pid>`. Two Lua scripts in
   `RedisService`: `acquireLease` (`SET NX PX` + `INCR` a term counter; returns the term or 0) and
   `renewLease` (compare-and-`PEXPIRE`). Release is the existing `delIfEquals`, from
   `beforeApplicationShutdown(signal)`. The loop runs every `SCHEDULER_TICK_MS` (1000; `0` = no
   loop): renew when held, acquire when not, log `leader_acquired`/`leader_lost`. `LEASE_TTL_MS`
   10000, renewed every third of it. The term is a fencing token: it goes into each row, so two
   leaders show up as two terms.
6. **Slots and the job transaction.** Slots are wall-clock aligned; slot S is due at S + slot +
   `JOB_GRACE_S` (5), so ingest transactions that started inside S have committed. The transaction
   sets `lock_timeout = 5s` and `idle_in_transaction_session_timeout = 30s` locally. The second bounds
   how long a paused holder's open claim can block the next leader. `JOB_WORK_MS` (0) adds a
   `pg_sleep` inside the transaction. It is an instrument knob that holds the job open so a kill or
   a pause lands mid-job.
7. **Wiring.** ESLint allowlist adds `src/jobs/jobs.service.ts` (tenant-free `job_runs`; the rollup
   crosses tenants through the SECURITY DEFINER function). `/metrics` adds
   `jobs_runs_total{result=ran|skipped|failed}`, `jobs_lease_acquired_total`,
   `jobs_lease_lost_total` and a `jobs_leader` gauge. `/info` adds `scheduler`, `jobSlotS`,
   `leaseTtlMs`. Compose forwards the six knobs. `test:e2e` sets `SCHEDULER_TICK_MS=0`, so no jest
   app runs the timer.
8. **Instruments.**
   - `db/jobs.mts` → `pnpm db:jobs report --since 10`: one line per slot. Rollup rows per org and
     metric, distinct holders and terms, `sum(rollups)` against the ledger's `sum(quantity)`,
     `job_runs` row. Verdict per slot: `once`, `×N`, or `missing`.
   - `db/ratelimit.mts`: an `API` knob (`http://nginx:8080`), and `/metrics` summed over every
     replica found by a DNS lookup of `REPLICAS` (`api`).
   - `scripts/replicas.ts` → `pnpm replicas`, on the host because it drives Docker. Each subcommand
     prints the docker commands it runs.
     - `up --scheduler --rate-limit --pool --slot-s --work-ms --scale` runs `docker compose
       --profile replicas up -d --no-deps api nginx` with those env vars, waits for each replica's
       `/health/live`, and prints container, IP and `/info` arms.
     - `spread --n 300` tallies `x-served-by`.
     - `chaos --do kill|pause --hold 15` finds the lease holder, waits until it is mid-job, kills or
       pauses it, and unpauses after the hold. It prints the timeline from the logs (lease lost and
       acquired, slots ran and skipped).
     - `down` removes the replicas and nginx.
   - Load is the existing `pnpm load drain --base-url http://nginx:8080` (its ingest share writes
     the ledger).

## Predictions, recorded before any run

Written from reading the code. Each is scored after the run as hit, miss or not exercised.

**Breaks with three replicas**

1. **A per-process limiter admits 3N.** `memory`: 2,000 concurrent through nginx admits ≈ 1,800 on
   basic (3 × 600). On one replica it admits ≈ 600 and its existing e2e tests pass. Only a
   multi-instance test catches it.
2. **A timer-driven job runs once per process.** `all`: three rows per org per slot, four if the
   dev `nest_server` also runs it. `sum(rollups)` = 3× the ledger. Nothing errors.
3. **A lease alone is not exactly-once.** `lease` runs each slot once in steady state. It re-runs a
   slot after a failover, because "last slot run" died with the old leader's memory. It also
   double-runs a slot whose holder was paused past its TTL mid-job.
4. **`/metrics` lies through the LB.** Successive scrapes hit different replicas, so a counter can
   go down between two scrapes. `db:ratelimit`'s before/after `/metrics` delta is wrong, possibly
   negative.
5. **The connection budget is the fleet's.** Each replica holds pool + 1 LISTEN. Default: 3 × 11 +
   11 (dev server) = 44 of 97. At drill 22's knee (`PG_POOL_MAX=32`): 3 × 33 + 11 = 110 > 97, so
   load produces 53300 failures.
6. **nginx never reads readiness.** OSS nginx has no active checks, so drill 23's `/health` 503
   while draining is ignored. nginx learns a replica is gone only from a failed request.
7. **Logs are per container.** `pnpm logs:trace <rid>` misses replica lines (no `replicas` profile).
   pino's `hostname` names the replica.

**Survives, because the state is already shared**

8. **The `bucket` limiter is correct in aggregate:** ≈ 600 admitted, within drill 21's ±1% of
   B + r·T. The `fixed` arm is also correct for concurrency (it keeps its boundary bug).
9. **The entitlement cache is in Redis**, so its hit ratio does not change. Each replica's LISTEN
   client DELs the key on a plan change: three DELs, harmless.
10. **Stats single-flight is a Redis lock:** one recompute per expiry across the fleet.
11. **Idempotent ingest** (SETNX + unique index): duplicates across replicas land once.
12. **Imports:** the worker runs where the upload landed. The shared `drain_imports` volume lets a
    retry routed to another replica find the spool. Without it, 2 of 3 retries fail.

**Fenced job under failure**

13. **Holder SIGKILLed mid-job.** Postgres sees the socket close and rolls the slot back. The lease
    lives until its TTL, so failover takes ≈ 10s plus up to one renew interval (≤ 13.3s). The next
    leader runs the slot once, late.
14. **Holder paused mid-job (`docker pause`).** Its claim row stays uncommitted on an open
    connection. The new leader's claim blocks on it, hits `lock_timeout`, and retries next tick. On
    unpause the old leader commits and the new leader's claim conflicts. Result: one run, two terms
    visible in the logs. A pause over 30s gets the old session killed by
    `idle_in_transaction_session_timeout`, and the new leader runs the slot.

**Per process by design, or not exercised here**

15. Event-loop lag, in-flight count and drain phase are per process, which is correct.
16. `/info` and `pnpm arms` through nginx describe one replica per call; mixed arms mid-deploy
    would look uniform.
17. Without `resolve`, nginx resolves `api` once at startup and never sees a replica added later.
    With it, `--scale api=4` joins within ~1s.
18. Round robin over keep-alive upstream connections splits traffic ≈ 1/3 each.
19. Not exercised: one kernel clock means no skew between replicas here (slot math and the rmw
    arms use `Date.now()`). Next.js is not replicated; its on-disk data cache is per instance.

## What ships

**Edits**
- `src/entitlements/entitlements.service.ts`: the `memory` arm.
- `src/redis/redis.service.ts`: `acquireLease`, `renewLease`.
- `src/app.module.ts`, `src/entitlements/entitlements.controller.ts` (`/metrics`),
  `src/info/info.controller.ts` + `test/arms.e2e-spec.ts`.
- `eslint.config.mjs`, `db/seed.mts` (TRUNCATE list), `apps/backend/package.json` (`test:e2e` env).
- `db/ratelimit.mts`; `scripts/measure.ts` catalog (`jobs`, ratelimit `api`/`replicas`).
- `docker-compose.yml` (six knobs on `nest_server`, `api`, `nginx`), `.env.example`.
- Root `package.json`: `replicas`, `db:jobs`, `db:test:jobsall`, `db:test:lease`,
  `db:test:ratememory`. `scripts/check-arms.ts` if its catalog needs the new arms.

**New**
- `src/jobs/jobs.module.ts`, `src/jobs/jobs.service.ts`.
- Migration `…_usage-rollups-and-job-runs.js`.
- `nginx/nginx.conf`, `db/jobs.mts`, `scripts/replicas.ts`.
- `test/replicas.e2e-spec.ts`. It boots three `AppModule` apps in one process: three module
  graphs, so three replicas. Redis DB 1, no timer. Each test drives `tick(now)` with a fixed clock
  on a historic slot seeded with known ledger rows.
  1. Three replicas tick one slot: one rollup set, equal to the ledger. Red on `all`.
  2. A failover after a finished slot does not re-run it. A runs S, the lease is deleted, B ticks
     the same `now`. Red on `all`, `lease`.
  3. A holder paused past its lease mid-job: A runs S with 1.5s of work, the lease is deleted at
     200ms, B ticks. One rollup. Red on `all`, `lease`.
  4. A holder killed mid-job: its backend is terminated and B re-runs. Exactly one. Green on every
     arm.
  5. Three replicas share one ingest limit: 3 × 60 requests spread round-robin over a free org.
     Admitted ≤ 60 + refill. Red on `memory`.
  Red runs MUST fail exactly: `db:test:jobsall` 3, `db:test:lease` 2, `db:test:ratememory` 1.

## Measurement

One sitting, this worktree's stack (`drills` project), named services and `--no-deps` on every
compose call.

1. **Prediction 2's fourth runner.** One `all` run with the dev server on its default `fenced`. Then
   `SCHEDULER=off docker compose up -d --no-deps nest_server` for the rest.
2. **Spread.** `pnpm replicas up`, `pnpm replicas spread --n 300`.
3. **Limiter, interleaved.** `pnpm db:ratelimit concurrent --api http://nginx:8080 --rounds 3` on
   `memory` × 1 replica, then on 3 replicas: `memory`, `bucket`, `memory`, `bucket`. One `boundary`
   run on `bucket`. One `/metrics` delta taken through nginx before the instrument fix (P4).
4. **Job, interleaved `all`, `lease`, `fenced`.** `JOB_SLOT_S=10`, `pnpm load drain --base-url
   http://nginx:8080 --rate 150 --duration 120s`, then `pnpm db:jobs report`.
5. **Failover.** `JOB_WORK_MS=4000`. `pnpm replicas chaos --do kill` and `--do pause --hold 15` on
   `lease` and `fenced`, two each. Then one pause of 40s on `fenced` (crosses the 30s idle timeout).
   Recorded: failover time, slot verdicts, terms.
6. **Pool budget.** Three replicas at `PG_POOL_MAX=32` against `10`, `pnpm load drain` at a rate
   that saturates; count 53300s and pool errors.
7. **The audit for misses**, during a `fenced` run:
   - per-replica `/metrics`;
   - `pg_stat_activity` grouped by client address and `application_name`;
   - `pnpm logs:trace`, the nginx error log, `/info` sampled 10 times;
   - `--scale api=4` live.
   Anything not on the list goes into "Missed".
8. **Score the list.** A table: prediction, expected, measured, score.

## Stretch (only on your go): kill one replica mid-load

`pnpm load drain --base-url http://nginx:8080 --rate 150`, then `docker kill drills-api-2` at 30s.
Measure errors per second by endpoint, and the time from the kill to nginx's first `upstream …
failed` / `temporarily disabled` line. Repeat with `docker stop` (graceful).

Prediction: SIGKILL fails only POSTs in flight on that replica. GETs are retried on another peer by
`proxy_next_upstream`. nginx notices on the first failed request (< 1s) and benches the peer for
`fail_timeout` (10s). Docker DNS drops the IP within `valid=1s`. `docker stop` gives 0 errors even
though nginx never reads readiness, because a refused connect is retried for every method.
`restart: always` (inherited) may bring the killed container back within seconds; the run records
it.

## Write-up and guide

The plan's Results and Write-up answer the card's three questions:
1. What I predicted correctly and what I missed (the scored table).
2. How the run-once mechanism behaves when the holder dies mid-job (measured kill and pause).
3. Which single point of failure is new. nginx replaces `nest_server` as the one box everything
   crosses. Redis now gates leadership: Redis down means no leader and no rollup (fail closed),
   while the limiter fails open. The Postgres connection budget is shared by N replicas.

`drills/24-three-replicas.md` (gitignored) is drafted in the worktree and copied to the main
checkout. It contains:
- ELI5;
- a diagram of three replicas, nginx, Redis lease and Postgres claim;
- a sequence diagram of a pause-induced double leader and the fence that stops it;
- every command with its result;
- a tech stack cheat sheet: nginx upstreams, `resolve`, passive checks, `proxy_next_upstream`,
  Docker DNS, Compose `deploy.replicas`/`!reset`/`!override`, Redis `SET NX PX` + Lua leases,
  fencing tokens, `ON CONFLICT DO NOTHING` claims, SECURITY DEFINER for cross-tenant jobs,
  `idle_in_transaction_session_timeout`, Nest lifecycle hooks;
- `Is this production ready?`, `Honest gaps` and `What I'd do differently at 10x`.

## Workflow

1. Write this plan to `plans/2026-10-12_drill-24-three-replicas.md` and add the `planned` history
   row. Commit both before any code. That commit timestamps the predictions.
2. Commits, in order:
   - migration + jobs module + lease + tests;
   - the `memory` arm + its test;
   - compose/nginx + instruments + `pnpm replicas`.
3. Measure, then record results and the scored list in the plan.
4. Guide; README row.
5. `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm check:arms`, `pnpm check:tenancy`.
6. Memory bank update. History row → `implemented`.
7. PR, then the `drill/24` release (0.24.0), tagged on the branch before the merge.
8. Cleanup: `docker compose --profile replicas rm -sfv api nginx`, the pulled nginx image, the
   `k6-drain-*` rows (SQL in `progress.md`).

## Verification

- `curl -si localhost:8088/health` three times shows three `x-served-by` addresses.
- `pnpm db:ratelimit concurrent --api http://nginx:8080`: `memory` ≈ 3× the limit, `bucket` ≈ the
  limit.
- `pnpm db:jobs report` after a `fenced` run: every slot `once`, and `sum(rollups)` = ledger. After
  an `all` run: `×3`.
- `pnpm replicas chaos --do kill` on `fenced`: the killed slot ends `once` with a new term.
- `pnpm db:test` green; `db:test:jobsall` red 3, `db:test:lease` red 2, `db:test:ratememory` red 1.
- `pnpm arms` shows `scheduler`; `pnpm check:tenancy` passes with `usage_rollups`.
