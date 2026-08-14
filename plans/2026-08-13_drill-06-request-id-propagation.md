# Drill 06 — Propagate one request id through Next, Nest, Postgres and Redis

**Status:** shipped, both phases. Phase 1 (correlation + structured JSON logs) and phase 2 (the
OpenTelemetry stretch) are separate commits, in that order, deliberately — see the phase 2 section.

## Context

Three services log to three streams that share no identifier. Drill 05 produced real latency
numbers (whale p50 175.5ms / p95 340.3ms) but could not say *where* those milliseconds went — k6
measures from outside, `EXPLAIN` measures from inside, and nothing joins the two. Cards 08, 09 and
10 are each "make this faster", and each one has to answer "faster *where*".

This drill makes one request greppable end to end: an id generated or accepted at the Next edge,
carried into Nest, attached to every log line, embedded in the SQL text itself so it reaches
Postgres's own log, and echoed on the response header so the browser can see it.

It also builds the first Nest interceptor, which is the mechanism card 08 reuses.

Deliberate non-goal for this phase: **this is correlation, not tracing.** No spans, no
parent/child, no sampling. What that costs is written into the writeup rather than papered over.
The OpenTelemetry stretch is scoped as a separate phase below and must land *after* this one is
committed — auto-instrumentation moves latency, and folding it in would make the
logging-overhead A/B measure two changes at once.

## Decisions

**The id is derived once, memoised on the request object with a symbol key.** `nestjs-pino`'s
`genReqId` and our own middleware both need the same value, and their relative order depends on
module registration order — not something worth betting on. `requestIdFor(req)` makes whichever
runs first the deriver and the other a reader. Order-independent by construction, which is
cheaper than being careful.

**An inbound `x-request-id` is validated against `^[A-Za-z0-9_-]{8,64}$` or replaced.** This is
load-bearing, not hygiene. The id is interpolated into the SQL text as a comment, so a header of
`*/ SELECT ... --` breaks out of that comment. `PostgresService.query('SELECT 1')` — the health
probe — passes no params, and `pg`'s `Query.submit` falls through to `connection.query(text)`,
the *simple* query protocol, where `;`-separated multiple statements are legal. The injection is
reachable, and reachable on the one endpoint that needs no org header. The allowlist is the fix.
JSON encoding separately handles newline injection into the logs.

**We keep our own `AsyncLocalStorage` even though nestjs-pino has one.** nestjs-pino's store
hands back a *logger* bound to the request. The SQL comment needs the id as a *value*, and
`PostgresService` is a singleton that must not grow a `requestId` parameter on every call —
`query()` staying the single chokepoint is the property `techContext.md` records about it.

**The ALS context is entered in middleware, not in the interceptor.** An interceptor's pre-phase
returns `next.handle()`, an Observable, which is lazy: the handler runs on *subscribe*, which
happens outside any `als.run()` wrapping the pre-phase. The context would be `undefined` in the
service layer, silently. Middleware wraps the real downstream call stack via `next()`.

**Middleware and interceptor are split by what each can see.** Middleware owns the id, the ALS
context and the `x-request-id` response header — the header has to be set there so 404s and
`ValidationPipe` 400s still carry it. The interceptor owns what middleware structurally cannot
know: which controller and handler ran, the resolved `orgId`, and handler-only duration excluding
Express routing. pino-http's own `request completed` line (fired from `res.on('finish')`) remains
the complete one, covering requests that never reach a handler. The gap between the two durations
is Nest's own overhead, and that gap is worth being able to see.

**Rejected: `application_name` and Redis `CLIENT SETNAME`.** Both are per-*connection*, and both
stores here are pooled singletons. Setting either per request means `connect()` → `SET` → query →
`RESET` → `release`: two extra round trips per request and a change to the pool semantics drill 05
just baselined. A SQL comment travels with the statement and costs nothing.

**Two log levels with distinct jobs.** `info` is one line per request per service, always on.
`debug` is the inside of a request — `handler`, `db_query`, `redis_command`, `upstream_fetch`.
Reconstructing a single request is a `debug` activity, and `debug` is exactly what the A/B prices.

**Postgres statement logging stays off by default**, flipped at runtime by `pnpm db:log:on` /
`db:log:off`. Always-on would change the instrument drill 05 baselined against and make every
future before/after incomparable. **Trap:** `ALTER SYSTEM` writes `postgresql.auto.conf` into the
`drills_pgdata` volume and survives restarts, so leaving it on silently poisons a later load test
— the same shape of trap as `POSTGRES_INITDB_ARGS` in drill 04 and `k6:latest` in drill 05.

