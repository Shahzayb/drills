# Drill 23 — Shut down without dropping a request

**Status:** planned

Card 23. Prereq 15. Branch `drill-23` (from `main` at `0ce8935`). Saved as
`plans/2026-10-11_drill-23-graceful-shutdown.md`.

## Context

Every deploy sends SIGTERM to a running API. Today `main.ts` calls `app.enableShutdownHooks()` and
nothing else. Nothing tells a load balancer to stop routing, nothing finishes keep-alive traffic,
and the import worker (drill 15) is not awaited by anything. The card asks for a measured
before/after: restart under sustained k6 load, count dropped requests, then build a drain with a
hard deadline. It also asks for an event-loop-lag graph and a decision on what health reports
while draining.

Facts from reading the code and probing:

1. **Nest's shutdown order (11.1.28, installed source):** `onModuleDestroy` → `beforeApplicationShutdown(signal)`
   → `dispose()` (`server.close()`, awaited) → `onApplicationShutdown` (pool and Redis close here)
   → `process.kill(pid, signal)`. Shutdown hooks run module by module, root-first. The order
   between two modules at the same depth is not something to rely on.
2. **`server.close()` does not stop keep-alive traffic (probed on Node 22.23).** After `close()`,
   an in-flight response still says `Connection: keep-alive`. The next request on that socket is
   still served. The close callback fired 6.5s later (keep-alive timeout 5s after the last
   request). Behind an LB that reuses connections, `close()` can wait until the container is
   SIGKILLed.
3. **One container cannot restart with zero errors.** Nothing answers while it is down. Zero
   errors needs two replicas behind a load balancer and a rolling restart.
4. **The dev container's PID 1 is `pnpm`**, then `nest start --watch`, then `node dist/main`.
   Whether SIGTERM reaches Node through that chain is unknown. It gets measured, not assumed.
5. **The import worker** (`ImportsService.detach`) is fire-and-forget. `pool.end()` during a
   batch makes the next `connect()` reject. Then `finish()` fails too, and the job stays
   `running`. That is the card's scenario. `import_jobs.status` has no CHECK constraint.
6. The `/health` route checks Postgres and Redis. Docker's healthcheck and `request-id.e2e-spec.ts` use it.
   `PROBE_ROUTES` already keeps `/health*` out of the logs.

## Decisions

1. **One arm switch, `SHUTDOWN=exit|nest|graceful`** (default `graceful`), exported from
   `health.service.ts`. It appears on `/info`, in compose, and in `check:arms`.
   - `exit`: `main.ts` registers no handler. Node's default SIGTERM disposition kills the process.
     This is "the process just exits".
   - `nest`: `enableShutdownHooks()` only. This is the code as shipped today.
   - `graceful`: the drain below.
2. **The drain lives in `HealthService.beforeApplicationShutdown(signal)`**, the Nest hook that runs
   before Nest closes the server. It runs only when `signal` is set and the arm is `graceful`.
   The e2e suites call `app.close()` without a signal, so they skip it. Sequence:
   1. Set `draining = true`. `GET /health` answers 503 `{status:'draining'}`.
   2. Wait `DRAIN_DELAY_MS` while still serving normally. This is the LB's detection window.
   3. Close the listener. From then on every response carries `Connection: close`. Call
      `closeIdleConnections()`. Wait for in-flight requests to reach 0.
   4. Nest continues: `dispose()` → `onApplicationShutdown` (pool, LISTEN clients, Redis) → exit.
   In-flight count and the `Connection: close` header come from one `prependListener('request')`
   on the Node server, reached through `HttpAdapterHost`. It is registered in `onApplicationBootstrap`.
3. **The import drains itself.** `ImportsService.beforeApplicationShutdown(signal)` sets
   `stopping`. `writeBatch` throws `interrupted by shutdown` before opening the next transaction.
   The batch in flight commits. `run()`'s existing catch writes `failed`, the error text and
   `resume_row`. The hook awaits every running job. Module order does not matter here: the pool
   closes only after every `beforeApplicationShutdown` hook has returned. A retry resumes from
   `resume_row` through the existing `POST /imports/:id/retry`. Auto-resume needs a lease or queue
   (card 30), and is recorded as a gap.
4. **Hard deadline in `main.ts`** (graceful only). On SIGTERM/SIGINT it arms an unref'd timer of
   `SHUTDOWN_TIMEOUT_MS`. When the timer fires, it logs `shutdown_deadline_exceeded` with in-flight
   count and phase, then calls `process.exit(1)`. It lives in `main.ts` because only the process
   owner may exit, and the e2e suite never runs `main.ts`. The live instrument proves it instead.
   The replicas' `stop_grace_period` MUST exceed it, or Docker's SIGKILL wins.
5. **Health.** `GET /health` is readiness: 503 while draining, otherwise the existing dependency
   check. New `GET /health/live` is liveness. It answers 200 while draining, checks no dependency,
   and reports `draining` and the event-loop window. Readiness failing pulls the replica from
   rotation. Liveness failing would get it SIGKILLed mid-drain.
