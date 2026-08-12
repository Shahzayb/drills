# Tech Context

## Architecture

pnpm workspace monorepo (`apps/*`, `packages/*`) orchestrated by Turborepo. `packages/` is empty.

- `apps/backend` — NestJS (TypeScript), port `3002`. Jest for unit + e2e.
- `apps/frontend` — Next.js 16 (App Router, React 19, Tailwind v4), port `3001`. No test runner yet.
- Postgres 18 and Redis 8, alpine images, alongside both apps under Docker Compose.

Two `@Global()` chokepoint modules, one per data store, and the client stays private in both. `src/postgres` owns the `pg` `Pool`; **every read goes through its `query()`** so later drills have one place to hook timing, tracing and pool metrics. `src/redis` owns the ioredis client and grows a method per command as drills need them. No ORM: the schema is hand-written SQL run by node-pg-migrate. Two things about it are decisions, not oversights — **every tenant-owned row carries `org_id` directly**, so tenant scoping never needs a join, and several indexes are deliberately missing. Reasoning for both in `plans/2026-08-07_drill-02-schema-and-migrations.md`.

`GET /health` probes both through those same clients (`SELECT 1`, `PING`) and answers 200, or 503 with per-dependency detail. `GET /info` reads Postgres `version()`/`now()` and is what the web page displays.

`GET /conversations` is the first real feature endpoint: one org's conversations, `LIMIT`/`OFFSET`, no joins, sorted `<sort> DESC, id DESC`. Naive by instruction — cards 08, 09 and 10 each break one part of it, so read `plans/2026-08-09_drill-03-conversation-list.md` before "improving" it. Three things about it are decisions: **tenant identity arrives as an `X-Org-Id` header** through `src/tenancy/org-id.decorator.ts` (the seam auth replaces, kept out of the query DTO on purpose), the **`id DESC` tiebreaker is correctness not polish** (offset paging over a non-unique sort key drops and repeats rows), and **`sort` is an allowlist map** because `ORDER BY` cannot take a bind parameter.

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