**The two loggers are deliberately duplicated, not shared.** `packages/` is empty, and giving it
its first inhabitant means build, tsconfig and Docker wiring neither app has today. The *field
set* is the shared contract; it is documented in `drills/06-observability.md` §6
rather than enforced by a type. Roughly 25 lines of config each.

## The field set

Every line, both services: `time` (ISO-8601, sortable by eye across three streams), `level` (a
string, not pino's numeric 30/40/50), `svc` (`api` / `web`), `msg` (a stable snake_case event
name, never a sentence), and `rid`.

`rid` is absent on exactly the lines that exist outside a request — bootstrap and shutdown.

Per event: `handler` adds `ctrl`/`handler`/`orgId`/`durMs`; `db_query` adds `durMs`/`rows`/`sql`
(whitespace-collapsed and truncated); `redis_command` adds `cmd`/`durMs`; `upstream_fetch` adds
`url`/`status`/`durMs`; `page_render` adds `route`/`totalMs`/`upstreamMs`.

`page_render` carries no `status` on purpose: a Server Component cannot know the HTTP status of
the response it is part of. The upstream status is on `upstream_fetch` instead. This is the first
place the web tier's log is structurally weaker than the API's, and it is worth naming rather
than faking.

pino-http's default `req` serializer dumps every request header — noise, and a leak. Trimmed to
`{ id, method, url }`, and `res` to `{ statusCode }`.

Left out deliberately: `pid`/`hostname` (one container per service, and Docker already labels the
stream — needed the moment there are replicas), `userId` (no auth, a stated non-goal),
request/response bodies and full query strings (size and PII), `trace_id`/`span_id`/`parent_id`
(the stretch reverses this, and their absence is exactly why concurrent work is invisible),
`env`/`version`/`commit` (nothing is deployed yet).

## Files

Backend, new, under `src/observability/`: `request-context.ts` (the ALS, `deriveRequestId`, the
symbol memo, and the single home of the allowlist regex), `request-context.middleware.ts`
(functional middleware), `logging.interceptor.ts`, `logger.options.ts`.

Backend, edited: `app.module.ts`, `main.ts`, `postgres/postgres.service.ts`,
`redis/redis.service.ts`.

Frontend, new: `proxy.ts` at the app root, `lib/logger.ts`, `lib/request-id.ts`. Edited:
`lib/api.ts`, `app/page.tsx`, `app/conversations/page.tsx`, `app/health/route.ts`,
`next.config.ts`.

Root: `package.json` (`logs:trace`, `db:log:on`, `db:log:off`, `db:activity`),
`docker-compose.yml` (`LOG_LEVEL` on both app services), `.env.example`.

Tests: `apps/backend/test/request-id.e2e-spec.ts`.

### Framework details that were checked, not assumed

- **Next 16 renamed `middleware.ts` to `proxy.ts`**, with the export renamed to `proxy`, and it
  now defaults to the Node runtime. Verified in `node_modules/next/dist/docs`. The downstream
  channel is `NextResponse.next({ request: { headers } })` — *not* `next({ headers })`, which is
  the client-facing form.
- **`after()` may only call request APIs inside its callback in Route Handlers and Server
  Functions**, not Server Components. In a page, read the id first and close over it.
- **`forRoutes('*')` is correct on Nest 11.** Express 5's path-to-regexp 8 does reject unnamed
  wildcards, but `@nestjs/core/router/legacy-route-converter.js` rewrites `'*'` to `'{*path}'`
  and deliberately suppresses the deprecation warning for the all-routes case. A `'*'` in the
  middle of a longer path is converted too, but noisily.
- **`LoggerModule` is `@Global()`.** It is registered in `AppModule` only; re-importing it into
  `PostgresModule`/`RedisModule` to reach `PinoLogger` registers its middleware twice and logs
  every request twice.
- **e2e tests never run `main.ts`**, so `app.useLogger` does not apply there and Nest's *internal*
  lines stay pretty-printed under Jest. Our own lines are unaffected — they go through injected
  `PinoLogger`, which exists because `LoggerModule` is in the graph. Same reasoning as the
  `APP_PIPE` note already in `app.module.ts`.
- **`pino`, `pino-pretty` and `thread-stream` are already on Next's automatic
  `serverExternalPackages` list**, so the frontend needs no bundler configuration.
- Versions checked against the registry: `nestjs-pino@4.6.1` (peers `@nestjs/common ^11`,
  `pino ^10`, `pino-http ^11`, `rxjs ^7.1` — all satisfied), `pino@10.3.1`, `pino-http@11.0.0`.
  pino-http is a *peer* of nestjs-pino, so it is installed explicitly rather than inherited.

