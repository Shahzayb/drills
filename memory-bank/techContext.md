# Tech Context

## Architecture

pnpm workspace monorepo (`apps/*`, `packages/*`) under Turborepo. `packages/` is empty.

- `apps/backend` — NestJS (TypeScript), port `3002`. Jest for unit + e2e.
- `apps/frontend` — Next.js 16 (App Router, React 19, Tailwind v4), port `3001`. Playwright since drill 14, host-run against the container (`pnpm test:ui`), covering the assign conflict and nothing else.
- Postgres 18 and Redis 8, alpine, alongside both apps under Docker Compose.

Two `@Global()` chokepoint modules, one per data store, client private in both. `src/postgres` owns the `pg` `Pool`; every read goes through its `query()`, so later drills have one place to hook timing/tracing/pool metrics. `src/redis` owns the ioredis client and grows a method per command. No ORM: hand-written SQL run by node-pg-migrate. Every tenant-owned row carries `org_id` directly; several indexes are deliberately missing. Reasoning: `plans/2026-08-07_drill-02-schema-and-migrations.md`.

`GET /health` probes both stores through those clients (`SELECT 1`, `PING`), 200 or 503 with per-dependency detail. `GET /info` reads Postgres `version()`/`now()` and reports the resolved A/B arms.

`GET /conversations` — one org's conversations, `<sort> DESC, id DESC`, with optional `status`/`updatedFrom`/`updatedTo` filters (half-open: `>= from`, `< to`). Two paging arms behind `paging=offset|keyset`, **`offset` still the default** so drill 05's baseline URL keeps measuring the same thing. Offset is `LIMIT`/`OFFSET` + `count(*)`; keyset is `(sort_col, id) < ($k, $i)` with `LIMIT pageSize + 1` and **no count** (returns `nextCursor`/`hasMore`, no `total`). Still no cache — read `plans/2026-08-09_drill-03-conversation-list.md` before "improving" it. Three decisions: tenant identity arrives as `X-Org-Id` (`src/tenancy/org-id.decorator.ts`, the seam auth replaces); the `id DESC` tiebreaker is correctness, not taste (offset paging over a non-unique sort key drops and repeats rows without it); `sort` is an allowlist map, since `ORDER BY` cannot take a bind parameter.

`ConversationsService.list()` dispatches on `LIST_STRATEGY` (`naive`|`batched`, default `batched`). `naive` runs one query per row for assignee name and tags; `batched` joins the assignee (`LEFT JOIN memberships … LEFT JOIN users`) and fetches tags once per page via `conversation_tags.conversation_id = ANY($1::uuid[])`, skipped on an empty page. `naive` is a permanent measurement arm, not scaffolding — it is what keeps the A/B and `pnpm db:test:naive`'s red case working. `get()`/`updateStatus()`/`remove()` intentionally return the narrower `ConversationSummary` (no `assigneeName`/`tags`); their SQL was not touched. Numbers: `plans/2026-08-17_drill-08-n-plus-one.md`.

Drill 09's filter WHERE is built once by `ConversationsService.filtersFor` and used by the page query *and* the count query — filtering the page but not the count is the silent bug that shape exists to prevent, and an e2e case asserts `total` shrinks. Migration 005 adds `conversations_org_updated_idx (org_id, updated_at DESC, id DESC)` (118MB, 60% of the 198MB heap), built `CONCURRENTLY`. **`status` is deliberately NOT in the key** — see "equality columns before range columns" below. Numbers and the rejected indexes: `plans/2026-08-25_drill-09-index-selectivity.md`.

Drill 10's cursor is **opaque**: `base64url(JSON)` of `{v, k, i, f}` — version, the sort key as *Postgres* rendered it, the id, and a query-shape fingerprint (`sort|status|from|to`). Replaying a cursor under a different sort or filter is a 400, not silently wrong rows; a cursor sent with `paging=offset` is a 400 too, checked in `list()` rather than by `@ValidateIf`. It is an encoding, **not** a signature — anyone can decode and edit it, and RLS plus the explicit `org_id` filter are what keep that inside one tenant. `KEYSET_TIEBREAK=off` drops `id` from the row comparison. Numbers: `plans/2026-08-26_drill-10-keyset-pagination.md`.

Drill 11 adds full-text search over `messages`. `messages.tsv` is a `tsvector` **generated column** (`to_tsvector('english', message)`, the two-argument form), indexed by `messages_org_tsv_idx`, a `gin (org_id, tsv)` via `btree_gin`. `GET /messages/search?q=&limit=` is one statement, `@QueryBudget(1)`, inside `TenantDb.withOrg`, dispatching on `SEARCH_STRATEGY` (`like`|`fts`, default `fts`); `like` is a permanent arm and the red case for `pnpm db:test:like`. Its own route, **not** a `q` on `GET /conversations`: the cursor fingerprint is `sort|status|from|to`, and a search term added there without extending the fingerprint replays a cursor across a different result set. `/search` is a zero-JS RSC + GET form. **The index is reachable only because of migration 007's `ALTER FUNCTION ts_match_vq(tsvector, tsquery) LEAKPROOF`** — see the RLS gotchas. Numbers: `plans/2026-08-29_drill-11-full-text-search.md`.

Drill 12 adds `POST /ingest`, the webhook receiver, and the first route where tenant identity is **derived** rather than asserted: `ApiKeyGuard` hashes the `Authorization: Bearer` key with sha256 and resolves an org, so `X-Org-Id` is *ignored* here rather than used as a fallback (a fallback would make the stub a bypass). One conversation and its first message per event, in one `TenantDb.withOrg` transaction. `201 {conversationId, duplicate:false}` / `200 {…, duplicate:true}` / `202` when nobody can name the row yet. Idempotency is `conversations.provider_event_id` plus a **partial** unique index `(org_id, provider_event_id) WHERE provider_event_id IS NOT NULL` (migrations 009-011), with `IDEMPOTENCY=none|constraint|redis|both` (default `both`) and `ON_CONFLICT=update|nothing` (default `update`) as permanent arms. Numbers: `plans/2026-08-31_drill-12-idempotent-ingest.md`.

Drill 14 adds the claim. `conversations.version` is an `integer NOT NULL DEFAULT 1` (`1788825600000_conversations-version.js`, catalog-only — **2.398ms** on 2.5M rows, against 2,563ms for the same column with a volatile default), and **every write to the row bumps it**, `updateStatus()` included. `POST /conversations/:id/assign` takes `{assigneeId, version?}` and dispatches on `ASSIGN` (`lww`|`optimistic`|`pessimistic`, default `optimistic`), `@HttpCode(200)` because nothing is created and `@QueryBudget(2)`. `optimistic` is one `UPDATE … WHERE id = $1 AND version = $3 AND ($2::bigint IS NULL OR assignee_id IS NULL OR assignee_id = $2::bigint)`; zero rows affected is the conflict, and a re-read separates **409** (with `{error, message, current:{assigneeId, assigneeName, version, updatedAt}}`) from **404**. `pessimistic` is `SELECT … FOR UPDATE OF c` then decide under the lock; `lww` drops the guard entirely and is a permanent red arm (`pnpm db:test:lww`). `version` is required on the optimistic arm only, enforced in the service rather than the DTO because the requirement is a property of the arm. `GET /conversations/agents` returns the org's memberships and **must stay declared before `@Get(':id')`**. `ConversationSummary`/`ConversationListItem` carry `version`. Numbers: `plans/2026-09-08_drill-14-optimistic-locking.md`.

