# Tech Context

Current architecture and durable constraints. Numbers and reasoning live in the linked plan;
`history.md` indexes every plan with its result.

## Stack

pnpm workspace under Turborepo; `packages/` is empty.

- `apps/backend` — NestJS 11, port 3002, Jest e2e only (no unit tests).
- `apps/frontend` — Next.js 16 App Router, React 19, Tailwind v4, port 3001. Playwright runs on
  the host against the running container. `perf/` holds `pnpm ui:paint`.
- Postgres 18 and Redis 8 (alpine) under Docker Compose.
- No ORM. Migrations are hand-written SQL in `pgm.sql()`; node-pg-migrate only orders, records and
  wraps them. Every tenant-owned row carries `org_id` directly. Several indexes are missing on
  purpose (`messages.org_id` above all).

## Architecture

**Chokepoints.** `src/postgres` owns the `pg` Pool (`max: 10`, 2s connect timeout); every statement
goes through `query()` or `withClient()`, and `listen()` opens a dedicated LISTEN client.
`src/redis` owns the ioredis client (2s command timeout, one retry, `lazyConnect`) and grows one
method per command. Both are `@Global()`. ESLint forbids importing `PostgresService` outside
`tenancy/`, `postgres/`, `health/`, `info/`, `ingest/api-key.guard.ts` and
`entitlements/entitlements.service.ts`.

**Tenancy (drill 07).** Every table with `org_id` has RLS and one `FOR ALL … USING … WITH CHECK`
policy on `app_current_org()`, a `STABLE PARALLEL SAFE` function reading transaction-local
`app.org_id`. `TenantDb.withOrg()` is the only way to set it (`BEGIN` → `set_config(…, true)` →
callback → `COMMIT`), and it takes an isolation level and a jittered retry loop. The API serves as
`POSTGRES_APP_USER`, never the owner; `PostgresService` throws without it. Identity is the
`X-Org-Id` stub (`@OrgId()`). `POST /ingest` derives it instead: `ApiKeyGuard` hashes the bearer
key and calls SECURITY DEFINER `app_org_for_api_key()`, and `X-Org-Id` is ignored there.
`organizations` (the tenant registry) and `users` (no `org_id`) have no policy by decision.

**Enhancers.** Pipes, guards, interceptors and filters are `APP_*` providers in `AppModule`,
never `main.ts`, which e2e tests never run. Global interceptors run in registration order:
`LoggingInterceptor`, then `EntitlementsInterceptor`.

**Observability (drills 06, 08).** One `x-request-id` (allowlisted `^[A-Za-z0-9_-]{8,64}$`) threads
browser → Next → Nest via `AsyncLocalStorage`, and rides into Postgres as a trailing
`/* rid=… */` comment. All logs are pino JSON with `rid`. The request context counts `queries`
(checked by `@QueryBudget`, default 5, declared on controller handlers) and `roundTrips`;
`QUERY_COUNTER=off|on|header`. OpenTelemetry is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set;
with it on, `trace_id` joins the logs and the rid comment stands down for sqlcommenter.

**Conversations (drills 03, 08–10, 14, 16).** `GET /conversations` sorts `<sort> DESC, id DESC`
(the `id` tiebreak is correctness), filters on `status`/`updatedFrom`/`updatedTo` through one
`filtersFor` shared by page and count, and pages by `paging=offset` (default, with `count(*)`) or
`keyset` (opaque base64url cursor with a query-shape fingerprint; replay under another shape is a
400; no count). `LIST_STRATEGY=batched|naive`. Index `(org_id, updated_at DESC, id DESC)` leaves
`status` out on purpose. The `/conversations/:id*` endpoints have no org filter; RLS alone scopes
them. `conversations.version` is bumped by every write; `POST /conversations/:id/assign`
(`ASSIGN=optimistic|pessimistic|lww`, `@HttpCode(200)`) answers 409 with the current row.
`last_message_at` is NOT NULL and not in the `sort` allowlist.

**Search (drills 11, 17).** `messages.tsv` is a generated column indexed by
`gin (org_id, tsv)` through btree_gin. `GET /messages/search` (`SEARCH_STRATEGY=fts|like`) is its
own route so a search term never enters the list cursor's fingerprint. `GET /messages/stats` is one
aggregate and slow on the whale by design. The GIN index is reachable only because migration 007
marks `ts_match_vq` LEAKPROOF.

**Ingest (drills 12, 13, 16).** One conversation, its first message and a ledger row per event, in
one `withOrg` transaction. Idempotency is a partial unique index `(org_id, provider_event_id)
WHERE provider_event_id IS NOT NULL` plus an optional Redis SETNX guard
(`IDEMPOTENCY=none|constraint|redis|both`, `ON_CONFLICT=update|nothing`). `usage_counters` is
incremented atomically (`QUOTA=rmw|atomic|locking|serializable`); `usage_events` is the
append-only ledger it can be checked against. Retry-on-40001 is safe only because the write is
idempotent. `usage_counters.quota_limit` is stored and never enforced.

