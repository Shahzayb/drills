# Drill 20 — Cause a stampede and watch the database buckle

**Status:** planned

Card 20. Prereq 19. Branch `drill-20`.

## Context

The hot key needs an expensive recompute, or a stampede is invisible. Drill 19's entitlement
read is a 0.012–0.027ms primary-key probe: twenty duplicates of it cost nothing. The card's
"expensive query" already exists: `GET /messages/stats` (card 17) is one aggregate over the
org's messages with nothing cached in front of it. `SearchService.stats()` says "Caching is a
later card". This is that card, and known issue 36 is its debt.

Measured before planning, as `app_user` inside `withOrg`, `EXPLAIN (ANALYZE, BUFFERS)`:

| org | conversations | plan | execution |
|---|---|---|---|
| 150 (tail) | 2,631 | Bitmap Heap Scan via `messages_org_tsv_idx`, 3,253 blocks read | 32.8 / 35.1ms |
| 2 (mid) | 111,112 | Parallel Bitmap Heap Scan, 2 workers, 121,098 blocks read | 1,351.8 / 1,308.8ms |
| 1 (whale) | 1,000,000 | Seq scan of the whole heap (drill 17) | 2.3–3.2s |

Org 150 is the card's scenario to the millisecond: a ~35ms recompute behind a key read 500
times a second. Org 2 is the buckle: a recompute longer than the pool's 2s connection timeout.

The pool is `max: 10` with a 2s `connectionTimeoutMillis`. A stampede can never put more than
ten duplicates into Postgres at once. The rest queue in Node, already past the cache check.

## Decisions

1. **The hot key is `stats:v1:org:<id>`** in front of `SearchService.stats()`. The value is an
   envelope `{ stats, computedAt, freshUntil }`. Freshness is `Date.now() < freshUntil`, on
   every arm. The Redis TTL is only garbage collection. One envelope on every arm lets the
   instrument force an expiry the same way on every arm: rewrite `freshUntil` to 0 with
   `KEEPTTL`. The arms then differ in one variable: what a request does with an expired key.
2. **Four arms on `STATS_CACHE`**, read once at module load:
   - `off` — Postgres every request. Drill 17's slow widget, kept so its measurements reproduce.
   - `naive` — cache-aside. Every request that finds the key expired recomputes. The stampede.
   - `wait` — single-flight, block-and-wait. One request takes a Redis lock and recomputes. The
     others poll the key every 25ms and serve the new value. Give up after 5s with a 503.
   - `stale` — single-flight, serve-stale. The lock winner serves the expired value and
     recomputes in the background. Everyone else serves the expired value. A key with nothing
     in it (cold) falls back to `wait`.
   Default: decided by the measurements. Predicted `stale`.
3. **The lock is `SET lock:stats:v1:org:<id> <uuid> NX EX 10`, released by a Lua
   compare-and-delete.** `RedisService.setIfAbsent` already is the acquire. A new
   `delIfEquals(key, value)` runs `if GET == token then DEL`. The token check stops a holder
   whose lock expired from deleting the next holder's lock. The lock TTL (10s) exceeds any
   recompute measured (whale 3.2s). This is an efficiency lock, not a correctness lock: a lost
   lock costs one duplicate query and never a wrong answer. No Redlock and no fencing token.
   Redis 8.10 has a native `DELEX key IFEQ value`. The Lua script stays for portability (Valkey,
   managed Redis on older versions). The guide mentions both.
4. **Double-checked locking.** A request that wins the lock re-reads the key before
   recomputing. Without it, a request that read "expired" just before the previous holder
   filled the key wins the next lock and recomputes a fresh value. That is a duplicate per
   expiry under load.
5. **TTL jitter only shortens: `ttl × (1 − STATS_TTL_JITTER × random())`.** Drill 19's enduring
   constraint is that the TTL is the worst-case staleness bound. Jitter that adds would break
   the bound. Cost: the mean TTL drops by `jitter/2`, so recomputes rise by the same share.
   `STATS_TTL_S` default 30. `STATS_TTL_JITTER` default decided by the measurements, predicted
   0.2. The stale arm keeps the key in Redis for `10 × ttl` so a stale copy outlives its
   freshness.
