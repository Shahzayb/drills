# Drill 19 — Cache entitlements, then prove the invalidation

**Status:** shipped

Card 19. Prereq 13. Branch `drill-19`.

## Context

No request reads the org's plan today. `organizations.plan` exists
(`free|basic|pro`, CHECK-constrained, migration 001) and nothing uses it; `usage_counters.quota_limit`
exists and nothing enforces it (known issue 11). The drill adds the entitlement read to every
org-scoped request, puts a Redis cache in front of it, and then measures the staleness window
for the two ways a plan can change: through the API (explicit invalidation) and straight in
Postgres (an admin tool that knows nothing about the cache).

Seed facts that shape the design: org 1 is `pro`. Org 150 is `free` or `basic` (random). Test
fixture orgs are `pro`, with a few `free` "other org" rows. `db:storm fire`, `db:quota fire` and
`pnpm load ingest` all hit org 1.

## Decisions

1. **Entitlements = `organizations.plan` joined to a new `plan_limits` table.** One limit column,
   `ingest_per_minute` (NULL = unlimited). Rows: free 60, basic 600, pro NULL. FK from
   `organizations.plan` to `plan_limits(plan)`; the CHECK stays (schema spec asserts its name).
   One statement: `SELECT o.plan, l.ingest_per_minute FROM organizations o JOIN plan_limits l
   USING (plan) WHERE o.id = $1`. No RLS needed: `plan_limits` has no `org_id`, and
   `organizations` is the tenant registry (known issue 4).
2. **The read runs on every org-scoped request, in a global `EntitlementsInterceptor`.** An
   interceptor and not a guard because global guards run before `ApiKeyGuard`, so a guard cannot
   see the ingest route's org. Org = `request[API_KEY_ORG]` ?? a valid `X-Org-Id` ?? skip. Result
   is attached to the request and reported as `x-entitlement: hit|miss|db|error`.
3. **Enforcement is a per-plan rate limit on API-key traffic only.** Rule, not a route list: a
   request authenticated by an API key is metered; a first-party `X-Org-Id` request is not. This
   keeps card 05's profile (`GET /conversations`, org 150 at ~3,000 req/s) free of 429s, and pro =
   unlimited keeps every existing storm/quota instrument and test green. Fixed window anchored at
   the first hit: `MULTI INCR rl:v1:ingest:org:<id>` / `EXPIRE … 60 NX` / `PTTL`. 429 carries
   `retry-after`, `x-ratelimit-limit`, `x-ratelimit-remaining`. Redis error → fail open, counted.
4. **Four arms on `ENTITLEMENT_CACHE`, default `invalidate`:**
   - `off` — Postgres on every request. The before arm.
   - `ttl` — cache-aside with TTL, no invalidation on plan change. The reproduced bug.
   - `invalidate` — TTL plus `DEL` after the plan-change commit. Shipped.
   - `notify` — stretch. `invalidate` plus a Postgres trigger → `pg_notify` → a listener in the
     API that `DEL`s the key. Covers out-of-band writes. No flush on reconnect, deliberately, so
     the new failure mode is measurable.
5. **Key design:** `ent:v1:org:<id>`, value JSON `{plan, ingestPerMinute, loadedAt}`, `SET … EX`.
   One string, not a hash: one command sets value and TTL atomically. `v1` is the value-shape
   version so a deploy that changes the shape never reads the old one. Unknown org is
   negative-cached (`{plan:null}`) with the same TTL to stop per-request DB reads for bogus ids.
6. **TTL `ENTITLEMENT_TTL_S`, default 30.** Prediction, to be defended or changed by the numbers:
   with explicit invalidation the TTL bounds only out-of-band writes and fill races, and 200 orgs
   at one read per 30s is ~7 PK probes/s. Test suite runs at `ENTITLEMENT_TTL_S=2` so the
   out-of-band test waits ≤2s; the bound is "≤ TTL", proven at 2 and measured at 30.
7. **The entitlement read is NOT counted in `queries`.** `@QueryBudget` is a per-route N+1
   contract and ~6 specs assert exact `x-query-count`; a 2s-TTL miss would make them flake. The
   read still counts as a round trip, and `x-entitlement` + `/metrics` + `pg_stat_statements`
   report it. `PostgresService.query()` gains an optional `{ counted: false }`.
8. **Hit ratio is exposed as counters on `GET /metrics`** (Prometheus text, hand-written, no
   new dependency): `entitlement_lookups_total{result}`, `entitlement_invalidations_total{source}`,
   `ingest_rate_limited_total`. Ratio = Δhit / Δ(hit+miss+error) over a window, the PromQL shape.