The UI half is `app/conversations/actions.ts` — a file-level `'use server'` Server Action calling `assignConversation()` in `lib/api.ts`, so the org header, `x-request-id` and `traceparent` still travel. It calls **`refresh()` from `next/cache` on both the success and the conflict path**, and nothing else: the page's data is an uncached `fetch`, so `revalidatePath` would invalidate nothing while also refreshing every previously visited page, and `revalidateTag`'s SWR profile skips the action's own re-render. Next ships the mutation, the fresh RSC payload and the return value in one POST response. `conversation-list.tsx` uses `useOptimistic` + `useTransition`; **`initialItems` is now a live prop rather than a `useState` seed**, or the refreshed truth never reaches the table, and only load-more pages are state. `?me=<membershipId>` is who "assign to me" means — the same auth stub as `?org=`, and the Server Action is a public POST that authenticates neither.

Drill 15 adds the CSV import. `import_jobs` (`1788912000000_import-jobs.js`, RLS'd, `(org_id, created_at DESC)`) carries `rows_read` **and** `resume_row` as separate columns on purpose: `rows_read` is what the parser emitted, `resume_row` is what a transaction committed, and only the second may be trusted by a retry because it is written by the same transaction as the rows it counts. `POST /imports` takes raw `text/csv` — Nest registers body parsers for `json`/`urlencoded` only, so the request arrives unconsumed and is piped to `/tmp/imports/<jobId>.csv` 64KB at a time — inserts the job row, and answers **202** with a job id. `@OrgId()`, not the api key: an import is a customer action. Three arms: `IMPORT` (`buffer`|`stream`, default `stream`), `IMPORT_BATCH_ROWS` (1000) and `IMPORT_ON_FAIL` (`resume`|`restart`, default `resume`). `buffer` is the permanent red arm and answers 200 only when the whole file has landed. The worker is `pipeline(createReadStream, csv-parse's parse(), a batching Writable)`; **backpressure is the awaited `flush()` inside `_write` and nothing else**. Each batch is one `withOrg` transaction of three statements, the third being the progress write — so reporting progress is free. It runs inside its own `runWithRequestContext({ requestId: 'import-<jobId>', … })`, or a million statements are charged to the upload request that made one. An imported conversation reuses drill 12's `provider_event_id` as `import:<external_id>`, which is what makes restart-from-zero correct. `csv-parse` is the first new runtime dependency since drill 06. Numbers: `plans/2026-09-09_drill-15-streaming-csv-import.md`.

Drill 16 adds `conversations.last_message_at`, and it arrives in **two** migrations with a script
between them. `1788998400000_conversations-last-message-at.js` adds it nullable and then, as a
SEPARATE statement, `ALTER COLUMN … SET DEFAULT now()` — one statement would store the default in
`pg_attribute.attmissingval` and stamp all 2.5M existing rows with the migration's own clock, in
1.44ms, with nothing to say it had. `1789084800000_…-not-null.js` carries `pgm.noTransaction()` and
is two statements: `ADD CONSTRAINT … NOT NULL last_message_at NOT VALID` behind a
`SET lock_timeout = '3s'`, then `VALIDATE CONSTRAINT`. The backfill between them is
`pnpm db:schema backfill`, not a migration. `LAST_MESSAGE` (`write`|`skip`, default `write`) is the
red arm: `skip` writes NULL from `POST /ingest` and fails 15 tests. `lastMessageAt` is on
`ConversationSummary` and is deliberately NOT in the `sort` allowlist. Numbers:
`plans/2026-09-10_drill-16-zero-downtime-migration.md`.

`app/imports/page.tsx` is the UI half and is zero application JavaScript: a job table and a `<meta http-equiv="refresh" content="2">` rendered **only while a job is running**, so the page stops polling on its own. Uploads go through `app/api/imports/route.ts`, a Route Handler that pipes `request.body` on with `duplex: 'half'` for `text/csv` and falls back to `request.formData()` for a browser file input — which buffers, and the page says so. A Server Action was rejected: Next buffers a Server Action's body and caps it at `serverActions.bodySizeLimit`, 1MB by default.

`src/observability` owns request correlation and query counting. One id (`x-request-id`) is generated or accepted at the Next edge and threads every layer via `AsyncLocalStorage`; `PostgresService.query()` appends it as a trailing `/* rid=… */`. Both apps log structured JSON via pino, every line carrying `time`/`level`/`svc`/`msg`/`rid` (`durMs`/`status` named consistently). `LOG_LEVEL` is per-service in `docker-compose.yml`, shell first.

The same `RequestContext` store carries two counters: `queries` (once per `PostgresService.runOn()` — what `@QueryBudget` checks) and `roundTrips` (also counts `TenantDb.withOrg`'s `BEGIN`/`set_config`/`COMMIT`, deliberately not a "query"). `QUERY_COUNTER` (`off`/`on`/`header`, default `on`) gates counting and the `x-query-count` header; `@QueryBudget(n)` defaults undeclared routes to 5, and past budget `LoggingInterceptor` logs `query_budget_exceeded` at `warn`.

OpenTelemetry sits on top, off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set (keeps drill 05's baseline unchanged). Backend `tracing.ts` runs a `NodeSDK` with five named instrumentations; frontend runs the same SDK with none (Next emits its own spans; only the outgoing `traceparent` is missing, injected by hand in `lib/api.ts`). Spans go to a collector then Jaeger, both under `profiles: ['trace']`. With tracing on, every log line gains `trace_id`/`span_id` (snake_case, for Grafana/Loki/Datadog trace links) and the hand-rolled SQL comment stands down for instrumentation-pg's sqlcommenter. Numbers: `plans/2026-08-13_drill-06-request-id-propagation.md`.

`src/tenancy` owns tenant isolation. Every table carrying `org_id` (`conversations`, `messages`, `memberships`, `tags`, `conversation_tags`) has RLS enabled and one `FOR ALL … USING … WITH CHECK` policy keyed on `app_current_org()`, a `STABLE PARALLEL SAFE` function reading transaction-local `app.org_id`. `TenantDb.withOrg(orgId, fn)` is the only way to set it: one pinned client, `BEGIN` → `set_config(…, is_local => true)` → callback → `COMMIT`. The API serves as `POSTGRES_APP_USER`, not the owner; `PostgresService` throws at construction if unset. `GET /conversations` keeps an explicit `WHERE org_id = $1`; the four `/conversations/:id*` endpoints have no org filter and are scoped by policies alone — that is what makes the removal-proof real. Reasoning and rejected alternatives: `plans/2026-08-15_drill-07-tenant-isolation.md`.

Input validation is a `ValidationPipe` registered as an `APP_PIPE` provider in `AppModule`, not `app.useGlobalPipes()` in `main.ts` — `main.ts` never executes under `Test.createTestingModule`, so a pipe there is absent from e2e tests. Same for `APP_GUARD`/`APP_INTERCEPTOR`/`APP_FILTER`.

The frontend reaches the API at `BACKEND_INTERNAL_URL` (`http://nest_server:3002`) from `app/page.tsx` and `app/conversations/page.tsx`, both server components — the service name resolves only on the Compose network, so those fetches cannot move client-side without the published host port. **Drill 10 spent `app/conversations`'s zero-application-JavaScript property**, deliberately: the first page is still server-rendered (provable with `curl` in both modes), but `conversation-list.tsx` is a `"use client"` component appending later pages through `app/api/conversations/route.ts` — a Route Handler calling the same `fetchConversations`, so the org header, `x-request-id` and `traceparent` still travel. `?mode=offset` is a complete JS-free path (numbered pager, plain `<a>`) with a `<noscript>` pointing at it; sort links, status links and the date form never needed JS. `app/health` is web liveness — 200 whenever Next serves, reporting API reachability without failing on it.

## The instruments are TypeScript, with no transpiler

`scripts/`, `k6/` and `apps/backend/db/` are all TypeScript. Nothing compiles them: Node strips types natively (on by default from 22.18.0; host is 24.11.x, container is 22.23.x) and k6 2.1.0 transpiles its own. `node scripts/load.ts` and `node db/explain.mts` run as written.