**Import (drill 15).** `POST /imports` takes raw `text/csv` (Nest parses only json/urlencoded), spools
to `/tmp/imports/<jobId>.csv` and answers 202. The worker is `pipeline(createReadStream, csv-parse,
batching Writable)`; backpressure is the awaited `flush()` in `_write`. Each batch is one
transaction whose third statement writes progress. `resume_row` (committed) is trusted; `rows_read`
(parsed) is not. Imported rows reuse `provider_event_id` as `import:<external_id>`.
`IMPORT=stream|buffer`, `IMPORT_BATCH_ROWS`, `IMPORT_ON_FAIL=resume|restart`.

**Frontend (drills 03, 10, 14, 17, 18).** Server Components reach the API at `BACKEND_INTERNAL_URL`
(Compose network only). `/conversations` is server-rendered; `conversation-list.tsx` is its one
client component (load-more via a Route Handler, `useOptimistic` claims, a local filter), and
`?mode=offset` is the JS-free path. The page starts `fetchOrgStats()` before awaiting the list and
streams the widget in one `<Suspense>` (`?stats=stream|blocking|off`). Fetches cache per
`?cache=nostore|cached|tagged|blanket` (default `tagged`): the tag scheme lives in `lib/api.ts`
and `tagsAfterWrite()` is its one home; Server Actions call `updateTag`, and
`POST /api/revalidate` expires tags for writes outside them. Cache-eligible fetches send no
`x-request-id`. Stats revalidate every 60s. `served` is computed from the API's `x-served-at`.
`/imports` is zero-JS with a meta refresh only while a job runs; uploads go through a Route
Handler because a Server Action body is buffered and capped at 1MB.

**Entitlements (drill 19).** `EntitlementsInterceptor` resolves `organizations ⋈ plan_limits` on
every request that names an org (API-key org, else a valid `X-Org-Id`), caching it in Redis as
`ent:v1:org:<id>` for `ENTITLEMENT_TTL_S` (30); `v1` versions the value's shape and unknown orgs
are cached as `{plan:null}`. `ENTITLEMENT_CACHE=off|ttl|invalidate|notify`, default `notify`: the
trigger from migration `1790121900000` sends `pg_notify('entitlements', id)` on a plan change and
a LISTEN client (`application_name = listen:entitlements`, reconnect after 1s, no flush on
reconnect) deletes the key. `PUT /entitlements/plan` commits, then deletes. Only API-key traffic
is rate-limited (`plan_limits.ingest_per_minute`, a fixed window via `MULTI INCR / EXPIRE NX /
PTTL`; pro is NULL = unlimited). The read runs with `{ counted: false }`, so `@QueryBudget` does
not see it; `x-entitlement: hit|miss|db|error` and `GET /metrics` (Prometheus counters) do.

## Instruments and commands

- **No transpiler.** Node strips types and k6 2.1.0 transpiles its own. `scripts/*.ts` run on the
  host (root is `type: module`); `apps/backend/db/*.mts` run in the container (that package has
  no `type`, so a `.ts` there would be CommonJS); `k6/*.ts`. Imports carry the real extension;
  erasable syntax only. `pnpm typecheck` runs two configs, and the backend tsconfigs exclude `db`.
- **Runners.** `scripts/measure.ts` runs `db/*.mts` in the container from one knob catalog that
  generates the `-e` flags; `db/lib/run.mts` prints each knob as `(env)` or `(default)` and writes
  `apps/backend/db/reports/<run>/`. `scripts/load.ts` runs k6 (`grafana/k6:2.1.0`, pinned) on the
  Compose network; the method lives once in `k6/lib/scenario.ts`, and a k6 script's basename never
  changes because ~60 report directories embed it. `pnpm check:arms` fails when a knob or arm
  switch cannot reach its reader; `pnpm arms` asks the running API what it resolved.
- **Instruments.** `db:explain`, `db:paging`, `db:search`, `db:storm`, `db:quota`, `db:claim`,
  `db:import`, `db:schema` (its `backfill` is a real operation between migrations 015 and 016),
  `db:entitle`, `db:bench`; `pnpm load list|search|write|ingest|page`; `pnpm ui:paint`. Each has
  `--help`; each plan documents its own.
- **Observability.** `db:stats:on|stats|stats:reset` (`pg_stat_statements`), `db:log:on|off|status`,
  `db:activity`, `logs:trace <rid>`, `trace:on|off` (collector + Jaeger under the `trace` profile).
