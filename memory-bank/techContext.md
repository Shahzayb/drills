# Tech Context

## Architecture

pnpm workspace monorepo (`apps/*`, `packages/*`) orchestrated by Turborepo. `packages/` is empty.

- `apps/backend` — NestJS (TypeScript), port `3002`. Jest for unit + e2e.
- `apps/frontend` — Next.js 16 (App Router, React 19, Tailwind v4), port `3001`. No test runner yet.
- Postgres 18 and Redis 8, alpine images, alongside both apps under Docker Compose.

Two `@Global()` chokepoint modules, one per data store, and the client stays private in both. `src/postgres` owns the `pg` `Pool`; **every read goes through its `query()`** so later drills have one place to hook timing, tracing and pool metrics. `src/redis` owns the ioredis client and grows a method per command as drills need them. No ORM: the schema is hand-written SQL run by node-pg-migrate. Two things about it are decisions, not oversights — **every tenant-owned row carries `org_id` directly**, so tenant scoping never needs a join, and several indexes are deliberately missing. Reasoning for both in `plans/2026-08-07_drill-02-schema-and-migrations.md`.

`GET /health` probes both through those same clients (`SELECT 1`, `PING`) and answers 200, or 503 with per-dependency detail. `GET /info` reads Postgres `version()`/`now()` and is what the web page displays.

`GET /conversations` is the first real feature endpoint: one org's conversations, `LIMIT`/`OFFSET`, no joins, sorted `<sort> DESC, id DESC`. Naive by instruction — cards 08, 09 and 10 each break one part of it, so read `plans/2026-08-09_drill-03-conversation-list.md` before "improving" it. Three things about it are decisions: **tenant identity arrives as an `X-Org-Id` header** through `src/tenancy/org-id.decorator.ts` (the seam auth replaces, kept out of the query DTO on purpose), the **`id DESC` tiebreaker is correctness not polish** (offset paging over a non-unique sort key drops and repeats rows), and **`sort` is an allowlist map** because `ORDER BY` cannot take a bind parameter.

`src/observability` owns request correlation. One id (`x-request-id`) is generated or accepted at the Next edge and reaches every layer: a functional middleware derives it, sets the response header and enters an `AsyncLocalStorage`; a `LoggingInterceptor` adds the controller/handler/org line; `PostgresService.query()` prepends it to the SQL as `/* rid=… */`. Both apps log structured JSON through pino, and every line carries `time`/`level`/`svc`/`msg`/`rid` with `durMs` and `status` named the same way whichever layer wrote it. `info` is one line per request per service, `debug` is the inside of one; `LOG_LEVEL` is per-service in `docker-compose.yml` and reads the shell first. `pnpm logs:trace <id>` is the reconstruction. Full reasoning and the field set in `plans/2026-08-13_drill-06-request-id-propagation.md`.

Input validation is a `ValidationPipe` registered as an **`APP_PIPE` provider in `AppModule`**, not `app.useGlobalPipes()` in `main.ts` — `main.ts` never executes under `Test.createTestingModule`, so a pipe installed there is absent from every e2e test and the tests would validate a different app than the one that ships. Same reasoning applies to `APP_GUARD`/`APP_INTERCEPTOR`/`APP_FILTER`.

The frontend reaches the API at `BACKEND_INTERNAL_URL` (`http://nest_server:3002`) from `app/page.tsx` and `app/conversations/page.tsx`, both server components. The service name resolves only on the Compose network, so those fetches cannot move to a client component without switching to the published host port. `app/conversations` ships **zero application JavaScript** — no `"use client"`, plain `<a>` rather than `next/link`, no `loading.tsx` — so the server render is provable with `curl`. `app/health` is web liveness — 200 whenever Next serves, reporting API reachability without failing on it, so one outage doesn't turn three services red.

## Commands

Docker is how the stack runs: `pnpm run setup` first time, then `docker:up` / `docker:down` / `docker:logs` / `docker:rebuild`, plus `docker:reset` to wipe volumes and rebuild from zero. Running the backend outside a container is not a supported path — nothing loads `.env` into a host process, so it would silently use the code's fallback credentials. The root `db:*` scripts exec into a container for that same reason; `db:seed` truncates before it inserts.

Seeding is `apps/backend/db/seed.mjs`, plain Node ESM, not SQL — `seed.sql` was retired in drill 04.