9. **Plan change goes through `PUT /entitlements/plan {plan}`** (X-Org-Id stub): `UPDATE
   organizations SET plan, updated_at` → commit → `DEL` (not before: a delete before the commit
   lets a concurrent reader refill the old value).

## What ships

**Migrations** (`apps/backend/migrations/`)
- `…_plan-limits.js` — table, three rows, FK, `GRANT SELECT` to app_user.
- `…_entitlements-notify.js` (stretch) — `app_notify_entitlements()` trigger function, `AFTER
  UPDATE OF plan ON organizations FOR EACH ROW WHEN (OLD.plan IS DISTINCT FROM NEW.plan)`,
  `pg_notify('entitlements', NEW.id::text)`. `plan_limits` edits are not covered (TTL-bounded,
  documented).

**`src/entitlements/`** — new module, imported by `AppModule`
- `entitlements.service.ts` — arm/TTL constants (read once at module load, the repo pattern),
  `get(orgId)`, `invalidate(orgId, source)`, `setPlan(orgId, plan)`, `consumeIngest(orgId, ent)`,
  counters. On `notify`, `onModuleInit` starts the listener with reconnect + backoff.
- `entitlements.interceptor.ts` — registered as `APP_INTERCEPTOR` after `LoggingInterceptor`.
- `entitlements.controller.ts` — `GET /entitlements` (what this request resolved, with source
  and `ageMs`), `PUT /entitlements/plan`, `GET /metrics`.

**Edits to existing files**
- `src/redis/redis.service.ts` — `incrWindow(key, ttlS)` (MULTI INCR/EXPIRE NX/PTTL). `get`/`set`/
  `del` already exist.
- `src/postgres/postgres.service.ts` — `{ counted }` option; `listen(channel, onMessage)` for the
  stretch (dedicated client; keeps the pool private).
- `src/tenancy/org-id.decorator.ts` — export the org-id regex for the interceptor.
- `src/info/info.controller.ts` — `arms.entitlementCache`, `arms.entitlementTtlS`.
- `src/app.module.ts` — module + interceptor registration.
- `test/arms.e2e-spec.ts` — the exact `toEqual` grows two keys.
- `docker-compose.yml` (`ENTITLEMENT_CACHE`, `ENTITLEMENT_TTL_S`), `.env.example`,
  `apps/backend/package.json` (`ENTITLEMENT_TTL_S=2` in `test:e2e`), root `package.json`
  (`db:entitle`, `db:test:nocache`, `db:test:ttlonly`, `db:test:invalidate`), `scripts/measure.ts`
  catalog, `pnpm check:arms` green.

**Test — `test/entitlements.e2e-spec.ts`** (fixture: one `free` org + API key)
1. First lookup `miss`, second `hit`. Red on `off`.
2. API plan change → the next request shows the new plan, source `miss`. Red on `ttl`.
3. The card's scenario: 60 ingests 201, 61st 429 with `retry-after`; `PUT` pro; next ingest 201.
   Red on `ttl`.
4. Out-of-band `UPDATE organizations` → stale immediately, fresh within the arm's bound
   (`invalidate`/`ttl`: TTL + 500ms; `notify`: 500ms; `off`: 0). Logs the measured staleness.
5. `/metrics` deltas equal the lookups the test made (1 miss, 3 hits).
6. Unknown org id: second lookup is a `hit` (negative cache).

**Instrument — `apps/backend/db/entitle.mts`, `pnpm db:entitle <sub>`**
- `oob` — ROUNDS × (warm key, random wait in [0,TTL), owner `UPDATE`, poll `GET /entitlements`
  every POLL_MS until it flips). Prints PTTL-at-write (the prediction) beside measured staleness.
- `upgrade` — the customer's view: free org + key, ingest at RATE req/s, trip the limit, upgrade by
  PATH=`api|oob`, count 429s after the upgrade and time to first 201.
- `race` — the cache-aside fill race with a chosen interleaving (reader reads old → writer
  commits + DEL → reader SETs old), then asserts the real API serves the old plan. Exits 1 if not.
- `ratio` — hit ratio vs per-org request rate at the running TTL, from `x-entitlement` headers,
  printed against `1 − 1/(R·T + 1)`.
- `metrics` — prints `/metrics` and the delta since the last snapshot (bracket a k6 run with it).
- `lost` (stretch, `notify` arm) — `pg_terminate_backend` the listener, write during the gap,
  measure staleness.

## Predictions, recorded before measuring