## Method

New dependencies mean **`pnpm docker:rebuild`, not `up --build`** — `/app/node_modules` is an
anonymous volume Compose carries over on recreate.

The deliverable is one grep. With `pnpm db:log:on` and `LOG_LEVEL=debug`:

```
curl -si -H 'x-request-id: drill06-demo-1' \
  'http://localhost:3001/conversations?org=1&page=1&pageSize=20'
pnpm logs:trace drill06-demo-1
```

`logs:trace` is `docker compose logs --no-color --no-log-prefix -t | sort | grep`.
`--no-log-prefix` is what puts Docker's RFC3339 timestamp first so `sort` merges three streams
correctly; the service is still identifiable from our own `svc` field. `grep` is last because
pnpm appends the script argument to the end of the command string.

The lines are not the point — the **gaps between them** are:

| gap | what it is |
|---|---|
| `page_render.totalMs − upstreamMs` | Next's own render |
| `upstreamMs − responseTime` | HTTP plus JSON serialisation |
| `handler.durMs − Σ db_query.durMs` | framework and pool |
| `db_query.durMs − postgres duration` | **pool wait plus wire** |

That last row is the first thing that can test drill 05's finding #2, which is currently an
inference from timings rather than an observation. Note the two `db_query` lines overlap
(`Promise.all`), so their durations sum to more than the elapsed time — which is precisely what a
flat log cannot express and a span tree can.

Then `pnpm db:log:off`, and verify it actually went off, because `ALTER SYSTEM` persists.

**The overhead A/B.** Statement logging off first (it would swamp the comparison), then
`VACUUM (ANALYZE) conversations`, settle 10s, then `ORG_ID=150 pnpm load:baseline` at
`LOG_LEVEL=silent` / `info` / `debug`, **two rounds interleaved in one sitting** — drill 05's own
rule, since its medians drifted up to 14% across sittings and monotonically. Org 150 is the
log-heavy case at ~4,400 req/s. Judged against drill 05's stated floor: ~15%, 20% on the tail.

At `debug` that is roughly 13k log lines/s into Docker's `json-file` driver, which has no size cap
unless one is configured — on the order of 200MB for a single 60s run. Note also that k6 addresses
`nest_server:3002` directly, bypassing Next, so those runs exercise the *generate* path rather
than the *accept* path.

## Results

Shipped. The reconstruction, the gap arithmetic and the full tables are in
`drills/06-observability.md` §13–14; this is the record of what was decided by measuring.

**The DONE WHEN holds.** One grep returns 12 lines across three services for one request:
Postgres parse/bind/execute per statement, `db_query` / `handler` / `http_request` from the API,
`upstream_fetch` / `page_render` from the web tier. 27 e2e tests pass across 4 suites.

**Drill 05's finding #2 is confirmed, and is no longer an inference.** The two `Promise.all`
queries of a single request are executed by two different Postgres backend PIDs (27539 and 27547).
One request, two pooled connections.

**The overhead is a fixed ~0.9ms per request, not a percentage.** Tail org (2ms requests): −26.7%
throughput with logging *silent*, −30.7% at `info`, −34.7% at `debug`. Whale org (176ms requests):
no measurable effect at all — "before" landed *between* two "after" runs on every metric. Both are
the same fact seen from different ends, and the tail figure is the worst case by construction.
The whale numbers also reproduce drill 05's recorded baseline (48.02 vs 48.57 req/s), which
independently validates both drills' harnesses.

**The plumbing costs four times what the logging costs.** Installing the machinery with every line
suppressed is 26.7%; emitting the lines adds 5.4% (info) or 10.9% (debug). "Silent" still pays for
the ALS, the middleware, pino-http's per-request child logger and the SQL comment concatenation.

**A suppressed log line still evaluates its arguments.** `logger.debug({ sql: summarise(text) })`
ran a regex over every statement at every level. Guarding with `isLevelEnabled` recovered 6.0% at
silent and 5.0% at info, and — as predicted — nothing at debug, where the guard is always true.
That the null prediction held is what makes the other two believable.

### Fixed after review, worth recording as traps

- **pino-http logs every 5xx at `info`** without `customLogLevel`, so `grep '"level":"error"'`
  never finds a server error.
- **`customProps` is applied twice** (child creation, then response), so a field that changes
  mid-request emits a duplicate JSON key with two values. `status` cannot live there; `rid` can.
- **nestjs-pino's `exclude` also drops the request context**; `autoLogging.ignore` is the narrower
  tool. And the frontend's `/health` calls the API's `/info`, so excluding only `/health` silences
  the quieter probe.