- **Stack.** `pnpm docker:up`; `docker:rebuild` after a dependency change (`/app/node_modules` is an
  anonymous volume); `docker:up:prod` for anything browser-side. `db:seed` builds 200 orgs,
  2.5M conversations and 10M messages from a fixed RNG: org 1 is the whale (1M conversations,
  `pro`), org 150 the tail (2,631 conversations, `basic`). `db:reset` drops and rebuilds.
- **Formatting.** Root Prettier; `.prettierignore` skips `*.md` and `k6/reports`.

## Constraints and gotchas

**Environment**

- `docker compose exec` forwards no caller env, and `up` forwards only names in `environment:`.
  An unset `-e VAR` arrives as `''`, so knobs are read with `||`. Every switch is declared in
  compose.
- `docker compose up` reconciles the whole project: repeat every non-default var (`PG_PRELOAD`,
  `PG_MAX_CONNECTIONS`) on every call or Postgres is recreated back to defaults.
- A worktree is its own Compose project; `COMPOSE_PROJECT_NAME=drills` reuses the seeded volume
  with the worktree's bind mounts. Two stacks cannot run at once.
- `up --force-recreate` wipes the container's `/tmp`; `restart` does not.
- `nest start --watch` does not restart a process the V8 heap limit killed.
- V8's default heap is half the cgroup limit; `os.totalmem()` reports the host. A V8 crash writes
  a GC trace; a cgroup OOM is a silent SIGKILL. `memory.current` includes page cache.
- The e2e suite runs on Redis DB 1 (`REDIS_DB=1` in `test:e2e`): the dev server's NOTIFY listener
  deletes entitlement keys on DB 0 for every plan change in the database.
- node-pg-migrate echoes every statement, the app role's password included.
- A measurement switch needs a test that fails when it stops switching.

**Postgres configuration**

- Settings live in `command:` on `postgres_db`, never `POSTGRES_INITDB_ARGS`. `shared_buffers=128MB`
  is small on purpose; `wal_level=minimal` rules out replicas and logical decoding.
- `shared_preload_libraries` needs a recreate (`PG_PRELOAD=pg_stat_statements`); `ALTER SYSTEM`
  persists in the volume across `down`.
- `pnpm db:reset` keeps roles (cluster objects); migration 003 guards `CREATE ROLE`.
- A table with an FK to `organizations` must join `seed.mts`'s TRUNCATE list or the seed fails
  with 0A000.

**RLS**

- Superusers, BYPASSRLS roles and the owner (no FORCE here, by design) bypass policies silently;
  `check:tenancy` asserts all three.
- A transaction-local GUC reverts to `''`, so `app_current_org()` uses `nullif`.
  `set_config(…, true)` outside an explicit `BEGIN` is gone before the next statement.
- An unmarked SQL function is PARALLEL UNSAFE; used in a policy it serialises every query on the
  table (2.4× on the whale).
- RLS blocks index paths for non-leakproof operators. Only `@@` is fixed, and LEAKPROOF does not
  survive `pg_dump`/restore or a major upgrade.
- Inside the scope `count(*)` counts one tenant, and `pg_stats` is empty for non-owners.
- SECURITY DEFINER needs `SET search_path = pg_catalog, public`. `app_user` has no SELECT on
  `api_keys`: a WHERE or RETURNING is `permission denied`, a filterless DELETE in `withOrg` works.

**Writes, locks and migrations**

- `ON CONFLICT` on a partial index repeats its predicate (else 42P10). `DO NOTHING` and
  `DO UPDATE` both wait on a concurrent inserter; at READ COMMITTED the follow-up SELECT finds the
  row. At RR/SERIALIZABLE they raise 40001, and so does `used = used + 1`.
- `xmax = 0` separates an insert from `DO UPDATE` (an implementation detail a test asserts).
- A duplicate storm must keep duplicates adjacent; shuffled, it passes on every arm.
- A lock is released at COMMIT, and node-pg-migrate wraps a migration in one transaction. Mixing
  ACCESS EXCLUSIVE with a long scan needs `pgm.noTransaction()`.
- A waiting ACCESS EXCLUSIVE blocks everything queued behind it. Migration 016 sets
  `lock_timeout = '3s'`; nothing enforces it on later migrations.
- `ADD COLUMN … DEFAULT <non-volatile>` is catalog-only and stamps one value on every existing row
  (`now()` included). Set the default in a separate statement.
- `ADD CONSTRAINT … NOT NULL col NOT VALID` is PG 18; earlier versions need a CHECK proxy.
  `NOT VALID` still enforces new writes.
- CIC waits on real xids (an idle-in-transaction writer parks it forever), and a cancelled build
  leaves `indisvalid = false`.
- `WHERE col IS NULL LIMIT n` batching re-walks from the start; use a keyset cursor. The batch
  size can flip the plan (a seq scan at 100k rows). A backfill is an operation, not a migration.
