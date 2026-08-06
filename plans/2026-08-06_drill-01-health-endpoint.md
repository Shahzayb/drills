# Drill 01 — backend wired to Postgres + Redis, proved by /health

**Status:** shipped

## Context

The Compose stack (`docker-compose.yml`, `Dockerfile`, `.env.example`, `scripts/setup.sh`) is done and runs. But the backend inside it is still the untouched NestJS starter — it has no Postgres or Redis client, so "the stack is up" currently means four containers that don't talk to each other. `memory-bank/progress.md` names this as the next step: *"Drill 01 — get Postgres, Redis, the API and the web app up under one command."*

This closes that step. The backend gets real connections to both data stores, and `GET /health` is the proof: one curl that says whether each dependency is actually reachable. That endpoint is also the foundation later drills need — the failure/resilience and caching drills both require a way to observe a dependency going away.

`README.md` still documents `pnpm install && pnpm dev`, which is no longer how the stack runs. It gets replaced with the Docker commands.

## Decisions

- **Raw `pg` + `ioredis`, no ORM and no `@nestjs/terminus`.** Terminus' built-in indicators only cover TypeORM/Sequelize/Mongoose for SQL and need `@nestjs/microservices` for Redis — it would pull in an ORM we don't want yet and we'd still hand-write the indicators. `projectbrief.md` is explicit that no schema is built up front and the learning target is Postgres itself. `ioredis` is also what BullMQ requires for the later background-jobs drill.
- **503 when a dependency is down**, with per-check detail in the body either way. Makes the endpoint usable as a container healthcheck.
- **Connection settings live in `.env`, consumed via the existing `env_file:`.** No per-service `environment:` overrides — one file stays the single source of truth for configuration.
- **No env-loading library** (`@nestjs/config`, `dotenv`). Docker is the only supported way to start the backend, and Compose already injects `.env` into the container's environment — the process just reads `process.env`. A loader would only have earned its place for host-side `pnpm dev` runs, which aren't a path we use.

## Changes

### 1. Dependencies

`pg` + `ioredis` in `apps/backend` dependencies, `@types/pg` in devDependencies. Root `pnpm install` updates `pnpm-lock.yaml`, which the Dockerfile installs with `--frozen-lockfile`.

**Getting them into the container takes three things, not two.** `docker-compose.yml` bind-mounts `./apps/backend` over `/app/apps/backend`, so the container resolves through the *host's* `apps/backend/node_modules`, whose symlinks are relative (`../../../node_modules/.pnpm/pg@…`) and land in `/app/node_modules` — the anonymous volume. So: host `pnpm install`, image rebuild, **and renew the anonymous volume**. An anonymous volume is populated from the image only when first created and Compose carries it over on recreate, so a plain `build && up -d` leaves the container resolving against the pre-`pg` tree and failing with `Cannot find module 'pg'` from an image that visibly contains it.

```bash
docker compose up -d --build --force-recreate --renew-anon-volumes
```

`docker:rebuild` in the root `package.json` is updated to match, so the trap isn't re-sprung on the next dependency added.

Note: `docker:clean` runs `docker system prune -f`, which deletes *all* stopped containers system-wide, not just this project's. Left as-is but worth knowing before running it.

### 2. `apps/backend/src/database/`

`database.constants.ts` (`PG_POOL`, `REDIS_CLIENT` tokens) and `database.module.ts` — `@Global()`, both clients from factories, `OnApplicationShutdown` closing them. Config from `process.env` with fallbacks, so the module constructs with no environment at all — which is what lets Jest instantiate `AppModule` outside Docker.

Three gotchas:

- **`lazyConnect: true` and `enableOfflineQueue: false` cannot be combined.** With the offline queue disabled ioredis rejects commands whenever status isn't `ready`, and a lazy client starts in `wait` — so the first `ping()` would reject *without ever attempting to connect*, reporting a healthy Redis as down. Offline queue stays at its default; the health-check timeout is what makes a down Redis fail fast.
- **`lazyConnect` is what keeps the existing e2e test green.** `test/app.e2e-spec.ts` compiles `AppModule` with no Docker running; an eager client would open a failing socket at module init and leave a hanging handle. Teardown is guarded — `quit()` on a never-connected client throws.
- Without an `on('error')` listener, an unreachable Redis emits an unhandled error event and takes the process down — the opposite of what a health endpoint is for.

### 3. `apps/backend/src/health/`

`health.service.ts` runs both probes concurrently under a ~2s timeout — Postgres `SELECT 1`, Redis `ping()` — each resolving to `{status, latencyMs}` or `{status: 'down', error}`, never throwing. `health.controller.ts` returns the body on all-up, else throws `ServiceUnavailableException(body)`; passing an object makes it the entire response body, so 200 and 503 carry the same shape.

`main.ts` gains `app.enableShutdownHooks()` — without it `onApplicationShutdown` never fires on `docker compose down`.

### 4. Compose and env

`POSTGRES_HOST=postgres_db` / `REDIS_HOST=redis_cache` into `.env` and `.env.example` (the existing `env_file:` picks them up). `nest_server` gains a `wget`-based healthcheck against `/health`; `next_app` is upgraded to `depends_on: {nest_server: {condition: service_healthy}}`. Memory limits are unchanged — they're intentional.

Known wrinkle: `POSTGRES_PORT`/`REDIS_PORT` now serve double duty — host-publish side and the port the backend dials in-network. They agree at the defaults; if a host conflict ever forces a change, split out a `POSTGRES_HOST_PORT` for publishing.

## Non-goals

- No schema, no migrations, no ORM. `/health` runs `SELECT 1` and nothing else.
- No auth on the endpoint.
- No frontend change — it doesn't call the backend yet.

## Verification

Rebuild with `--renew-anon-volumes`; `docker compose ps` shows all four up and three healthy; `curl localhost:3002/health` → 200 with both checks up; `docker compose stop redis_cache` → 503 with redis down and postgres still up, `nest_server` unhealthy; restart Redis and confirm it recovers on its own. Backend unit + e2e tests still pass with no containers running.