Three consequences, all load-bearing:

- **Extensions differ by directory.** `scripts/*.ts` (root `package.json` is `type: module`), `apps/backend/db/*.mts` (**that package has no `type` field, so a `.ts` there would be CommonJS** — no top-level `await`, no `import.meta.url`), `k6/*.ts`.
- **Relative imports carry the real on-disk extension** (`./lib/run.mts`, `./lib/scenario.ts`). Neither Node nor k6 rewrites specifiers; k6 rejects both `./lib/scenario.js` and the extensionless form.
- **Erasable syntax only** — no `enum`, `namespace`, or constructor parameter properties, or the runtime raises a SyntaxError. `erasableSyntaxOnly` and `verbatimModuleSyntax` in the tsconfigs are what keep that true.

`pnpm typecheck` runs the two configs: root `tsconfig.json` (`types: ["node"]`, covers `scripts/` and `apps/backend/db/`) and `k6/tsconfig.json` (`types: ["k6"]`). Two configs because the globals are disjoint. `apps/backend/tsconfig.json` and `tsconfig.build.json` both **exclude `db`**, or `nest build` starts emitting `dist/db/` and the instruments' type errors fail the application build. Reasoning: `plans/2026-08-30_instrument-typescript.md`.

## Commands

Docker is how the stack runs: `pnpm run setup` first time, then `docker:up`/`docker:down`/`docker:logs`/`docker:rebuild`, plus `docker:reset` to wipe volumes and rebuild. Running the backend outside a container is unsupported — nothing loads `.env` into a host process, so it would silently use the code's fallback credentials. Root `db:*` scripts exec into a container for the same reason; `db:seed` truncates before inserting.

Seeding is `apps/backend/db/seed.mts`.