- `db:seed` — 200 orgs, 1,200 users, 2.5M conversations, 10M messages. ~110s, ~3.3GB of relations.
- `db:seed:ci` — the same shape at `--scale=0.1`. Org and user counts do not scale, so the skew stays testable.
- `db:reset` — drop schema, migrate, seed. ~1:52 from empty.
- `db:bench` — `COPY` vs `INSERT` loop, and faker-per-row vs the template corpus.
- Fixed RNG seed: two runs produce byte-identical data. `--scale` is the only flag — the per-lever switches (`--naive`, `--no-txn`, `--keep-indexes`, `--no-tuning`, `--keep-fks`) were removed in the 2026-08-12 simplification once the attribution was settled. The numbers live in drill 04's A–F table; re-measuring would mean rewriting the flags.

Load testing is k6 in a container on the Compose network, under the `test` profile:
`ORG_ID=150 pnpm load:baseline` runs one measurement, parameterised by `ORG_ID`/`VUS`/
`WARMUP`/`DURATION`/`P95_BUDGET_MS`. `k6/run-baseline.mjs` reads them from the host env, defaults
them to match `conversations-baseline.js`, and forwards them into the container as `-e NAME=value`
— it also needs `VUS` and `DURATION` itself, because the report filename is built from them. It
runs any script in `k6/` (`node k6/run-baseline.mjs other.js`, trailing args go to `k6 run`); a
script that ignores those env vars is simply unaffected by them. The
`k6` service in `docker-compose.yml` stays a plain runner with no environment of its own, so a run
is fully described by the command that started it. There is
no sweep script — the method (vacuum, settle, 3 runs per
org in a fixed order) is written down in `plans/2026-08-13_drill-05-load-test-baseline.md` and run
by hand, which means the vacuum and the run order are now yours to remember, and the six-run
table lives in that plan file rather than in any generated artifact. The one file a run leaves is
`k6/reports/<yyyy-mm-dd-hhmmss>-<script>-org<id>-vus<n>-<duration>.html`, k6's own dashboard —
timestamped because runs are only comparable within one sitting, and because a timestamp cannot
collide the way a hand-chosen run label could — which is also why there is no `RUN` parameter any
more; it only ever decorated console output. k6 skips the export on runs of a few seconds, so a
smoke test leaves nothing behind.