6. **Redis errors fail closed for stats: 503.** Falling back to Postgres turns every request
   into a recompute, which is a permanent stampede. The widget already renders a failed fetch
   as a degraded widget (`fetchOrgStats` returns a value, drill 17). Entitlements keep failing
   open: their read is a cheap PK probe. The stretch measures both.
7. **`Cache-Control: no-cache` on the request bypasses the stats cache.** Source `bypass`: it
   runs the query and writes nothing. The frontend's `?cache=nostore` arm sends it, so
   `nostore` keeps meaning "no cache at any layer" and drill 17's streaming test and `ui:paint`
   still see a slow widget. It is a cache-busting vector, recorded beside known issue 20. A
   public API or CDN MUST ignore it.
8. **A cached answer carries `x-served-at = computedAt`.** Drill 18's frontend predicate is "an
   answer that predates the question came from a cache". A backend-cached answer does predate
   it, so the widget's "Ns old" stays true across both cache layers.
9. **Reporting.** `x-stats-cache: hit|miss|wait|stale|refresh|db|bypass`. `refresh` marks the
   stale arm's winner: it served stale and started the recompute. Recomputes started =
   `miss + refresh + db + bypass`. `/metrics` gains `stats_cache_lookups_total{result}` (adds
   `timeout` and `error`) and `stats_recomputes_total`.

## What ships

**`src/search/search.service.ts`** — arm/TTL/jitter constants, the envelope, `stats(orgId,
bypass)` returning `{ stats, source, computedAt }`, the wait loop, the background refresh, and
module-level counters with `statsCacheMetrics()`.

**Edits to existing files**
- `src/search/search.controller.ts` — reads `cache-control`, sets `x-stats-cache` and
  `x-served-at` (`@Res({ passthrough: true })`). The budget comment says a hit costs 0.
- `src/redis/redis.service.ts` — `delIfEquals(key, value)` (Lua); `set()` switches `EX` to `PX`
  so a jittered TTL keeps millisecond precision (callers still pass seconds).
- `src/entitlements/entitlements.controller.ts` — `/metrics` appends `statsCacheMetrics()`.
- `src/info/info.controller.ts` — `arms.statsCache`, `arms.statsTtlS`, `arms.statsTtlJitter`.
- `apps/frontend/lib/api.ts` — a `no-store` fetch sends `cache-control: no-cache`.
- `test/arms.e2e-spec.ts` (three keys), `test/search.e2e-spec.ts` ("exactly one statement"
  becomes "a cold key costs one, a hit costs none").
- `docker-compose.yml`, `.env.example`, root `package.json` (`db:stampede`, `db:test:stampede`,
  `db:test:statswait`, `db:test:nojitter`), `scripts/measure.ts` catalog, `check:arms` green.

**Test — `test/stats-cache.e2e-spec.ts`** (fixture org with messages; `app.listen(0)`)
1. Cold key, 30 concurrent requests → exactly one recompute (`/metrics` delta and headers).
   Red on `naive`.
2. Forced expiry, 30 concurrent → one recompute. `stale`: 1 `refresh` + 29 `stale`, all with the
   old `computedAt`, then a `hit` with the new one. `wait`: 1 `miss` + 29 `wait`, identical
   bodies. Expectations follow `process.env.STATS_CACHE`. Red on `naive`.
3. `delIfEquals` leaves another holder's lock alone and deletes its own.
4. Twenty cold keys: every fresh window in `[ttl × (1 − jitter), ttl]` and spread wider than a
   quarter of the jitter band. Red on `STATS_TTL_JITTER=0`.
5. `cache-control: no-cache` → `bypass`, one statement, on a key that is fresh.
6. A hit's `x-served-at` predates the request.

**Instrument — `apps/backend/db/stampede.mts`, `pnpm db:stampede <sub>`**, in the container.
Load generator, sampler and the forced expiry share one process and one clock. k6 cannot read
Postgres or write Redis without extensions, and the graph needs all three on one timeline.
- `run` — open-model load at RATE req/s on one org for SECONDS; pre-warm the key; force the
  expiry at EXPIRE_AT. Every BUCKET_MS: `pg_stat_statements` calls of the stats statement
  (completions), `pg_stat_activity` active duplicates (in flight), the entitlement statement's
  calls, and per bucket of *sent* requests: count, errors, p50/p99, sources. Prints an ASCII
  graph and N three ways (pgss, `/metrics`, client `miss+refresh`). Writes `series.json`.
  In-flight capped at 2,000 (counted as dropped, the k6 `dropped_iterations` idea).