6. **Event-loop lag.** `HealthService` runs `monitorEventLoopDelay` and closes a window every
   `EVENT_LOOP_LOG_MS || 1000` ms (p50, p99, max). When `EVENT_LOOP_LOG_MS > 0` it logs each window
   as `event_loop` with `inFlight` and `phase`. Logs are the only channel that survives the
   listener closing. Default 0, so normal runs log nothing.
7. **Measurement topology, `profiles: ['drain']`:** `api_a`, `api_b` and `lb`.
   - `api_a`/`api_b` `extends: nest_server`. They run `node apps/backend/dist/main` directly, with
     `init: true` (tini forwards the signal) and `stop_grace_period: 30s`. Ports are `!reset`.
     The Docker healthcheck is `/health/live`. Both share a named volume on `/tmp/imports`, so
     either replica can resume the other's import. `dist/` comes from the dev server's build.
   - `lb`: `haproxy:3.4.6-alpine` (pinned, newest LTS). `haproxy/haproxy.cfg` uses roundrobin with
     an active check `GET /health` at `inter 1s fall 2 rise 2`. It sets **`retries 0`** with no
     redispatch, so the LB never hides an app failure. It adds `x-served-by` from `%[srv_name]`
     and logs only abnormal sessions (termination codes like `SC`/`SH` say who closed what).
     Published on `:8080`. The stats page on `:8404` lets the instrument see UP/DOWN.
8. **Load: `k6/drain.ts` (`pnpm load drain`), open model.** constant-arrival-rate at `--rate`
   against `http://lb:8080`. The mix, chosen by iteration:
   - 6/10 `GET /conversations?pageSize=20`, orgs 2–10
   - 2/10 `GET /messages/search?q=export&limit=20`, orgs 2–10
   - 2/10 `POST /ingest`, org 1 (pro, unlimited), events `k6-drain-*`, so the cleanup SQL in
     `progress.md` applies
   Each failure is `console.log`ged as one JSON line (`t`, endpoint, status, `error_code`,
   `x-served-by`) into `failures.ndjson` in the report directory (`--log-format raw
   --log-output file=`). The summary adds errors by status and by endpoint. The error threshold is
   loosened so a broken arm reports instead of aborting.
9. **Orchestrator: `scripts/drain.ts` (`pnpm drain`).** It runs on the host because it calls
   Docker, the same as `scripts/load.ts`. Steps:
   1. `up -d --no-deps api_a api_b lb` with the arm env and `EVENT_LOOP_LOG_MS=250`. Wait until
      both servers are UP.
   2. Record `/info` arms from each replica.
   3. Spawn `node scripts/load.ts drain …` and read its report directory.
   4. Upload a generated CSV (`--rows`, same header as `db/import.mts`) through the LB, then read
      `x-served-by`.
   5. Rolling restart: `docker restart` the import's replica, wait for UP, wait 10s, restart the
      other.
   6. After k6 ends, read the job. If interrupted, retry it and verify `rows_written +
      rows_skipped = rows`.
   7. Parse `docker compose logs -t` (pino `event_loop`/`drain_*`, HAProxy state changes and
      errors).
   8. Write `drain.txt` (timeline, errors per second, import outcome, SIGTERM→exit per replica) and
      `timeline.json` into the same report dir. Print a mermaid `xychart-beta` of lag per window.
   `--slow` fires one uncached whale `GET /messages/stats` (~3s) during the drain delay. Paired with
   a short `SHUTDOWN_TIMEOUT_MS`, it demonstrates the deadline.
10. **Deadline numbers are decided by measurement, then defaulted.** `DRAIN_DELAY_MS` must be at
    least the measured SIGTERM→LB-DOWN time × 1.5. `SHUTDOWN_TIMEOUT_MS` = delay + the longest
    measured request or batch × 2, rounded up. `stop_grace_period` sits above it. The provisional
    values are 3000 and 10000. The write-up shows the arithmetic.

## What ships

**Edits**
- `src/main.ts`: arm-dependent `enableShutdownHooks()`, deadline timer.
- `src/health/health.service.ts`, `health.controller.ts`, `health.module.ts`: knobs, draining
  state, request listener, drain hook, lag windows, `/health/live`.
- `src/imports/imports.service.ts`: `stopping`, running-job set, `beforeApplicationShutdown`.
- `src/info/info.controller.ts` + `test/arms.e2e-spec.ts`: `shutdown`, `drainDelayMs`,
  `shutdownTimeoutMs`, `eventLoopLogMs`.
- `docker-compose.yml`: four env vars on `nest_server`, the `drain` profile services, the named
  volume. `.env.example`.
- Root `package.json`: `drain`, `db:test:nodrain`. `scripts/load.ts` catalog: `drain`.
  `.gitignore`: `k6/reports/**/failures.ndjson` only if large.