Observability commands: `pnpm logs:trace <rid>` reconstructs one request across all services
(`docker compose logs --no-color --no-log-prefix -t | sort | grep` — the prefix is dropped so
Docker's timestamp leads and `sort` can merge three streams). `db:log:on` / `db:log:off` /
`db:log:status` toggle Postgres statement logging at runtime, off by default so drill 05's
instrument is unchanged. `db:activity` shows `pg_stat_activity`, which is the zero-config proof
that the `/* rid= */` comment is on the wire.

Formatting is root Prettier: `pnpm format` / `format:check`. It resolves config **per file,
nearest-wins**, so `apps/backend` keeps its own `.prettierrc` and both apps' ESLint configs are
untouched — backend's only formatting rule *is* `prettier/prettier`, reading the same config, so
the two cannot disagree. `.prettierignore` excludes `*.md` (prose here is hand-wrapped, and
Prettier pads Markdown tables to a uniform width, turning a one-row append to `history.md` into
a whole-table diff) and `k6/reports`, which is machine-written.

Root, via Turborepo: `pnpm dev` / `build` / `lint` / `test`, plus `dev:backend`, `dev:frontend`. For single-app work, run from that app's directory — skips turbo's overhead. Backend adds `start:dev`, `test:cov`, `test:e2e`; one file with `pnpm exec jest <path>`, by name with `-t`.

## Constraints and gotchas

- Ports are split deliberately (3001 frontend / 3002 backend) so both run without collision.
- **Connection numbers are chosen, not defaulted**, postgres pool `max: 10`, `connectionTimeoutMillis: 2000`, `idleTimeoutMillis: 30000`, ioredis `commandTimeout: 2000`, `maxRetriesPerRequest: 1`.
- **`lazyConnect: true` and `enableOfflineQueue: false` can't be combined on ioredis.** With the offline queue off, commands are rejected whenever status isn't `ready`, and a lazy client starts in `wait` — the first `ping()` would reject without ever connecting. `lazyConnect` is what keeps the Jest suites from opening sockets at module init.
- **A new dependency needs `docker:rebuild`, not `up --build`.** `/app/node_modules` is an anonymous volume Compose carries over on recreate; only `--renew-anon-volumes` refreshes it. Symptom: `Cannot find module` from an image that visibly contains it.
- **Postgres settings live in `command:` on `postgres_db`, never `POSTGRES_INITDB_ARGS`.** The latter only runs at `initdb`, so on an existing volume it silently does nothing. Current flags: `shared_buffers=128MB` (small on purpose, so cache misses stay visible in `EXPLAIN (ANALYZE, BUFFERS)`), `wal_level=minimal`, `max_wal_senders=0`, `max_wal_size=2GB`, `checkpoint_timeout=30min`.
- **`wal_level=minimal` blocks streaming replication and PITR.** It is set so the seed can skip WAL for a table truncated and refilled in one transaction. Any replica drill starts by changing it back to `replica` and restarting.
- **`pg_settings.context` is the map for changing a setting:** `postmaster` = restart, `sighup` = reload, `user` = session `SET`. `shared_buffers`/`wal_level` are the first; `maintenance_work_mem`/`synchronous_commit` are the last.
- **Foreign keys are checked per row during `COPY`.** `messages_conversation_id_fkey` alone was 40% of the messages load. The seeder drops it and re-adds with `NOT VALID` + `VALIDATE CONSTRAINT`.
- **Dropping indexes for a bulk load only pays if `maintenance_work_mem` is raised too.** At the 64MB default the rebuild costs more than it saves; at 512MB it is 7.5x faster because the sort stays in memory.
- **The seeder's generator is not the bottleneck; don't optimise it without measuring.** `Readable.from(gen).pipe(copyStream)` is pull-based — Postgres ingests messages at ~137k rows/s while the generator produces at ~2M/s, so it sits suspended at its `yield` for most of the load. Six hand-tuned hot paths were measured after shipping: caching the date half of a timestamp, pre-splitting templates and a byte→hex table were worth 9.7s; a hand-rolled date formatter, byte-by-byte uuid writes and a custom hash function were worth 0.12s and were reverted. Numbers in `plans/2026-08-11_drill-04-bulk-seed.md`.
- **`ANALYZE` and `VACUUM` do different jobs, and benchmarks right after a seed measure the wrong one.** `ANALYZE` gives the planner statistics; only `VACUUM` sets the visibility map, and index-only scans are illegal without it. `count(*)` on `conversations` is a 60ms seq scan immediately after seeding and a 27ms index-only scan once vacuumed.
- **`pg` returns `bigint` (int8) as a string**, including `count(*)`. Ids stay strings out to the JSON; counts get cast.
- **Query params are always strings**, so a numeric DTO field needs `@Type(() => Number)` or `@IsInt()` rejects every request. Per-field, not `enableImplicitConversion`.
- **`@Headers()` accepts no pipes in Nest 11** — validating a header needs a custom `createParamDecorator`.
- **New folders make the editor's ESLint server go stale.** Type-aware rules hold their own TS program, so a file added mid-session resolves to the `error` type. Tell: CLI clean, editor red, only `no-unsafe-*` firing. Restart the ESLint server.
- Next.js 16 differs from training data. Read `apps/frontend/AGENTS.md`, don't guess.
- Next 16 does **not** cache `fetch` by default, and `cacheComponents` is off here on purpose — drill 10 is about caching.
- `params`/`searchParams` are Promises and must be awaited. `PageProps<'/route'>` / `LayoutProps<'/'>` are globally available generated types, written during `next dev`/`next build`.
- `apps/frontend/AGENTS.md` is regenerated by `next dev` and loaded via `apps/frontend/CLAUDE.md`. Commit it.
- `.npmrc` sets `auto-install-peers` and `strict-peer-dependencies=false` to absorb the two apps' differing dependency trees.
- `.mcp.json` (checked in) wires the Context7 MCP server locally via `npx -y @upstash/context7-mcp` (stdio) so any Claude Code session opened in this repo gets up-to-date library docs on request — ask for "... use context7" when a prompt needs current API docs instead of training-data guesses.
- `.mcp.json` also wires the k6 MCP server via `docker run --rm -i grafana/mcp-k6` (stdio) — load-test scripting/validation/execution and k6 docs lookup, image pulled on first use. `k6/` at repo root holds the scripts it runs. Note the MCP's k6 is **not** on the Compose network, so it can validate a script but cannot reach `nest_server`; real runs go through `docker compose run k6`.
- **The k6 image is pinned (`grafana/k6:2.1.0`), and that is load-bearing.** A baseline is only comparable to a re-run of itself; `:latest` swaps the instrument between the `before` and the `after` without saying so.
- **k6 will not compute a tagged sub-metric unless a threshold names it.** `http_req_duration{scenario:measure}` is `undefined` in `handleSummary` without a threshold on that exact string — which is why the script carries two thresholds that can never fail (`max>=0`, `count>0`). They look like dead code and are the mechanism the warm-up exclusion depends on.
- **k6's default summary stops at p(95).** p99 needs an explicit `summaryTrendStats`.
- **k6's built-in web dashboard is the reporting worth using** (`K6_WEB_DASHBOARD=true` + `K6_WEB_DASHBOARD_EXPORT=<path>.html`): a self-contained HTML of the run as a *time series* per scenario, which the end-of-test summary structurally cannot show. Three traps: **k6 does not create the output directory** (it fails at the end of the run, after all the work); **the report needs a run longer than 3x `K6_WEB_DASHBOARD_PERIOD`** (default `10s`, so under ~30s you get `report generation was skipped (not enough data)` and no file at all); and that same period is the graph resolution, so the default gives only ~8 points across an 80s run — `K6_WEB_DASHBOARD_PERIOD=2s` is what makes the curves readable.
- **A k6 counter's `rate` is divided by the whole run duration, warm-up included.** Throughput for a measured phase is `count / measuredSeconds` or it is understated — 25% here.
- **`Promise.all` of two queries takes two pool connections per request.** `pool.query()` acquires and releases per call, so `GET /conversations` wants 2 of the pool's 10 per in-flight request — oversubscribed 2:1 at 10 VUs. **Confirmed in drill 06**, not inference any more: with statement logging on, the two queries of one request are logged by two different Postgres backend PIDs.
- **A suppressed log line still evaluates its arguments.** `logger.debug({ sql: summarise(text) }, …)` runs `summarise` at every level, including `silent`. Guard with `logger.isLevelEnabled()`; in an interceptor, bail before returning the `tap()` chain at all. Worth ~6% of tail-org throughput here.
- **pino-http logs every 5xx at `info` unless `customLogLevel` is set** — `grep '"level":"error"'` would never find a server error. Its attached `err` on a Nest 500 is also synthetic, since the exception filter has already handled the real one before `res.on('finish')`.
- **`customProps` is applied twice** — when the per-request child logger is created and again at response time — so anything in it that changes mid-request (the status) emits a **duplicate JSON key with two values**. `rid` belongs there; `status` does not.
- **nestjs-pino's `exclude` also removes the request context**, so lines written during that request lose their `rid`. `pinoHttp.autoLogging.ignore` suppresses only the automatic line. Also note the frontend's `/health` calls the API's `/info`, so silencing only `/health` leaves the noisier probe.
- **`ALTER SYSTEM` persists in the data volume across restarts.** `pnpm db:log:on` survives a `docker compose down`, which would silently poison the next load test. `pnpm db:log:status` exists to check rather than assume; `-1` is off.
- **`forRoutes('*')` is fine on Nest 11** despite Express 5's path-to-regexp rejecting unnamed wildcards: `LegacyRouteConverter` rewrites it to `{*path}` and suppresses the warning for the all-routes case specifically.
- **`LoggerModule` is `@Global()`** — registering it anywhere but `AppModule` registers its middleware twice and logs every request twice. Nest orders global-module middleware first, so nestjs-pino's `genReqId` always runs before our own middleware.
- **Next 16 renamed `middleware.ts` to `proxy.ts`** (export `proxy`, Node runtime by default). `NextResponse.next({ request: { headers } })` is what the *app* sees via `headers()`; `next({ headers })` is what the *browser* sees — they are different things.
- **`after()` may only call request APIs inside its callback in Route Handlers and Server Functions**, not Server Components — read the id first and close over it. Timing inside the callback is deliberate: it is the only way `page_render` covers the flush rather than just the data fetch.
