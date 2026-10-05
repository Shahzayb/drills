# Drill 21 — Rate limit accurately at the burst boundary

**Status:** planned

Card 21. Prereq 19. Branch `drill-21`.

## Context

Drill 19 shipped a per-plan ingest limiter for API-key traffic: a fixed window anchored at the
first hit (`MULTI INCR / EXPIRE NX / PTTL`, `RedisService.incrWindow`), failing open. Known
issue 51 records its debt: a 2× burst across the window boundary.

Two facts from reading the code shape the drill:

1. **Drill 19's window is already atomic.** It increments first and checks the returned count.
   Every request gets a unique count, so exactly `L` pass. The card's "check-then-increment"
   bug needs a GET → compare → SET implementation. This drill builds that arm on purpose.
2. **A token bucket cannot be INCR-first.** Its refill depends on elapsed time, so it must read
   state, compute, and write. That read-compute-write is the thing only Lua (or WATCH + retry)
   makes atomic in Redis. This is the card's real lesson.

`ApiKeyGuard` runs a Postgres lookup before the limiter on every request, a 429 included. It
staggers arrivals at the limiter and caps how much a race shows through HTTP.

## Decisions

1. **Four arms on `RATE_LIMIT`, a 2×2 of algorithm × atomicity.** Read once at module load.
   - `fixed` — drill 19's INCR-first window. Atomic. The boundary bug.
   - `fixed-rmw` — GET `{count, resetAt}`, compare, SET. The card's naive limiter. Both bugs.
   - `bucket-rmw` — token bucket with state read into Node, computed, written back. The
     concurrency bug alone.
   - `bucket` — token bucket in one Lua script. Shipped default.
2. **Bucket parameters: burst `B = L`, refill `r = L / 60` per second**, where `L` is
   `plan_limits.ingest_per_minute` (free 60 → 1/s, basic 600 → 10/s, pro unlimited). `B = L`
   keeps the advertised policy identical to drill 19, so the algorithm is the only variable.
   Caveat for the guide: over any 60s span the bucket still admits up to `2L` (`B` at once, then
   `L` spread out). The bucket bounds the instantaneous burst at `L`. The fixed window allows `2L`
   in two seconds. A strict "L per any 60s" needs a sliding log, or a smaller `B`.
3. **The contract every arm is scored against: `admitted ≤ B + r·T`** over an attack span `T`.
   This is what "L per minute, bursts up to L" means. Error = `admitted / (B + r·T) − 1`.
4. **The Lua script reads the clock from Redis (`TIME`)**, so every app replica shares one clock
   (card 24). `bucket-rmw` uses `Date.now()` (one process; noted as a gap). State is a hash
   `{tokens, ts}`; `PEXPIRE` = time until full, so an expired key equals a full bucket.
   Called with `EVAL` like `delIfEquals`; `EVALSHA`/Functions go in the guide.
5. **Keys `rl:v2:ingest:<arm>:org:<id>`.** The value shape differs per arm. `entitle.mts` and
   the drill 19 test switch to the exported key function.
6. **Headers: IETF draft-11 (`draft-ietf-httpapi-ratelimit-headers`, not yet an RFC)** on every
   metered response, replacing `x-ratelimit-limit/remaining`:
   - `RateLimit-Policy: "ingest";q=<L>;w=60`
   - `RateLimit: "ingest";r=<remaining>;t=<seconds>` — fixed: until the window resets; bucket:
     until the bucket is full.
   - 429 adds `Retry-After` — fixed: window remainder; bucket: seconds until one token.
7. **Fails open stays** (drill 19, measured in drill 20). Not re-measured.

## What ships

**Edits**
- `src/redis/redis.service.ts` — `takeToken(key, capacity, perSecond)`: the Lua bucket, returns
  `{ allowed, tokens, fullMs, retryMs }`. Existing `get`/`set` serve both rmw arms.
- `src/entitlements/entitlements.service.ts` — `RATE_LIMIT` arm constant, `rateLimitKey()`,
  `consumeIngest()` dispatches on the arm and returns one `Decision { limit, allowed, remaining,
  resetS, retryAfterS }`. New counter `ingest_rate_limit_allowed_total` beside
  `ingest_rate_limited_total`.
- `src/entitlements/entitlements.interceptor.ts` — writes the headers from `Decision`.
- `src/info/info.controller.ts` + `test/arms.e2e-spec.ts` — `arms.rateLimit`.
- `test/entitlements.e2e-spec.ts` — the upgrade test loops to the first 429 with an arm-agnostic
  bound (`60 ≤ admitted ≤ 60 + ⌈r·elapsed⌉`) and asserts the new headers.