1. `off`: 1.00 entitlement DB reads/request. `invalidate` under card 05's profile: hit ratio
   >99% on both orgs; misses per TTL expiry ≈1 on the whale, 3–6 on the tail (concurrent VUs miss
   together until the first fill lands).
2. Latency: whale unchanged within noise. Tail: `off` vs `invalidate` within ~10% — the cache
   swaps a Postgres round trip for a Redis one. The win is Postgres load, not latency.
3. Out-of-band staleness uniform in [0, TTL]: median ~15s, max ≤ 30s + POLL_MS; each round's PTTL
   predicts its staleness within ±POLL_MS.
4. API path: zero stale requests on `invalidate`; stale for the key's PTTL on `ttl`.
5. `upgrade` OOB: 429s continue for ≈PTTL, count ≈ RATE × PTTL. API path: none.
6. `race`: API serves the old plan until the planted key expires, despite the DEL.
7. `notify`: OOB staleness < one poll (50ms). `lost`: back to ≈PTTL.
8. `ratio`: a quiet org (1 req/10s) at TTL 30 sits near 75% — hit ratio is rate × TTL, and card
   05's single hot org makes the 95% target easy.

## Measurement

Docker Desktop is not running; start it first. Every compose / `pnpm db:*` call from the worktree
carries `COMPOSE_PROJECT_NAME=drills` (seeded volume, this tree's bind mounts). New migrations
apply to that shared volume.

- DONE WHEN 1–2: `PG_PRELOAD=pg_stat_statements`; per arm (`off`, `invalidate`) × org (1, 150) ×
  3 rounds interleaved, each arm restarted every round: `pnpm db:entitle metrics` →
  `pnpm load list --org <n> --name ent-<arm>` → `pnpm db:entitle metrics`, plus `pnpm db:stats`
  calls for the entitlement statement.
- DONE WHEN 3: `pnpm db:test` green; red runs `db:test:nocache`, `db:test:ttlonly` (failure
  counts recorded); `db:test:invalidate` green.
- DONE WHEN 4: `pnpm db:entitle oob --rounds 10`, `upgrade --path oob|api`, `race`; stretch `lost`.
- `ratio` at 0.1 / 1 / 10 req/s.
- Every command and its output goes into the plan's Results section and the guide.

## Guide

`/Users/imsha/Programming/drills/drills/19-entitlement-cache-invalidation.md` — in the main
checkout, because `drills/` is gitignored. Same rule for other ignored artifacts: k6
`dashboard.html`/`run.json` get copied to the matching `k6/reports/<run>/` in main before the
worktree goes. ELI5; a timeline diagram of the staleness window (API vs OOB vs notify vs race) in
"If you read nothing else"; the write-up answers (TTL trade, OOB acceptable vs not → pick,
Cloudflare KV comparison — KV facts verified against Cloudflare docs at write time, the stretch's
new failure mode); every command with its result and how to reproduce it; Tech stack cheat sheet;
`Is this production ready?`; `Honest gaps` (fixed-window burst, Redis-down 2s timeout, stampede
not coalesced, fill race, `plan_limits` edits TTL-bounded, API-key lookup still uncached — issue 9);
`What I'd do differently at 10x` (L1 in-process cache, versioned/leased fills, CDC/outbox instead of
NOTIFY, flush-on-reconnect, GCRA limiter in Lua).

## Workflow

1. `git switch -c drill-19`; write the plan file; `planned` row in `memory-bank/history.md`; commit.
2. Implement in commits: migration + module + tests → instrument → stretch.
3. Measure; record results in the plan.
4. Guide in main's `drills/`.
5. `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm check:arms`.
6. Memory bank: verified facts to `techContext.md`/`progress.md`, history row → `implemented`;
   judgment calls proposed first.
7. Not in this pass unless asked: push, PR, `drill/19` release.

## Results

Measured 2026-09-23, one sitting, dev server, seeded volume. Org 150 is `basic` in the seed.

### DONE WHEN 1–2 — hit ratio and DB reads per request, card 05's profile

`pnpm load list`, 10 VUs, 20s warm-up, 60s measured, 3 interleaved rounds, both arms restarted
every round, `pg_stat_statements` reset before each run. `/metrics` deltas count the warm-up too.

| org | arm | DB reads / request | hit ratio | pgss calls / run | p50 (median) | req/s (median) |
|---|---|---|---|---|---|---|
| 1 | `off` | 1.00000 ×3 | — | 23,172 · 23,059 · 22,964 | 34.26ms | 286.55 |
| 1 | `invalidate` | 0.00031 · 0.00031 · 0.00035 | 99.969 · 99.969 · 99.965% | 7 · 7 · 8 | 35.08ms | 281.28 |
| 150 | `off` | 1.00000 ×3 | — | 144,336 · 146,482 · 146,768 | 5.31ms | 1,831.63 |
| 150 | `invalidate` | 0.00009 · 0.00006 · 0.00005 | 99.991 · 99.994 · 99.995% | 14 · 9 · 8 | 5.14ms | 1,888.48 |

`pg_stat_statements` calls equal `/metrics` (miss + db) on every run. The statement costs
0.012–0.027ms. Reports: `k6/reports/2026-09-23-21*-ent-*` and
`apps/backend/db/reports/2026-09-23-16*-ent-*-entitle-metrics`. `off`/org 150 reads 109,898
measured requests in rounds 2 and 3: distinct runs (lookups 146,482 vs 146,768, different p50s).

### DONE WHEN 3 — the test

`pnpm db:test` 147/147 (141 → 147). `pnpm db:test:nocache` fails **1** (the hit assertion:
`db` for `miss`). `pnpm db:test:ttlonly` fails **2** (the API plan change reads `free`; the
post-upgrade ingest is 429). The `notify` arm was 147/147 with the out-of-band test inside 500ms,
and after the default flip below `pnpm db:test:invalidate` is 147/147.

### DONE WHEN 4 — the out-of-band window, TTL 30s

| run | result |
|---|---|
| `oob --rounds 10`, `invalidate` | 3,993 / 16,887 / 25,692ms min/median/max; staleness − PTTL ≤ 60ms (poll 50ms) |
| `upgrade --via oob`, `invalidate` | 189 × 429 after the upgrade, first 2xx at 19,006ms; PTTL 18,995ms |
| `upgrade --via api`, `invalidate` | 0 × 429, first 2xx at 98ms |
| `upgrade --via api`, `ttl` | 189 × 429, first 2xx at 18,993ms; PTTL 18,989ms |
| `race`, `invalidate` / `notify` | stale 30,022ms / 30,036ms after the DEL |
| `ratio` 0.1 / 1 / 10 req/s | 70.0 / 96.7 / 99.7%, 3 misses each (periodic model 60.0 / 95.6 / 99.6%) |
| `oob --rounds 5`, `notify` | 9 / 10 / 12ms, 0 stale reads |
| `upgrade --via oob`, `notify` | 0 × 429, first 2xx at 103ms |
| `lost --rounds 3`, `notify` | listener up 10–11ms; killed 24,371 / 16,187 / 17,226ms against PTTL 24,302 / 16,145 / 17,162 |

Reports: `apps/backend/db/reports/2026-09-23-17*-{invalidate,ttl,notify}-entitle-*`.

### Predictions

1. Right on 1.00 and >99%. Half right on misses per expiry: not isolated; 7–8 per run on the
   whale implies ~2–3 per fill, because ten VUs start together against an empty key.
2. Right: whale p50 +2.4%, tail −3.2%.
3. Right: PTTL predicts staleness within one poll plus a request.
4. Right. 5. Right: 189 against 10 × 18.995. 6. Right. 7. Right.
8. Close: 70.0% against 75%. The 75% is the random-arrival model; evenly spaced requests land
   60–70% depending on where the TTL boundary falls.

### Divergences from the plan

- `ENTITLEMENT_TTL_S=2` is fixed in `test:e2e`, not defaulted, so a TTL set for a measurement
  never leaks into the suite.
- `src/entitlements/entitlements.service.ts` joins the `no-restricted-imports` exemptions in
  `eslint.config.mjs`: it reads `organizations` and `plan_limits`, neither of which is tenant data.
- `ratio` prints the finite-run periodic prediction `1 − ⌈N / ⌈R·T⌉⌉ / N` beside the Poisson one.
- The listener lives in `PostgresService.listen()` with `application_name = 'listen:<channel>'`,
  which is what `db:entitle lost` terminates.
- **The default is `notify`, flipped after the measurements.** It cut the typical out-of-band
  window from up to 30s to 9–12ms and left the worst case unchanged. `db:test:notify` became
  `db:test:invalidate`.
- **The flip exposed shared-Redis interference.** The dev server's listener deleted keys the
  e2e process had filled, so `db:test:invalidate` failed its "first read is stale" assertion.
  `test:e2e` now sets `REDIS_DB=1`; `RedisService` reads `REDIS_DB` (default 0).
- The guide was drafted in the worktree's gitignored `drills/` and copied to main: a harness hook
  blocks direct writes to the main checkout.

## Write-up

The card's three questions and the stretch are answered in the drill 19 guide, with every
command above.