- **A thrown query logged as `db_query` with `rows: null` reads as an empty result set** — and
  `pg` returns exactly that for non-row commands. Failures get `db_query_failed` at `error`.
- **Injecting `PinoLogger` into `PostgresService` broke `schema.e2e-spec.ts`**, which boots
  `PostgresModule` alone without the global `LoggerModule`. The logger is a module-level const
  instead; DI bought nothing, since every line passes `rid` explicitly anyway.
- **`RequestInit.headers` may be a `Headers` instance**, and spreading one yields `{}` — silently
  dropping every header. `new Headers(init?.headers)` is the form that cannot break.

## Risks

- **Logging may cost more than the noise floor can resolve**, in which case the A/B reports
  "under 15%, not distinguishable" rather than a number. That is still an answer.
- **`debug` at 4,400 req/s may be disk-bound rather than CPU-bound**, which would make the
  measurement about Docker's log driver rather than about pino. Worth naming if the numbers look
  strange.
- **Next's own dev request lines are not JSON and cannot be made so**, so the web stream is mixed
  format in development. `logging.incomingRequests.ignore` mutes the 5-second healthcheck line;
  the rest stays.
- **Postgres's own log stays plain text.** `log_destination=jsonlog` exists but requires
  `logging_collector`, which writes to a file inside the container instead of stdout, taking those
  lines out of `docker compose logs` entirely — a worse trade than mixed formats.
- **Postgres statement logging includes bind parameter values** (governed by
  `log_parameter_max_length`), so it is PII-bearing the moment the data is real.
- **Cross-container timestamp ordering is good to milliseconds, not causally correct.** `sort`
  merges three clocks that only approximately agree. This is the argument for spans, and it is
  the honest limit of what this phase builds.

## Phase 2 — the stretch: OpenTelemetry spans and a local collector

Separate evening, separate commit, only after the A/B numbers above are recorded. Off by default:
compose services under `profiles: ['trace']`, SDK gated on `OTEL_EXPORTER_OTLP_ENDPOINT`, so
drill 05's baseline instrument stays unchanged for cards 08/09/10.

The payoff is not "now there are traces" — it is that every hand-built piece above has a standard
equivalent, and building it by hand first is what makes the standard legible:

| this phase, by hand | phase 2, the standard |
|---|---|
| `x-request-id` forwarded in `lib/api.ts` | `traceparent` (W3C), propagated by the HTTP instrumentation with no code |
| `/* rid=… */` in `PostgresService.query()` | `@opentelemetry/instrumentation-pg`'s sqlcommenter option |
| our `AsyncLocalStorage` | OTel's context API, the same mechanism underneath |
| `pnpm logs:trace <id>` + `sort` | a waterfall ordered by parent/child, immune to clock skew |

`apps/backend/src/tracing.ts` — a `NodeSDK` with five targeted instrumentations (`-http`,
`-express`, `-nestjs-core`, `-pg`, `-ioredis`) rather than `auto-instrumentations-node`, which
drags in ~40 packages for stores this app does not have. It must initialise before `@nestjs/core`
loads; Nest compiles to CommonJS, so `import './tracing';` as the literal first import of
`main.ts` runs first. Fallback if `nest start --watch` disagrees: `node --require
./dist/tracing.js dist/main`.

`apps/frontend/instrumentation.ts` — Next's startup hook, dynamic-importing
`instrumentation.node.ts` under a `NEXT_RUNTIME === 'nodejs'` guard.

`otel/collector.yaml` plus `otel/opentelemetry-collector-contrib:0.158.0` and
`jaegertracing/jaeger:2.20.0`, both pinned. Jaeger accepts OTLP directly and could stand alone; the
collector earns its place because it is where sampling, redaction and fan-out live, and its `debug`
exporter shows raw spans without trusting a UI.

What a trace shows that these logs don't, concretely, in this app: the two `Promise.all` queries
as **overlapping sibling spans**; **pool acquisition** separated from execution — drill 05's
inference, finally a number; Next's render-vs-fetch split with no code written; and causality that
survives clock skew. The converse belongs in the writeup too: a trace carries no message text and
no arbitrary fields, and sampling means the one request you care about may not be in there. Which
is why this phase does not get deleted.

### Revised while shipping

Four things the plan above got wrong or did not know. All four were found by looking at output.