- `db/entitle.mts` — uses the new key shape.
- `docker-compose.yml`, `.env.example`, root `package.json` (`db:ratelimit`, `db:test:fixed`,
  `db:test:fixedrmw`, `db:test:bucketrmw`), `scripts/measure.ts` catalog; `check:arms` green.

**Test — `test/rate-limit.e2e-spec.ts`** (free-plan fixture org, `L = 60`)
1. *Concurrent:* 200 `consumeIngest()` calls at once on a fresh key → admitted within
   `[60, 60 + ⌈r·T⌉]`. Red on both rmw arms (every GET pipelines ahead of every SET on the one
   ioredis socket).
2. *Boundary:* 60 sequential calls exhaust the limit. For fixed arms, `PEXPIRE key 1` moves the
   window to its end (expiry is a fixed window's only clock). 60 more sequential calls →
   admitted `≤ ⌈r·T⌉ + 1`. Red on both fixed arms.
3. *Headers:* policy and `RateLimit` on a 201; `Retry-After` on a 429.
Predicted red counts: `fixed` 1, `fixed-rmw` 2, `bucket-rmw` 1.

**Instrument — `apps/backend/db/ratelimit.mts`, `pnpm db:ratelimit <sub>`**, in the container.
Mints a `basic` org + key per round (`L = 600`, so one token is 0.17% and "<1%" is resolvable),
cleans its rows in `finally` (the `entitle.mts` pattern). Cross-checks client-counted admits
against the `/metrics` delta.
- `boundary` — an opener request at t=0, then a burst of `BURST` (default `L`) at `t = 60s −
  GAP_MS` and another at `60s + GAP_MS` (default 1000). Reports admitted per burst, `T`, the
  contract, and the error.
- `concurrent` — `N` (default 2000) requests at once on a fresh key. Reports admitted, contract,
  error, 5xx, and `x-entitlement` sources. `COLD=1` deletes the entitlement key first (stretch).

## Predictions, recorded before measuring

1. Boundary (`L = 600`, `T ≈ 2.3s`, contract ≈ 623): `fixed` admits 1,199 → **+92%**.
   `bucket` lands within **±1%**. `bucket-rmw` over-admits in burst 2. `fixed-rmw` ≈ `fixed`.
2. Concurrent (`N = 2000`): `fixed` exactly 600, `bucket` within 1% of `600 + r·T`. Both rmw
   arms over-admit **+10–100% through HTTP** (the guard's Postgres lookup staggers arrivals);
   the in-process test admits all 200 of 200.
3. Stretch: a cold entitlement key under `N = 2000` costs **10–50 Postgres reads**, not 1
   (misses are not coalesced, known issue 54).

## Measurement

Every compose / `pnpm db:*` call from the worktree carries `COMPOSE_PROJECT_NAME=drills`.
`RATE_LIMIT=<arm> docker compose up -d nest_server` per arm, arms interleaved.
- DONE WHEN table: 4 arms × {`boundary` 2 rounds, `concurrent` 3 rounds}.
- Stretch: `concurrent COLD=1` on `bucket`, 3 rounds.
- `pnpm db:test` green; the three red runs with their counts; `pnpm test:ui` green.

## Write-up and guide

Plan `Results` + `Write-up` sections answer the card: why Lua and not MULTI/EXEC or a pipeline
(no read inside MULTI; WATCH is per-connection and retries; a pipeline is not atomic); refill
rate, burst size and the headers; what Durable Objects gave for free (one single-threaded
instance per key, in-memory state, one clock).
`drills/21-rate-limit-burst-boundary.md` (gitignored; drafted in the worktree, copied to the
main checkout). ELI5, a timeline diagram of both attacks per arm, the 2×2 grid, every command
with its result, a tech stack cheat sheet, and `Is this production ready?`, `Honest gaps`,
`What I'd do differently at 10x`.

## Workflow

1. Plan file + `planned` history row; commit.
2. Implement in commits: Redis + service + interceptor + tests → instrument and wiring.
3. Measure; record results in the plan.
4. Guide; README row.
5. `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm check:arms`.
6. Memory bank: verified facts written (issue 51, techContext limiter paragraph, red counts),
   judgment calls proposed; history row → `implemented`.
7. PR, then the `drill/21` release (0.21.0) tagged on the branch before the merge.

## Verification

- `pnpm db:test` green on `bucket`; `db:test:fixed` / `:fixedrmw` / `:bucketrmw` fail exactly the
  predicted tests.
- `pnpm arms` reports `rateLimit` for each arm before each measurement.
- `curl -i` an ingest with a minted key shows `RateLimit-Policy`, `RateLimit` and, on 429,
  `Retry-After`.
- The instrument's client counts match the `/metrics` delta on every run.