- A Bind message counts parameters in uint16; past 65,535 the count wraps and the error names a
  wrong number.
- From Node, batched INSERT (~1,000 rows) beats `COPY FROM STDIN`; a per-row loop loses to both.
  The seed drops and re-adds FKs (`NOT VALID` + `VALIDATE`) and raises `maintenance_work_mem`.

**Query plans and pagination**

- Only `VACUUM` sets the visibility map; index-only scans need it.
- An optional equality column between the tenant key and the sort key makes the index useless for
  every query that omits it.
- `LIMIT` plus an index-served `ORDER BY` makes selectivity irrelevant. Without it the flip is
  Seq Scan → Bitmap Heap Scan (~9% of this table).
- The planner multiplies correlated predicates as if independent; no extended statistics exist.
- DDL is transactional: price an index with `SAVEPOINT` → `CREATE INDEX` → `EXPLAIN` → rollback.
- OFFSET is a Limit-node argument; the scan below still emits every skipped row.
- `a < $k OR (a = $k AND b < $i)` becomes a Filter; `(a, b) < ($k, $i)` is an Index Cond.
- `pg` returns `timestamptz` as a millisecond `Date`, so keyset keys stay in SQL (`to_char`).
  Keyset survives insert-shift and breaks on a moving sort key (`updateStatus()` bumps
  `updated_at`).
- btree_gin's `int8_ops` has no cross-type operators: in psql write `org_id = 150::bigint`.
- `to_tsvector(regconfig, text)` is the IMMUTABLE form. A stored generated column rewrites the
  table under ACCESS EXCLUSIVE.
- `pg` returns `bigint` and `numeric` as strings; `Number()` caps them at 2^53.

**Caching**

- Next 16 caches no `fetch` by default; `cacheComponents` stays off. Headers are in the fetch cache
  key (only `traceparent`/`tracestate` stripped). `updateTag`, `revalidateTag`, `revalidatePath` and
  `refresh()` set one flag and the last call wins; `revalidateTag(tag, 'max')` skips the action's
  own re-render. A Server Action's re-render reads the data cache.
- Back/forward reuses the router entry unless a Server Action ran in that browser since.
- Redis cache-aside: commit, then `DEL`. The TTL is the only worst-case bound on every arm: a direct
  DB write, a lost NOTIFY and the fill race all wait it out.
- `NOTIFY` is sent at COMMIT to sessions listening at that moment, with no replay. A full notify
  queue (`max_notify_queue_pages`) fails every NOTIFY-ing commit.
- Hit ratio follows per-tenant request rate × TTL; a TTL's database cost is active tenants ÷ TTL.
- Nest runs global guards before controller guards, so code that needs `ApiKeyGuard`'s org is an
  interceptor.

**Measurement**

- Interleave A/B arms in one sitting and restart every arm alike. Treat a cross-sitting delta under
  ~15% (20% on the tail) as unproven.
- A concurrent k6 run and an isolated `EXPLAIN (ANALYZE, BUFFERS)` can disagree; BUFFERS separates
  fast from cached.
- `pg_stat_statements` strips comments (the rid comment does not fragment rows); the statement log
  echoes each statement three times.
- `Promise.all` of two pool queries takes two connections per request.
- k6: `http_req_failed.passes` counts failures; `handleSummary` replaces k6's summary; a closed
  model cannot show an outage (`dropped_iterations` exists only for arrival-rate executors); a
  tagged sub-metric needs a threshold; a counter's `rate` includes warm-up; p99 needs
  `summaryTrendStats`.

**Nest, Next and logging**

- Query params are strings (`@Type(() => Number)`). A type in a decorated parameter needs
  `import type`. `@Res()` without `passthrough` stops serialisation. `@Post()` answers 201.
  supertest needs `app.listen(0)` for concurrent requests. `@Headers()` takes no pipes.
- A suppressed pino line still evaluates its arguments (guard with `isLevelEnabled`). pino-http
  logs 5xx at info without `customLogLevel`; `customProps` runs twice; `LoggerModule` registers once.
- `import './tracing'` is `main.ts`'s first line. Next needs the OTel packages in
  `serverExternalPackages` and never injects `traceparent`, so `lib/api.ts` does. Next runs
  `proxy.ts` in its own trace.
- Next 16 differs from training data: read `apps/frontend/AGENTS.md`. `proxy.ts` replaced
  middleware; `params`/`searchParams` are Promises; everything awaited in a page body is in the
  shell; a streaming test needs `waitUntil: 'commit'`; bytes are measured on the production build.
- `[data-status]` collides with Next's dev overlay.
- A new folder can stale the editor's ESLint server. pnpm 11 needs
  `allowBuilds: { protobufjs: false }` for `install --frozen-lockfile`.