**`@vercel/otel` was dropped for the same `NodeSDK` the API uses.** It is the documented Next path
and it is fine, but it declares seven OTel peer dependencies, and the frontend needs *no*
instrumentations at all: Next already emits `BaseServer.handleRequest`, `render route (app) …` and
`AppRender.fetch` through `@opentelemetry/api`, which it declares as a peer. Registering a provider
is the whole job. One SDK on both sides also means one thing to learn, matching the decision above
to duplicate rather than share the two loggers. `serverExternalPackages` is required so the SDK is
not bundled into a second copy of `@opentelemetry/api`.

**Nothing injects `traceparent` on the Next → Nest hop.** The plan's table said the HTTP
instrumentation propagates it "with no code". True inbound on Nest; false outbound on Next, which
creates an `AppRender.fetch` span but never writes the header (`patch-fetch.js` has no mention of
it). So `lib/trace.ts` does `propagation.inject(context.active(), headers, …)` by hand. The lesson
is better than the plan's version: same standard, automatic on one side and explicit on the other.

**The "one id" join does not survive Next's proxy, and the plan's version of it was wrong.** It
said `deriveRequestId` should return the trace id when a span is active. On the API that is
correct. In `proxy.ts` it produced a valid, greppable id belonging to a *separate one-span trace* —
Next runs proxy execution in its own trace (`middleware GET`, no parent), not inside the render's.
The id looked right and pointed at the wrong thing, which is worse than not having it. So: the
frontend mints a UUID, the API keeps the trace-id fallback (it fires for direct API traffic), and
`trace_id`/`span_id` on every log line is the join.

**The SQL comment and sqlcommenter are mutually exclusive.** `@opentelemetry/sql-common` refuses to
add its comment to a statement that already has one — the sqlcommenter spec says so — so phase 1's
`/* rid=… */` silently disabled the standard. Separately, `instrumentation-pg` derives its span name
from the first token of the statement, so a *leading* comment renamed every query span to
`pg.query:/*`. Both fixed by moving ours to the end and skipping it entirely when tracing is on:
the traceparent comment identifies the span, not just the request, which is strictly more, and
`trace_id` is on every log line so one grep still reaches Postgres.

Also: pnpm 11 fails `install --frozen-lockfile` on an undecided build script, and `sdk-node`'s gRPC
exporters pull `protobufjs`. `allowBuilds: { protobufjs: false }` in `pnpm-workspace.yaml` is that
decision — without it the Docker image build fails, which is where it was found.

### Phase 2 results

**The DONE WHEN, again.** One grep on the trace id returns the whole path, and Postgres's log now
identifies the *span* rather than just the request — the two concurrent statements of one request
carry different span ids in their `traceparent`, which the `/* rid= */` version could not express.

**The headline.** A `db_query` line said the count query took 7.90ms. The trace decomposes it:
**5.48ms of `pg-pool.connect`** (4.53ms of that opening a new socket) and **2.09ms executing**. The
list query beside it was 8.35ms logged against 8.12ms executing — 0.23ms of overhead. Drill 05's
finding #2 has now been through three states: inference from timings, observation via two backend
PIDs, and a number.

**Cost.** Tail org, 3 arms x 2 rounds, strictly interleaved, Jaeger recreated between arms:

| arm | p50 | p95 | p99 | throughput | vs off |
|---|---|---|---|---|---|
| off | 3.05 ms | 4.21 ms | 5.67 ms | 3,121.31 req/s | — |
| on, 5% sampled | 4.53 ms | 6.48 ms | 8.36 ms | 2,123.94 req/s | −32.0% |
| on, 100% sampled | 5.29 ms | 8.77 ms | 12.41 ms | 1,729.46 req/s | −44.6% |

Within-arm spread 2.1% / 2.7% / 3.9%, monotonic in both rounds. **Dropping 95% of traces buys back
28% of the cost** — the sampler decides at span *creation*, so an unsampled request still runs every
patched function and allocates ~15 spans. Which is the A/B above in a different costume: the
plumbing, not the output, is the expensive part, twice. The lever is fewer instrumentations, not a
lower sample rate.

The `off` arm lands at 3,121 against phase 1's 3,276 — −4.7% across two sittings, inside drill 05's
14% cross-sitting drift, so: no measurable regression with tracing off. That is the number cards
08/09/10 depend on.

**Two traps and one wrong guess.** Jaeger all-in-one keeps traces in RAM and was SIGKILLed by its
1g limit at 100% sampling on the first attempt; the harness now recreates it per arm. And the
collector's `debug` exporter at `verbosity: normal` prints one line per span (~10k lines/s under
load) — an obvious confound, changed to `basic`, and on re-measurement **it was not the
explanation**: the `normal` run came out marginally faster. Recorded because "obvious cause,
unmeasured" is the failure this whole method exists to avoid.