**New**
- `haproxy/haproxy.cfg`, `k6/drain.ts`, `scripts/drain.ts`.
- `test/shutdown.e2e-spec.ts` (calls the hooks directly; `close()` is typed without a signal):
  1. While draining, `/health` is 503 `draining` and `/health/live` is 200.
  2. A request in flight when the listener closes finishes 200 with `Connection: close`.
  3. A keep-alive socket gets `Connection: close` on its next response after close.
  4. A running import stops at a batch boundary: `failed`, error `interrupted by shutdown`,
     `resume_row` a multiple of the batch size. A retry lands exactly N rows.
  Red run: `db:test:nodrain` (`SHUTDOWN=nest`) MUST fail exactly these 4.

## Predictions, recorded before measuring

1. `exit`: every request in flight on the killed replica fails, and so does every new connection
   until HAProxy marks it DOWN (≈2s × half the traffic). Expect roughly 100–300 errors per
   restart, and the import stuck `running`.
2. `nest`: in-flight requests finish. New connections are refused for ~2s, and keep-alive races
   produce `SH`/`SC` 503s. The close drags on for seconds after DOWN, and the import is stuck
   `running`. Fewer errors than `exit`, not zero.
3. `graceful`: 0 errors on two consecutive runs. SIGTERM→exit ≈ `DRAIN_DELAY_MS` + <500ms. The
   import ends `failed`/interrupted at a batch boundary and a retry completes exactly.
4. Lag p99 at steady state stays under 20ms and falls during the drain as load leaves. The drain
   itself never blocks the loop. A blocked loop would also block the deadline timer, which is why
   Docker's SIGKILL stays the real backstop.
5. `docker compose restart nest_server` takes ~10s because SIGTERM never reaches Node.

## Measurement

The stack in use is this worktree's (`drills` project). Every compose call names only its own
services and uses `--no-deps`.

1. Probe the dev container's signal path: time a restart and read the logs for Nest's shutdown.
2. Calibrate: one replica alone, find the rate it serves at p99 < 500ms. Run at ~50% of that, so
   one replica carries everything mid-restart.
3. Measure SIGTERM→DOWN and the longest request or batch, then set the two defaults.
4. Interleaved in one sitting: `exit`, `nest`, `graceful`, `graceful`. Each is a full rolling
   restart of both replicas, with an import running on the first.
5. Deadline demo: `graceful` + `SHUTDOWN_TIMEOUT_MS=4000 --slow`. Expected: exit code 1, one
   abandoned request as a 502, and the log listing it.
6. `pnpm db:test` green, `db:test:nodrain` red 4, `pnpm test:ui` green. Afterwards remove
   `api_a`/`api_b`/`lb` and the drain volume. Clean up the `k6-drain-*` rows.

## Stretch (only on your go): backpressure

`MAX_IN_FLIGHT` per replica. The excess gets 503 + `Retry-After: 1` from the same in-flight
counter, in middleware. Overload at ~2× one replica's capacity, and compare p99 and errors with
and without the bound.

## Write-up and guide

The plan's Results and Write-up answer the card's three questions: the deadline and its basis,
what readiness says while draining and what breaks if it stays OK, and what Cloudflare Workers did
for free (no process lifecycle, old isolates finish in-flight requests, `ctx.waitUntil`, no pool
to close, edge routing with no health checks).

`drills/23-graceful-shutdown.md` (gitignored) is drafted in the worktree and copied to the main
checkout. It contains: ELI5, a sequence diagram of SIGTERM → readiness → LB DOWN → close → drain →
exit, the lag graph, every command with its result, the keep-alive probe, a tech stack cheat sheet
(Node signals and PID 1, `server.close` vs keep-alive, Nest lifecycle order, HAProxy checks,
k6 open model), `Is this production ready?`, `Honest gaps`, and `What I'd do differently at 10x`.

## Memory bank compaction (end of drill)

This is a removal pass under the skill's budgets. `history.md` is 5,258 words; older rows get
compressed to their outcome plus one constraint. `progress.md` sits at 1,498/1,500 words; resolved
or stale items get pruned. `techContext.md` gains the shutdown contract. Verified facts are written
directly. Anything that removes a judgment or open decision gets proposed to you first.

## Workflow

1. `git switch -c drill-23`. Write the plan file and the `planned` history row, then commit.
2. Commits: health + drain + import drain + tests → compose/HAProxy/k6/orchestrator.
3. Measure, then record results in the plan.
4. Guide; README row.
5. `pnpm format`, `pnpm lint`, `pnpm typecheck`, `pnpm check:arms`.
6. Memory bank update + compaction. History row → `implemented`.
7. PR, then the `drill/23` release (0.23.0), tagged on the branch before the merge.

## Verification

- `curl -si localhost:8080/health` shows `x-served-by` alternating between a and b.
- `docker kill -s TERM drills_api_a`, then `/health` on that replica returns 503 `draining`
  within ms, and HAProxy's stats page shows it DOWN within ~2s.
- `pnpm drain --arm graceful` twice: 0 errors in both summaries and an empty `failures.ndjson`.
- `pnpm drain --arm exit` and `--arm nest`: nonzero errors with timestamps clustered at each
  SIGTERM.
- `pnpm db:test` green, `db:test:nodrain` red exactly 4, and `pnpm arms` shows the shutdown knobs.
