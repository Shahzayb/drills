# drills

A learning repo. A multi-tenant customer-feedback platform built across 32 drills, each
one breaking something on purpose and measuring it at scale. Nothing is built ahead of the drill that needs
it, and naive code is often a recorded decision rather than debt.

pnpm monorepo: `apps/backend` (NestJS, raw `pg`, no ORM) and `apps/frontend` (Next.js App Router),
orchestrated by Turborepo. Postgres and Redis run alongside under Docker Compose.

## Progression — 8 of 32

| # | Drill | Result worth remembering |
|---|---|---|
| 01 | Health endpoint | Postgres + Redis probes, concurrent, 2s timeout, 503 if either is down. |
| 02 | Schema and migrations | 5 tables, hand-written SQL; `org_id` on every tenant row; gaps left on purpose. |
| 03 | Endpoint + RSC page | `GET /conversations`, deliberately naive — offset paging, no index, no cache. |
| 04 | Bulk load | 12.5M rows via `COPY` in 104s; dropping the FK before load was the biggest lever. |
| 05 | Load-test baseline | Whale org p95 340ms @ 49 req/s vs tail org 2.9ms @ 4,415 — the `before` column. |
| 06 | Observability | One request id across 4 processes, structured logs, OTel spans behind a flag. |
| 07 | Tenant isolation | Row-level security under four deliberately filterless endpoints; 14 tests fail without it. |
| 08 | N+1 detection | Tail org: 2.77x throughput fixing a 37-query request down to 3; `pg_stat_statements` finds it, an ORM couldn't hide it either. |

Current state and what's open live in `memory-bank/progress.md`; every decision and
number is one row in `memory-bank/history.md`, with the full reasoning in `plans/`.

## Setup

```bash
pnpm run setup
```

Creates `.env` from `.env.example` and starts everything. `pnpm run setup`, not `pnpm setup` — pnpm
has a built-in `setup` command that shadows the script.


## Commands

```bash
pnpm docker:up          # start        (docker:down, docker:logs)
pnpm db:reset           # migrate + seed from scratch (db:migrate, db:seed, db:psql)
pnpm db:test            # backend e2e suite, inside the container
pnpm load:baseline      # k6 baseline run
pnpm trace:on           # spans + collector + Jaeger on :16686 (trace:off)
pnpm logs:trace <id>    # one request across all services
pnpm check:tenancy      # RLS coverage + the serving role cannot bypass it
pnpm format
pnpm lint
```

See [CLAUDE.md](CLAUDE.md) for how to work in here.