- `db:seed` — 200 orgs, 1,200 users, 2.5M conversations, 10M messages, ~1,040 tags, 3.35M `conversation_tags`. ~213s, ~3.3GB+.
- `db:seed:ci` — same shape at `--scale=0.1` (org/user/tag counts don't scale, so skew stays testable).
- **The skew is the point — orgs `1` and `150` are the ones to know.** Org 1 is the whale (1M conversations, ~176ms requests); org 150 is the tail (2,631 conversations, ~2-3ms). Nine orgs hold ~111k each; the remaining 190 share the rest. Whale finds query cost, tail finds fixed per-request cost.
- `db:reset` — drop schema, migrate, seed (~1:52 from empty).
- `db:bench` — `COPY` vs `INSERT` loop, and faker-per-row vs the template corpus.
- Fixed RNG seed: two runs produce byte-identical data. `--scale` is the only flag.

Load testing is k6 in a container on the Compose network (`test` profile): `pnpm load list --org 150` runs one measurement, `pnpm load search` runs drill 11's, `pnpm load write` runs drill 16's — the first script here that is an OPEN model (`constant-arrival-rate`, knob `RATE`) rather than fixed concurrency, because a closed-model run cannot show a lock outage: blocked VUs simply stop sending. `k6/lib/scenario.ts` grew an arrival-rate branch in `shapeOf`/`warmupFor`, a conditional `dropped_iterations` threshold (the metric does not exist for a fixed-VU executor, and a threshold naming a metric k6 never created fails the whole run), and an `errors` line in every summary. The flat path is byte-identical, so the ~60 recorded runs stay comparable. `scripts/load.ts` is the runner — a knob catalog, `parseArgs`, generated `-e` flags, `--help` per script, same shape as `scripts/measure.ts`. Knobs are `ORG_ID`/`VUS`/`WARMUP`/`DURATION`/`BASE_URL`/`NAME`/`P95_BUDGET_MS` for both, plus `PAGE`/`PAGE_SIZE` for list and `Q`/`PAGE_SIZE` for search; each is a `--flag` or an env var, and the two forms produce identical records. `pnpm load:baseline` is an alias for `pnpm load list`, because the plans cite it. No sweep script — the method (vacuum, settle, 3 runs per org in fixed order) is written in `plans/2026-08-13_drill-05-load-test-baseline.md` and run by hand. A run leaves one directory under `k6/reports/` holding `dashboard.html` and `summary.txt`; **the HTML is gitignored** (170KB/run) and every cited number is in the ~300-byte summary. The run directory's name **is** the only index, so a run's `NAME` has to describe its arm well enough to stand alone. The measurement method — warm-up/measure split, tagged sub-metrics, thresholds, p99 arithmetic — lives once in `k6/lib/scenario.ts`; a script in `k6/` is a URL and one summary line, so the two scripts are the same experiment by construction. **Their basenames do not change**: ~60 recorded report directories are named after them, and `scripts/load.ts` strips the extension when building that name.

Observability: `pnpm logs:trace <rid>` reconstructs one request across all services. `db:log:on`/`db:log:off`/`db:log:status` toggle Postgres statement logging at runtime, off by default. `db:activity` shows `pg_stat_activity`. `trace:on`/`trace:off` start and stop the collector and Jaeger together with the sampler env var, since a set endpoint with nothing listening is a retry loop; `trace:logs` is the collector's stdout. `db:stats:on`/`db:stats`/`db:stats:reset` drive `pg_stat_statements` (`db:stats` prints top statements by `calls` and by `mean_exec_time` side by side — the orderings diverge on purpose, since an N+1 tops `calls` but is invisible on `mean_exec_time`).

`db:explain <plans|sweep|experiments|stats|keyset>` captures `EXPLAIN (ANALYZE, BUFFERS)` on the list query, sweeps the date cutoff to find where the planner changes scan node, prices rejected indexes inside a rolled-back transaction, and compares OFFSET-at-depth against the cursor's row comparison and the hand-expanded OR form. `db:paging <depths|walk|concurrent>` measures the same endpoint over **HTTP**. `db:search <plans|indexes|gaps|writes>` is drill 11's. Env vars parameterise all of them **only because the root scripts forward them with `docker compose exec -e` — see the gotcha below**. `pnpm check:arms` enforces that: it fails when a knob is missing from its `-e` flags, when an arm switch is missing from the compose `environment:` list, when a k6 script reads an `__ENV` name `scripts/load.ts` drops, when a k6 default disagrees with the catalog's, or on a reserved name like `TERM`. `pnpm arms` asks the running container which arm it resolved to — the half no static check can answer. Instruments read knobs through `db/lib/run.mts`, which prints each as `(env)` or `(default)` and writes `apps/backend/db/reports/<run>/run.json` + `output.txt`, so a write-up cites a directory rather than retyping a number.

`db:storm <key|fire|race|redis-restart>` is drill 12's. `fire` is a correctness proof rather than a benchmark: it fires 10,000 deliveries of 3,000 events at `CONCURRENCY` in flight and **asserts three things, exiting 1 on any** — rows created, 201 count, and zero 5xx — because the row count alone cannot tell a working endpoint from a broken one the unique index rescued. It reports peak in-flight so a run that was not actually concurrent is visible. `SHAPE=adjacent|shuffled` is the knob that decides whether the experiment happens at all. `race` demonstrates check-then-insert's duplicate rows and the `ON CONFLICT` isolation matrix with live sessions. `pnpm load ingest --api-key <k>` is the k6 arm; the key comes from `db:storm key` because k6 has no database.

`db:claim <fire|bench|race>` is drill 14's. `fire` is a correctness proof rather than a benchmark: 50 distinct agents claim one row at the same version and it asserts one 200, 49 409s, zero 5xx, `version + 1`, that the winner owns the row, and that peak in-flight reached the requested concurrency — exiting 1 on any. `bench` reimplements the three arm shapes in **raw SQL**, because `ASSIGN` resolves at module load and an over-HTTP sweep would restart the container between arms; it walks `LEVELS` (2,10,50) × arms round-robin, workers claiming then releasing one row, and reports successful claims/s, conflict rate and round trips per landed write. `race` is two live sessions with a chosen interleaving, plus a second experiment timing how long a loser waits behind an open transaction. `pnpm test:ui` is the Playwright half, run on the **host** (`pnpm exec playwright install chromium` once) and asserting the losing browser converges on the winner's name without a navigation.

`db:import <gen|fire|bench|resume>` is drill 15's. `gen` writes a deterministic CSV of `MB` megabytes into `/tmp/import-files`, optionally poisoned at a row with an unparseable timestamp so the failure is Postgres's `22007` rather than an invented exception. `fire` uploads one through `POST /imports` and **asserts six things, exiting 1 on any** — including that the response arrived before the work finished and that peak app RSS stayed under 512MB — and it treats a transport failure as a result rather than an exception, reading the job state straight out of Postgres, because the buffered arm kills the API mid-upload. `bench` walks the batch ladder in raw SQL on a scratch table, per-row against 100/1000/5000/10000/20000 against `COPY`, for the reason `db:claim bench` states. `resume` poisons a file, fails on it, retries, then re-uploads the fixed file. **It reports two memory numbers that disagree on purpose:** the app's own `process.memoryUsage.rss()` off the job row, and `/sys/fs/cgroup/memory.current`, which includes reclaimable page cache from reading the file and therefore sits near the 1g limit on every arm.

`db:schema <naive|safe|backfill|locks|bench|index>` is drill 16's, and `backfill` is the only
subcommand that is also an operation — the step you run once between the two migrations, against the
real column. `naive` and `safe` work on a SCRATCH column (`last_message_at_naive` /
`last_message_at_safe`) that each run adds and drops, so the two arms differ only in the sequencing
of statements, every run starts from 2.5M NULLs, and the shipped column is never at risk; the lock
is on the table, so the blocking behaviour is identical. Both open a SECOND connection that samples
`pg_locks` joined to `pg_stat_activity` every `SAMPLE_MS` — the session running DDL is inside that
statement and cannot report on itself. `WAIT` is how the DDL is landed inside a k6 measured window
launched from another terminal; `ABORT_AFTER` cancels the naive transaction mid-UPDATE. `locks` is
two live sessions and a chosen interleaving, the shape `db:storm race` already uses. `bench` walks
`BATCHES` × `SCAN` (`keyset`|`isnull`) and reads the plan off `EXPLAIN` on the statement the
backfill actually runs, VACUUMing between cells. `index` is the stretch and ships no index.

`db:test:naive` runs the e2e suite with `LIST_STRATEGY=naive`, expected to fail **two** query-budget assertions. `db:test:notiebreak` runs it with `KEYSET_TIEBREAK=off` and is expected to fail **one**, the tie-block walk. `db:test:like` fails **one**, the stemming assertion. Drill 12 adds four more: `db:test:constraint` and `db:test:donothing` are expected **green** (they are the card's DONE WHEN as a test), `db:test:redis` fails **one** on purpose — a concurrent duplicate gets 202 instead of a conversation id, which is the failure mode the constraint does not have — and `db:test:noidem` fails **three**. Drill 13 adds `db:test:rmw` (fails **two**), `db:test:locking` and `db:test:serializable` (green). Drill 14 adds `db:test:lww` (fails **four** — every assertion in the concurrent block) and `db:test:pessimistic` (green), plus a required red run on the UI half: `ASSIGN=lww … && pnpm test:ui` fails the conflict test. Drill 15 adds `db:test:buffer` (`IMPORT=buffer`), which fails **four**, and `db:test:restart` (`IMPORT_ON_FAIL=restart`), which is expected **green** — a correct answer that is merely slower. Drill 16 adds `db:test:skiplast` (`LAST_MESSAGE=skip`), which fails **15** across two suites. Backend suite is 136 tests; Playwright is 3 more, outside it.

Formatting is root Prettier: `pnpm format`/`format:check`, resolved per file nearest-wins (backend keeps its own `.prettierrc`; both apps' ESLint configs untouched). `.prettierignore` excludes `*.md` (prose is hand-wrapped; Prettier would pad tables to a uniform width) and `k6/reports` (machine-written).

Root, via Turborepo: `pnpm dev`/`build`/`lint`/`typecheck`/`test`, plus `dev:backend`/`dev:frontend`. For single-app work, run from that app's directory. Backend adds `start:dev`, `test:cov`, `test:e2e`; one file via `pnpm exec jest <path>`, by name with `-t`.

## Constraints and gotchas

**Environment and wiring**

- Ports are split deliberately (3001 frontend / 3002 backend) so both run without collision.
- **Connection numbers are chosen, not defaulted**: pool `max: 10`, `connectionTimeoutMillis: 2000`, `idleTimeoutMillis: 30000`; ioredis `commandTimeout: 2000`, `maxRetriesPerRequest: 1`.
- **`lazyConnect: true` and `enableOfflineQueue: false` cannot combine on ioredis.** With the offline queue off, commands are rejected whenever status isn't `ready`, and a lazy client starts in `wait` — the first `ping()` rejects without ever connecting. `lazyConnect` is what keeps Jest from opening sockets at module init.
- **A new dependency needs `docker:rebuild`, not `up --build`** — `/app/node_modules` is an anonymous volume Compose carries over on recreate; only `--renew-anon-volumes` refreshes it.
- **`docker compose exec` does not forward the caller's environment, and `docker compose up` only forwards variables a service's `environment:` list names.** Both fail identically and silently: `ORG_ID=150 pnpm db:explain plans` measured **org 1 for the whole of drill 09**, and `KEYSET_TIEBREAK=off docker compose up -d nest_server` ran the *default* arm. Root scripts now pass `-e ORG_ID -e …` explicitly, and every switch is declared in `docker-compose.yml`. Corollary: `-e VAR` on an unset host variable arrives inside the container as **`''`, not absent**, so those scripts read knobs with `||` and never `??`. `pnpm check:arms` fails on all three shapes and `pnpm arms` catches the fourth (a container older than the switch). Neither catches a typo at the prompt.
- **Env vars forwarded via `${VAR:-default}` don't persist across shell invocations, and `docker compose up` reconciles the whole project even when scoped to one service.** Setting `PG_PRELOAD` for one `postgres_db` call, then later running a plain `up -d nest_server`, silently reverts `shared_preload_libraries` and **recreates** `postgres_db`, losing its cache. Set every var you want kept in the same command every time.
- **A switch built as a measurement arm needs a test that fails when it stops switching.** `QUERY_COUNTER=off` once gated only the *reporting*, not the increments, and priced the wrong thing. Every toggle here (`LOG_LEVEL`, `OTEL_*`, `PG_PRELOAD`, `LIST_STRATEGY`, `QUERY_COUNTER`, `SEARCH_STRATEGY`, `KEYSET_TIEBREAK`) is a candidate for the same bug.
- **A git worktree gets its own Compose project, and `container_name:` is pinned.** `docker-compose.yml` has no `name:` key, so Compose derives the project from the directory — two stacks cannot run at once, and a worktree that starts its own gets an empty volume. `COMPOSE_PROJECT_NAME=drills` on every compose and `pnpm db:*` call reuses the existing project and its seeded volume with this tree's bind mounts.
- **`docker compose up -d --force-recreate` wipes `/tmp` inside the container; `restart` does not.** That takes the generated CSVs *and* the API's own spooled uploads with it, so switching an import arm means regenerating.
- **`nest start --watch` does not restart a process the V8 heap limit killed.** The container stays up and reports unhealthy, and the next command gets `ECONNREFUSED` rather than an error naming the crash.
- Credentials live in `.env` only. **node-pg-migrate echoes every statement to stdout**, so `pnpm db:migrate` prints the app role's password — fine for a local dev credential; in a real deployment the role is created out of band.

**Memory limits**

- **V8's default heap limit is half the container's cgroup limit, and `os.totalmem()` does not know.** Measured across four sizes: `-m 512m` gives 259MB of heap, `1g` gives 524MB, `2g` gives 1048MB, `4g` gives 2096MB — while `os.totalmem()` reports the host's 7935MB every time, because `/proc/meminfo` is not namespaced. Any code that budgets from `os.totalmem()` inside a container budgets against a number eight times too large.
- **A V8 heap-limit crash and a cgroup OOM are different events with different fixes.** V8 writes `<--- Last few GCs --->` plus a stack trace and exits; `docker inspect` reports `OOMKilled=false`. A cgroup OOM is a silent SIGKILL with `OOMKilled=true`. The lever is `--max-old-space-size` for the first and `mem_limit` for the second, and on a buffering importer neither fixes anything — both just move the wall.
- **The cgroup's `memory.current` includes page cache**, which is reclaimable and does not cause an OOM. Reading a 400MB file pins it near the limit on the *streaming* arm too, so a run that reports only the cgroup number makes a correct import look like a leak. Report the process's own RSS beside it.

**Postgres configuration**

- **Postgres settings live in `command:` on `postgres_db`, never `POSTGRES_INITDB_ARGS`** (the latter only runs at `initdb`, so on an existing volume it silently does nothing). Current: `shared_buffers=128MB` (small on purpose, so cache misses stay visible), `wal_level=minimal`, `max_wal_senders=0`, `max_wal_size=2GB`, `checkpoint_timeout=30min`.
- **`pg_settings.context` is the map for changing a setting:** `postmaster` = restart, `sighup` = reload, `user` = session `SET`. `shared_buffers`/`wal_level` need a restart; `maintenance_work_mem`/`synchronous_commit` are session-settable.
- **`shared_preload_libraries` is postmaster-context** — enabling `pg_stat_statements` needs `postgres_db` recreated, not reloaded: `PG_PRELOAD=pg_stat_statements docker compose up -d postgres_db`.
- **`ALTER SYSTEM` persists in the data volume across restarts** — `pnpm db:log:on` survives a `docker compose down`, silently poisoning the next load test. `pnpm db:log:status` checks rather than assumes; `-1` is off.
- **`wal_level=minimal` blocks streaming replication and PITR** — set so the seed can skip WAL for a table truncated and refilled in one transaction. Any replica drill starts by changing it back to `replica`.
- **A role is a cluster object; `pgmigrations` is a database one.** `pnpm db:reset` drops the tables and ledger but **leaves the role**, so migration 003 guards `CREATE ROLE` with a `pg_roles` check and re-runs its `GRANT`s unconditionally.

**Idempotency and writes**

- **A `SECURITY DEFINER` function is how authentication escapes the tenant scope it establishes.** `api_keys` carries `org_id`, so `check:tenancy` requires a policy on it — but the lookup runs before any org is known, and with `app.org_id` unset the policy admits no rows. `app_org_for_api_key()` runs as the owner (which works only because migration 003 declined `FORCE ROW LEVEL SECURITY`) and returns a bigint. **`SET search_path = pg_catalog, public` is mandatory on it**: an unpinned search_path lets anyone who can create a schema shadow the table and have the owner read theirs.
- **`app_user` has no `SELECT` on `api_keys`, deliberately, and Postgres requires SELECT on any column a `WHERE` or `RETURNING` clause reads.** So `DELETE … WHERE org_id = $1` and `INSERT … RETURNING id` are both `permission denied`, while a *filterless* `DELETE FROM api_keys` inside `withOrg` works and is scoped by the policy — same shape as drill 07's endpoints.
- **A partial unique index makes `ON CONFLICT` repeat its predicate.** `ON CONFLICT (org_id, provider_event_id) WHERE provider_event_id IS NOT NULL`, or Postgres cannot match the statement to the index and raises `42P10`. The partial predicate is about size, not correctness — NULLs are already distinct in a btree unique index.
- **`ON CONFLICT DO NOTHING` and `DO UPDATE` both block on the concurrent inserter, and at READ COMMITTED the `DO NOTHING` follow-up `SELECT` finds the row.** Every statement takes a fresh snapshot, and the wait already happened. The two differ in round trips (2 vs 1) and dead tuples, **not** in correctness. At REPEATABLE READ both raise `40001` instead. Measured: `pnpm db:storm race`.
- **A no-op `DO UPDATE SET col = EXCLUDED.col` is HOT-eligible**, because no *indexed value* changes — 6,531 of 6,544 updates were HOT, and `n_dead_tup` moved +335 where "one dead tuple per duplicate" predicted 7,000. `n_tup_hot_upd` is the column that says so. Assign something that genuinely changes an indexed column and this stops being true.
- **`n_dead_tup` is not monotonic and has a noise floor.** An arm doing zero updates still read +211 on a 2.5M-row table, and autovacuum mid-run produced *negative* deltas. Anything under ~500 there is noise.
- **`xmax = 0` distinguishes an insert from an `ON CONFLICT DO UPDATE`, and is an implementation detail rather than documented API.** The endpoint's created/duplicate contract rests on it, so `test/ingest.e2e-spec.ts` asserts on it directly.
- **A duplicate storm that shuffles its duplicates is not a weaker test of idempotency; it is not a test of idempotency.** Spread out, the winner commits before the next copy arrives and nothing races — `SHAPE=shuffled` passes on every arm including `none`.
- **The Redis guard's value is a question about timing, not throughput.** It can only short-circuit a duplicate that arrives *after* the original committed. Under simultaneous replay `both` was the **slowest** arm (26.4ms vs 23.4ms p50); with the same 10,000 deliveries spread out it was the **fastest** (15.1ms), and k6's steady state put it 34% ahead at p50 and 44% ahead on throughput.
- **Adding a table with an FK to `organizations` breaks `db:seed`.** `TRUNCATE` refuses with `0A000` naming the *new* table, not the seed's list. Add it to the list in `seed.mts`.
- **`GET /info`'s arms block is asserted with an exact `toEqual`** in `test/arms.e2e-spec.ts`, so a new arm added to the controller and forgotten there fails immediately. That is the point of it.

**RLS**

- **RLS is not enforced against a superuser, a `BYPASSRLS` role, or the table owner** (the last only without `FORCE ROW LEVEL SECURITY`). All three fail *silently and positively*. `pnpm check:tenancy` asserts all three.
- **No `FORCE ROW LEVEL SECURITY`, deliberately.** Migrations and the `COPY` seed run as the owner and must write across tenants. The price: anything running as `POSTGRES_USER` is outside the mechanism.
- **A transaction-local GUC reverts to `''`, not unset.** So `current_setting('app.org_id', true)` is `NULL` only until a pooled connection's first scoped transaction, then `''` forever after, and `''::bigint` raises `22P02`. Hence `nullif(…, '')` inside `app_current_org()`: without it, fail-closed becomes a 500 on every unscoped query after the first.
- **`set_config(…, is_local => true)` needs an explicit `BEGIN`.** Outside one it applies to the implicit single-statement transaction and is gone before the next statement — every policy predicate then goes NULL and everything returns zero rows.
- **SQL functions default to `PARALLEL UNSAFE`, and a policy calling one makes every query on that table serial.** Measured on the whale: `count(*)` 42.7 → 108.0ms, list page 1 88.9 → 214.7ms — **2.4x, from one missing word**. `STABLE` matters separately: it folds the policy into a `One-Time Filter` (once per scan, not per row) and keeps the index-only scan.
- **RLS turns index conditions into filters for every non-leakproof operator.** `ts_match_vq` (`@@`), `textlike` (`LIKE`) and `texticlike` (`ILIKE`) are all `proleakproof = f`, and on a table with a policy the planner will not build an index path at all — `SET enable_seqscan = off` still picks the seq scan, marked `Disabled: true`. Only `@@` is fixed (migration 007); the btree and trigram candidates in `db:search indexes` are unreachable for this reason, not because they are bad indexes.
- **`ALTER FUNCTION ... LEAKPROOF` does not survive `pg_dump`/restore or a major-version upgrade.** The symptom is search silently becoming 100x slower. Nothing warns.
- **`pg_stats` hides every row for an RLS-enabled table from anyone who is not its owner** — no error, just an empty result. Reading it as `app_user` looks exactly like a table with no statistics collected.

**Full-text search**

- **`btree_gin`'s `int8_ops` opfamily has no cross-type operators** — only `bigint = bigint`. `WHERE org_id = 150` (an `integer` literal) silently drops the tenant key out of the `Index Cond`; `org_id = 150::bigint` keeps it. The application is safe because `pg` sends parameters untyped, but every hand-written `EXPLAIN` in psql measures a different plan.
- **`to_tsvector(text)` is `STABLE`, `to_tsvector(regconfig, text)` is `IMMUTABLE`.** Only the second is legal in a generated column, and the error does not say which one you used.
- **`ADD COLUMN ... GENERATED ALWAYS AS (...) STORED` is a full table rewrite under `ACCESS EXCLUSIVE`** — 135s on `messages` at 10M rows. It reads like a metadata change.

**Bulk loading**

- **Foreign keys are checked per row during `COPY`** — `messages_conversation_id_fkey` alone was 40% of the messages load, so the seeder drops it and re-adds with `NOT VALID` + `VALIDATE CONSTRAINT`.
- **Dropping indexes for a bulk load only pays if `maintenance_work_mem` is raised too** — at the 64MB default the rebuild costs more than it saves; at 512MB it's 7.5x faster since the sort stays in memory.
- **The seeder's generator is not the bottleneck; don't optimise it without measuring** — Postgres ingests at ~137k rows/s while the generator produces ~2M/s, so it sits idle at `yield` for most of the load. Numbers: `plans/2026-08-11_drill-04-bulk-seed.md`.
- **A Bind message counts its parameters in an unsigned 16-bit integer, and past 65,535 the count WRAPS.** 20,000 rows at four parameters each sends 80,001 and the error reads `bind message has 14465 parameter formats but 0 parameters` — 80001 mod 65536, a number that appears nowhere in the request. The conversation insert's arity puts the last legal batch at 16,383 rows.
- **Batching an INSERT has a knee at ~1,000 rows, not a slope.** Measured at 100k rows: per-row 14,192 rows/s, 100 -> 231,345, **1000 -> 291,010**, 5000 -> 265,805, 10000 -> 254,651. Batching is worth 20.5x and the last 10x of batch size costs 12.5%.
- **"COPY beats INSERT" is true against a loop and false against a batch.** `COPY FROM STDIN` ran at 183,804 rows/s against batched INSERT's 291,010 — 1.58x slower — because it makes Node serialise every row to tab-delimited text through a generator and a stream. Drill 04's 13x still holds against the per-row loop it measured.
- **A streaming import's memory is bounded by the awaited write, not by the streams.** Deleting the `await` inside a `Writable`'s `_write` makes the buffer accept every row, the parser never pauses, and the file is in memory again with extra steps. The test is doubling the file and watching peak RSS.
- **`ANALYZE` and `VACUUM` do different jobs, and benchmarks right after a seed measure the wrong one** — only `VACUUM` sets the visibility map, and index-only scans are illegal without it. `count(*)` on `conversations`: 60ms seq scan right after seeding, 27ms index-only once vacuumed.

**Locks and DDL**

- **A lock is released by COMMIT, not by the statement that took it.** node-pg-migrate wraps each
  migration in one transaction, so the ACCESS EXCLUSIVE that `ALTER TABLE ADD COLUMN` takes in 1ms
  is held until the last statement in the file commits. Measured on 2.5M rows: 74,722ms held, 10
  backends (the whole pool) queued for `RowExclusiveLock`, 76.73% of writes failed.
- **`pgm.noTransaction()` is mandatory when a migration mixes ACCESS EXCLUSIVE with a long scan.**
  `ADD CONSTRAINT … NOT VALID` then `VALIDATE CONSTRAINT` inside one transaction reinstates exactly
  the outage the split exists to avoid. It gives up atomicity, so every statement has to be safe to
  re-run.
- **Postgres grants locks first come first served, so a WAITING ACCESS EXCLUSIVE blocks everything
  behind it.** `ADD CONSTRAINT … NOT VALID` is a catalog write that should take microseconds; it
  measured **1,006ms and 1,012ms on two runs**, queued behind `autovacuum: VACUUM ANALYZE
  public.conversations` — which the backfill's own 2.5M dead tuples had just triggered. Hence
  `SET lock_timeout = '3s'` around that statement in migration 016. `VALIDATE` needs no guard:
  SHARE UPDATE EXCLUSIVE does not conflict with ACCESS SHARE or ROW EXCLUSIVE.
- **`NOT VALID` means "the existing rows are unchecked", not "this is not enforced".** `attnotnull`
  is set immediately and a new NULL insert raises 23502 straight away; only `VALIDATE` looks at what
  was already there. Measured all four states in `pnpm db:schema locks` / the schema spec.
- **`ADD CONSTRAINT … NOT NULL <col> NOT VALID` is Postgres 18.** A not-null constraint only became
  a first-class catalog object (`contype = 'n'`) there. On 17 and earlier the recipe is a CHECK
  constraint as a proxy, then `SET NOT NULL` — which skips its scan since PG 12 *only* if a
  VALIDATED CHECK proves no NULL can be present.
- **`ADD COLUMN` with a NON-VOLATILE default is catalog-only and can be silently wrong.** PG 11+
  evaluates it once into `pg_attribute.attmissingval`. `now()` is STABLE and qualifies, so
  `ADD COLUMN … NOT NULL DEFAULT now()` finishes in **1.44ms** and leaves **one distinct value
  across 2,505,787 rows**. `clock_timestamp()` is VOLATILE, does not qualify, and rewrites the whole
  table in 2,827ms. Setting the default as a SEPARATE `ALTER COLUMN … SET DEFAULT` applies to future
  inserts only, which is the shape migration 015 ships.
- **A table rewrite compacts the heap.** The volatile-default arm took `conversations` from 552MB to
  276MB — a `VACUUM FULL` nobody asked for, under ACCESS EXCLUSIVE.
- **Batching changes the LOCK, not the garbage.** Both arms left ~2.5M dead tuples. `DROP COLUMN`
  reclaims nothing (catalog-only), so a run that skips its VACUUM leaves the heap permanently
  larger for every later baseline.
- **A cancelled migration still costs everything except the result.** `--abort-after 15` rolled back
  cleanly and left 568,382 dead tuples and the heap up 275.9MB → 338.5MB, for 15s of total outage.
- **A `CREATE INDEX` that "let the write through" can still have multiplied its latency by 478.**
  Measured: 631.44ms against 1.32ms under CONCURRENTLY. Probe the LATENCY, not the outcome.
- **`CREATE INDEX CONCURRENTLY` waits on REAL transaction ids, not virtual ones.** An
  idle-in-transaction session that has only read does not block it; one that has INSERTed parks the
  build at `wait_event_type=Lock, wait_event=virtualxid, state=active` indefinitely.
- **`EXTRACT(epoch …)` returns numeric, which `pg` hands back as a string**, same as bigint. Cast
  `::float8` before JavaScript does arithmetic on it.
- **There is no `max(uuid)` aggregate.** A keyset cursor over a uuid PK needs
  `ORDER BY id DESC LIMIT 1`.
- **A batch size big enough flips the query plan.** The backfill's per-batch statement uses a Nested
  Loop over `conversations_pkey` at 1,000 rows and a Hash Semi Join whose inner side is a **seq scan
  of all 2.5M rows** at 100,000 — 134,001 rows/s against 83,044, and 15.06ms against 1,140.18ms in
  an isolated `EXPLAIN`. 10,000 sits on the boundary and the planner does not choose the same way
  twice. Check the plan at your batch size.
- **`WHERE col IS NULL … LIMIT n` is OFFSET wearing a hat.** With no index on the column every batch
  re-walks the primary key past the rows it already filled: **+478%** from first batch to last, over
  200 batches, against **-73%** for a keyset cursor. Invisible at two batches, which is why a short
  bench can miss it.
- **A backfill is an operation, not a migration.** node-pg-migrate holds a session advisory lock for
  the whole run, so a 75-second backfill inside one blocks every other deploy.

**Query plans and indexes**

- **DDL is transactional in Postgres, which makes an index an experiment.** `SAVEPOINT` → `CREATE`/`DROP INDEX` → `EXPLAIN` → `ROLLBACK TO SAVEPOINT` prices an index before any migration commits to it, and reproduces a "before the index" plan long after the migration landed. `CREATE INDEX CONCURRENTLY` is the one form that cannot do this — it can't run in a transaction at all.
- **`CREATE INDEX CONCURRENTLY` needs `pgm.noTransaction()` and gives up atomicity for it.** A failed build leaves `indisvalid = false`: invisible to the planner, still maintained on every write. Find one with `SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE NOT indisvalid;`.
- **"Equality columns before range columns" assumes the equality is always present.** An *optional* equality wedged between the tenant key and the sort key makes the index unusable for every query that omits it: inside one org, `(org_id, status, updated_at)` is ordered by `status` first, so the unfiltered page's rows sit in two disjoint index ranges and Postgres (no skip scan) falls back to a seq scan — 113ms with the index right there.
- **A `LIMIT` plus an `ORDER BY` the index can serve makes selectivity irrelevant.** Across a 1.8%–31%-of-table sweep the index scan was chosen at *every* point, flat at 0.2–0.3ms and 26 buffers. The 5–10% rule of thumb only governs queries that must materialise their matches.
- **When the index can't serve the ORDER BY, the flip is `Seq Scan → Bitmap Heap Scan` and it stops there** — never a plain index scan. A bitmap sorts heap pages into physical order, which is why it wins and why it destroys the index's ordering. Measured threshold **9.0–9.1% of the table** — a fact about `random_page_cost=4.0` and a 198MB heap, not about Postgres.
- **The planner multiplies predicate selectivities as if independent.** `status` and `updated_at` are correlated by the seed's design, so estimates were **+24.8% over** on one plan and **3.0× under** on another. `CREATE STATISTICS … (dependencies)` is the fix and is not applied.
- **`n_distinct` is a count when positive and a *ratio of the row count* when negative.** `-0.9945` means 99.45% of values are distinct, not "minus one".
- **`BUFFERS` distinguishes "fast" from "cached"; timing cannot.** The same sweep query ranged from `1584 hit/23808 read` to `15308 hit/10084 read` with wall clock barely moving. It also shows planning cost: on a 0.255ms index scan, `Planning Time` was 0.389ms.
- **A correlated `LATERAL` subquery can block limit-pushdown into a sort**, turning a cheap top-N heapsort into a full external disk sort — a `LATERAL json_agg` alternative to the batched queries spilled 18MB to disk at similar wall clock. Fewer round trips isn't automatically cheaper.

**Pagination**

- **`OFFSET` is an argument to the `Limit` node, not a filter.** The scan below still emits every skipped row. Read `Actual Rows` on the node *under* the `Limit`: 250,000 rows produced to return 50 at page 5,000, against 50 at every depth for a cursor. Past ~250k emitted rows the planner abandons the index for a `Seq Scan`, so the offset curve is linear and then **steps**.
- **The hand-expanded `a < $k OR (a = $k AND b < $i)` is not the same plan as `(a, b) < ($k, $i)`.** The row constructor reaches a multicolumn btree as one `Index Cond`; the OR form becomes an `Index Cond` on the leading column plus a `Filter`, which restarts at the top of the index and walks — it reinvents `OFFSET`. Measured 112× apart at page 5,000 (0.62ms/4 buffers vs 69.72ms/121,166), and the OR form passes every correctness test.
- **`pg` returns `timestamptz` as a JS `Date` — milliseconds — while Postgres stores microseconds.** Any value round-tripped through JS names an *earlier* instant than the row it came from, silently dropping every row tied on the untruncated value. The keyset arm therefore selects `to_char(c.<sort> AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` and the key never enters JS (`to_char` not `::text`: the cast renders through the session's `DateStyle`). **The seed cannot reproduce this** — its timestamps are whole seconds; only the e2e fixtures, which use `now()`, have microseconds to lose.
- **Keyset is immune to insert-shift, not to a moving sort key.** A row whose sort value changes mid-walk crosses the cursor and is skipped or repeated. `updateStatus()` sets `updated_at = now()`, so this is live here. Immunity needs a snapshot (`REPEATABLE READ` held across pages, which pins a connection and blocks vacuum) or an immutable sort key.
- **`@ValidateIf` skips a property's validators when its condition is false** — it is not a guard. `@ValidateIf(q => q.paging === 'keyset')` on `cursor` would have made `paging=offset&cursor=…` silently accepted and ignored. Mutual exclusion belongs in a plain check.

**Measurement method**

- **Within one sweep the noise floor is 1.9–7.2%, but the same sweep run three times in one evening had *medians* move up to 14%, monotonically** (the laptop drifting slower over 90 minutes). So: **interleave A/B arms in one sitting**, and treat a cross-sitting delta under ~15% (20% on the tail) as unproven.
- **Arms must differ only in the variable, not in whether the process restarted.** An arm needing a whole-tree `git checkout` restarts into a cold JIT and an empty pool — 33% spread vs 1.6–5% — and has to be discarded as a comparator. Build the "no mechanism" arm as a code path on the *same* commit.
- **A concurrent k6 load test and an isolated `EXPLAIN (ANALYZE, BUFFERS)` can disagree, and the disagreement matters.** Drill 08's whale comparison showed the "fixed" batched query as *worse* — inside the within-arm noise floor (14–17%), caused by 10 VUs thrashing the deliberately undersized 128MB `shared_buffers`. The isolated `EXPLAIN` found the real, small cost (+19%/+30ms).
- **`pg_stat_statements`'s `queryid` is from the parsed query tree, not raw SQL text** — comments never reach the parser, so the trailing `/* rid=… */` doesn't fragment identical statements. Its `query` column is still only the *first* call's literal text — good for spotting a shape, useless for attributing one row to one request.
- **The Postgres statement log's `grep -c 'rid=…'` is 3× the true statement count** — `pg`'s extended query protocol logs `parse`/`bind`/`execute` per statement, each echoing the full text. Divide by 3, or filter to one phase.
- **`Promise.all` of two queries takes two pool connections per request.** `pool.query()` acquires and releases per call, so `GET /conversations` wants 2 of the pool's 10 per in-flight request — oversubscribed 2:1 at 10 VUs.

**k6**

- **The k6 image is pinned (`grafana/k6:2.1.0`), and that is load-bearing.** A baseline is only comparable to a re-run of itself; `:latest` swaps the instrument between the `before` and the `after` without saying so.
- **`http_req_failed`'s `passes` counts the FAILURES.** It is a Rate over "did this request fail?",
  so `fails` is the success count. Reading the wrong one reported a clean 4,500-request baseline as
  "4,500 errors (0.00%)".
- **`handleSummary` REPLACES k6's end-of-test block.** Anything it does not print is not printed:
  this repo recorded no error count in any run from drill 05 to drill 16, so "zero errors" was a
  claim about an exit code rather than a number.
- **A closed-model run cannot measure an outage.** Fixed VUs stop sending when the server stalls and
  the summary reports a few slow requests, saying nothing about the traffic a real service would
  have received meanwhile. `constant-arrival-rate` keeps offering, and the requests it cannot start
  land in `dropped_iterations` — a metric that exists ONLY for arrival-rate executors, so a
  threshold naming it fails a fixed-VU run outright.
- **Flat percentiles are a client timeout, not a database.** The naive arm's p50/p95/p99 were
  2001/2003/2005ms, which is `connectionTimeoutMillis: 2000` on the `pg` pool; the 60,001ms max is
  k6's own default HTTP timeout.
- **k6 will not compute a tagged sub-metric unless a threshold names it.** `http_req_duration{scenario:measure}` is `undefined` in `handleSummary` without a threshold on that exact string — hence two thresholds that can never fail (`max>=0`, `count>0`), which look like dead code but are what the warm-up exclusion depends on.
- **k6's default summary stops at p(95).** p99 needs an explicit `summaryTrendStats`.
- **A k6 counter's `rate` is divided by the whole run duration, warm-up included** — throughput for a measured phase is `count / measuredSeconds` or it's understated (25% here).
- **k6's web dashboard** (`K6_WEB_DASHBOARD=true` + `K6_WEB_DASHBOARD_EXPORT=<path>.html`) gives a time series the end-of-run summary can't show. Traps: it doesn't create the output directory (fails at the end); a run under 3× `K6_WEB_DASHBOARD_PERIOD` (default 10s) is silently skipped; that period is also the graph resolution, so `2s` makes short runs readable.
- `.mcp.json` wires Context7 and k6 MCP servers. The k6 MCP is **not** on the Compose network, so it can validate a script but cannot reach `nest_server`; real runs go through `docker compose run k6`.

**Nest and Next**

- **Query params are always strings** — a numeric DTO field needs `@Type(() => Number)` or `@IsInt()` rejects every request (per-field, not `enableImplicitConversion`).
- **A type named in a DECORATED parameter needs `import type`** when `isolatedModules` and `emitDecoratorMetadata` are both on, or TS1272 fails the build. `@Res({ passthrough: true }) response: Response` is the case here; every other express import in the repo is a plain one because none sits in a decorated position.
- **`@Res()` without `passthrough: true` hands the whole response over and the returned object is never serialised.** A dynamic status code has no decorator form — `@HttpCode` takes a constant.
- **supertest starts a fresh ephemeral server per request for an app that is not already listening.** Sixty concurrent requests then fail in the *client* with no server-side error anywhere, which reads exactly like the endpoint breaking under concurrency. `await app.listen(0)` instead of `app.init()` in any spec that fires concurrent requests.
- **`@Headers()` accepts no pipes in Nest 11** — validating one needs a custom `createParamDecorator`.
- **`Reflector.getAllAndOverride` reads metadata off `ExecutionContext.getHandler()`/`getClass()`** — the controller's route handler, not an injected service's method. A `@QueryBudget` on a service method compiles, runs, and is silently ignored.
- **`forRoutes('*')` is fine on Nest 11** despite Express 5's path-to-regexp rejecting unnamed wildcards — `LegacyRouteConverter` rewrites it to `{*path}`.
- **`pg` returns `bigint` (int8) as a string**, including `count(*)` — ids stay strings out to the JSON, counts get cast.
- **New folders make the editor's ESLint server go stale** (type-aware rules hold their own TS program). Tell: CLI clean, editor red, only `no-unsafe-*` firing. Restart the ESLint server.
- Next.js 16 differs from training data. Read `apps/frontend/AGENTS.md`, don't guess. It is generated during `next dev`/`next build`, loaded via `apps/frontend/CLAUDE.md` — commit it.
- Next 16 does **not** cache `fetch` by default, and `cacheComponents` is off here on purpose — a later card is about caching.
- `params`/`searchParams` are Promises and must be awaited. `PageProps<'/route'>`/`LayoutProps<'/'>` are globally available generated types.
- **Next 16 renamed `middleware.ts` to `proxy.ts`** (export `proxy`, Node runtime by default). `NextResponse.next({ request: { headers } })` is what the *app* sees via `headers()`; `next({ headers })` is what the *browser* sees.

**Logging and tracing**

- **A suppressed log line still evaluates its arguments.** `logger.debug({ sql: summarise(text) }, …)` runs `summarise` at every level, including `silent`. Guard with `logger.isLevelEnabled()`; in an interceptor, bail before returning the `tap()` chain. Worth ~6% of tail-org throughput.
- **pino-http logs every 5xx at `info` unless `customLogLevel` is set** — `grep '"level":"error"'` would never find a server error.
- **`customProps` is applied twice** (child logger creation and again at response time), so a field that changes mid-request emits a **duplicate JSON key with two values**. `rid` belongs there; `status` does not.
- **nestjs-pino's `exclude` also removes the request context**, so lines written during that request lose their `rid` — `pinoHttp.autoLogging.ignore` suppresses only the automatic line.
- **`LoggerModule` is `@Global()`** — registering it anywhere but `AppModule` logs every request twice. Nest orders global-module middleware first, so nestjs-pino's `genReqId` always runs before our own middleware.
- **OTel instrumentation patches modules as they load, so `import './tracing'` must be the literal first import of `main.ts`** — below any other import the patches land on already-resolved modules: no error, no spans. `tracing.ts` imports nothing from the app but two constants files.
- **Our `/* rid= */` SQL comment and instrumentation-pg's sqlcommenter are mutually exclusive** — `@opentelemetry/sql-common` refuses to comment an already-commented statement, so the hand-rolled comment silently disables the standard `traceparent` one. Also, instrumentation-pg names spans from the first whitespace-delimited token, so a *leading* comment would rename every query span to `pg.query:/*` — hence the comment trails, and is skipped when tracing is on.
- **Next runs `proxy.ts` in its own one-span trace, not a child of the render.** So the request id can't be minted from the active trace id at the edge. The API can (its span is the propagated server span); the web tier mints a UUID and `trace_id` on every log line is the join.
- **Next does not inject `traceparent` on outgoing `fetch`.** It creates an `AppRender.fetch` span but `patch-fetch.js` never writes the header, so `propagation.inject` is called by hand in `lib/api.ts`. Inbound on Nest is automatic.
- **The OTel packages need `serverExternalPackages` in `next.config.ts`** — bundled, the SDK registers into a different copy of `@opentelemetry/api` than Next's own tracer holds, again with no error and no spans.
- **`after()` may only call request APIs inside its callback in Route Handlers and Server Functions**, not Server Components — read the id first and close over it.
- **`jaegertracing/jaeger` all-in-one stores traces in RAM** and was SIGKILLed by its 1g `mem_limit` during a 60s load test at 100% sampling. Not a bug — it is the argument for sampling.
- **Sampling is env-var only, no code:** `OTEL_TRACES_SAMPLER=parentbased_traceidratio` + `OTEL_TRACES_SAMPLER_ARG=0.05` — `parentbased_*` honours an inbound decision, stopping a trace being recorded by only half its services.
- **pnpm 11 fails `install --frozen-lockfile` on an undecided build script** — `sdk-node`'s gRPC exporters pull `protobufjs`; `allowBuilds: { protobufjs: false }` in `pnpm-workspace.yaml` is that decision, needed or the Docker image build fails.
