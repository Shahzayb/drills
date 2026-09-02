# drills

A playground repo. A multi-tenant customer-feedback platform built across 32 drills, each
one breaking something on purpose and measuring it at scale. Nothing is built ahead of the drill that needs
it, and naive code is often a recorded decision rather than debt.

pnpm monorepo: `apps/backend` (NestJS, raw `pg`, no ORM) and `apps/frontend` (Next.js App Router),
orchestrated by Turborepo. Postgres and Redis run alongside under Docker Compose.

## Progression — 12 of 32

| # | Drill | Result worth remembering |
|---|---|---|
| 01 | Health endpoint | Checks Postgres and Redis together, gives up after 2s, returns 503 if either is down. |
| 02 | Schema and migrations | Five hand-written tables, a tenant id on every row, some gaps left in on purpose. |
| 03 | Endpoint + RSC page | The first list endpoint, built deliberately slow: no index, no cache, offset paging. |
| 04 | Bulk load | Loaded 12.5M rows in under two minutes; dropping the foreign key first was the biggest win. |
| 05 | Load-test baseline | The biggest tenant was already far slower than a small one before any tuning — the "before" number. |
| 06 | Observability | One id follows a request across every service, with structured logs and optional traces. |
| 07 | Tenant isolation | The database itself now stops one tenant from reading another's rows; 14 tests prove it. |
| 08 | N+1 detection | Cutting one request from 37 queries to 3 nearly tripled throughput for the small tenant. |
| 09 | Indexes and the planner | An index took one query from 108ms to a fraction of a millisecond, and the planner knows when to skip it. |
| 10 | Keyset pagination | Cursor paging stays fast on deep pages while offset paging keeps getting slower. |
| 11 | Full-text search | A real search index handled far more traffic than a plain text match, once a config quirk stopped hiding it. |
| 12 | Idempotent ingest | 10,000 duplicate deliveries still produced exactly 3,000 rows, held by a unique constraint. |

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
pnpm load list          # k6 baseline run (load search, load <script> --help)
pnpm trace:on           # spans + collector + Jaeger on :16686 (trace:off)
pnpm logs:trace <id>    # one request across all services
pnpm check:tenancy      # RLS coverage + the serving role cannot bypass it
pnpm db:explain plans   # query plans for the list endpoint (sweep, experiments, stats, keyset)
pnpm db:paging depths   # latency vs page depth, both paging arms (walk, concurrent)
pnpm db:search plans    # LIKE vs full-text search (indexes, gaps, writes)
pnpm db:storm fire      # 10k duplicate deliveries; asserts and exits 1 (key, race, redis-restart)
pnpm format
pnpm lint
```

See [CLAUDE.md](CLAUDE.md) for how to work in here.