- `herd` — load round-robin over ORGS (a range); delete every one of their keys at FLUSH_AT
  (a Redis restart or a key-version bump); graph DB calls per bucket over several TTLs; print
  each key's remaining freshness at the end as a histogram.
- Refuses to run without `pg_stat_statements` loaded.

## Predictions, recorded before measuring

1. `naive`, org 150, 500 req/s: N ≈ 500 × the miss window. Uncontended that is ~20. Ten
   concurrent duplicates stretch each recompute, so **N lands at 40–80**. In-flight pins at 10
   (the pool). p99 in the expiry second rises 3–5× over steady state.
2. `wait` and `stale`: **N = 1** on every round. `wait` adds ~35–60ms to ~20 requests. `stale`
   adds nothing to anyone and serves ~20 requests the old value.
3. `naive`, org 2, 100 req/s: the miss window outlasts the pool's 2s connection timeout, so the
   outage shows as 5xx and **pgss N stays near the pool size (10–30)**. The pool protects
   Postgres by failing the users.
4. `herd`, 100 tail orgs, TTL 10s, jitter 0: after the flush, a spike of ~100 recomputes repeats
   every 10s. The pool drain spreads it ~0.5s and it barely decays. Jitter 0.5: the second
   cycle's peak per bucket drops ≥3× and the remaining-freshness histogram spans ~5s.
   Single-flight changes nothing here: 100 keys are 100 flights.
5. pgss N, `/metrics` recomputes and client `miss+refresh` agree exactly on every run.

## Measurement

Every compose / `pnpm db:*` call from the worktree carries `COMPOSE_PROJECT_NAME=drills`.
`PG_PRELOAD=pg_stat_statements` on `postgres_db` for the session, restored afterwards.

- DONE WHEN: `run` on org 150, RATE 500, SECONDS 40, EXPIRE_AT 20, `STATS_TTL_S=300` (only the
  forced expiry lands in the window). Arms `naive`, `wait`, `stale` × 3 rounds, interleaved,
  `nest_server` recreated for every run.
- The buckle: `run` on org 2, RATE 100, `naive` and the shipped arm, one round each.
- Jitter: `herd` over orgs 11–110, RATE 500, SECONDS 60, FLUSH_AT 5, `STATS_TTL_S=10`,
  `STATS_TTL_JITTER` 0 and 0.5, two rounds each, on the shipped arm.
- `pnpm db:test` green; `db:test:stampede` and `db:test:nojitter` red with counts recorded;
  `db:test:statswait` green; `pnpm test:ui` green.
- Stretch: `docker compose stop redis_cache` during a `run`, `start` 15s later. Record status
  codes and `x-entitlement`/`x-stats-cache` sources per bucket.

## Guide

`drills/20-cache-stampede.md` in the main checkout (gitignored; drafted in the worktree and
copied). ELI5. "If you read nothing else" carries the two DB-QPS graphs (Mermaid `xychart-beta`)
and a timeline of one expiry on each arm. The card's three questions: how many duplicates and
how they were counted; serve-stale vs block-and-wait and what each costs the user; what TTL
jitter prevents. The stretch. Every command with its result. Tech stack cheat sheet.
`Is this production ready?`, `Honest gaps`, `What I'd do differently at 10x` (in-process
single-flight in front of the lock, probabilistic early refresh, entitlements on the same
mechanism, a circuit breaker on Redis, warming instead of a cold herd).

## Workflow

1. Plan file and `planned` history row; commit.
2. Implement in commits: Redis + service + controller + tests → frontend header → instrument.
3. Measure; record results here.
4. Guide.
5. `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm check:arms`.
6. Memory bank: verified facts written, judgment calls proposed; history row → `implemented`.
7. PR, then the `drill/20` release tagged on the branch before the merge.
