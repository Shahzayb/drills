# Drill 02 — the five core tables, and migrations that run backwards

**Status:** shipped

## Context

Drill 01 left the backend connected to Postgres with nothing in it — `/health` runs
`SELECT 1` and `/info` reads `version()`. `projectbrief.md` is explicit that no schema is
built up front; this is the drill where the first one lands.

`node-pg-migrate@9` is already installed in `apps/backend` devDependencies, with an empty
generated migration file and a `migrate` script. This plan fills both in.

The schema itself is already decided — organizations, users, memberships, conversations,
messages. The load-bearing rule is that **every tenant-owned row carries `org_id`
directly**, even where a join could reach it. Conversations and messages both get one.
That denormalization is the whole point: later drills scope every query by tenant, and
they must not need three joins to know who owns a message.

## Decisions

- **Hand-written DDL inside `pgm.sql()`, not node-pg-migrate's `createTable()` builder.**
  The builder generates SQL we'd then have to squint at. Later drills read a migration and
  reason about which lock the statement takes and for how long — that only works if the
  statement is the thing in the file. The runner is used for ordering, the `pgmigrations`
  ledger, the advisory lock and transaction wrapping, not for generating SQL.

- **`bigserial` PKs everywhere except `conversations`, which is `uuid DEFAULT uuidv7()`.**
  Postgres 18.4 has `uuidv7()` natively — verified in the running container, no extension
  needed. It's 16 bytes against 8, and every `messages.conversation_id` pays that too, so
  it roughly triples the largest index in the schema. Chosen deliberately as something to
  measure rather than read about; the cost is the point, and undoing it later is its own
  drill.

- **`UNIQUE (user_id, org_id)` on memberships, plus a plain index on `org_id`.**
  The unique constraint's own btree serves `user_id` lookups as a leftmost prefix, so
  uniqueness costs no extra index. Two indexes, not three.

- **All FKs `NO ACTION`** (the Postgres default). Deleting an org that still has
  conversations fails loudly. Tenant deletion becomes an explicit ordered job later, which
  is the honest version — and nothing vanishes by surprise mid-measurement.

- **`messages.org_id` carries a real FK to `organizations` but no index.** This is the
  deliberate gap. Its first cost is not the one you'd guess: an unindexed *referencing*
  column means deleting an organization sequential-scans messages to enforce the FK.
  Per-org aggregates are the second.

- **`conversations` is under-indexed on purpose.** `org_id` and `assignee_id` each get a
  plain index, but the composite an inbox query actually wants —
  `(org_id, status, updated_at DESC)` — is deliberately absent. So the realistic listing
  query filters on an index and then sorts. Card 09 needs a victim; this is it.

- **Considered and deferred: a composite FK `(conversation_id, org_id)` →
  `conversations (id, org_id)`.** It would make `messages.org_id` structurally incapable of
  disagreeing with its conversation's owner — leak-proofing enforced by the database rather
  than by discipline. It needs a `UNIQUE (id, org_id)` on conversations, i.e. another
  16-byte-keyed index on a 2.5M-row table. Left out now so card 07 can decide whether
  correctness is worth that index once the leak is real.

- **Connection config via `migrate.config.mjs`, not a new `DATABASE_URL`.** The CLI accepts
  either. `.env` already carries `POSTGRES_*` and is the single source of truth; adding a
  second spelling of the same credentials is a thing that drifts. The config file reads the
  same variables `PostgresService` does.

- **Migrations run inside the container, never from the host.** Same reasoning as
  `techContext.md` gives for the backend itself: nothing loads `.env` into a host process,
  so a host run would silently fall back to the code's default credentials.

- **`assignee` is named `assignee_id`.** Every other FK in the schema is `<thing>_id`.

## Changes

### 1. `apps/backend/migrate.config.mjs`

Exports the `pg` client config built from `POSTGRES_*` with the same fallbacks
`PostgresService` uses. Wired in via `"migrate": "node-pg-migrate --config-file
migrate.config.mjs"`. `.mjs` because `apps/backend` is a CommonJS package; the runner loads
it through jiti either way, but the extension keeps tooling honest.

### 2. Migration 001 — the five tables

Renamed from the generated `01-migration.js` to `…_core-schema.js`. Nothing has been
applied yet, so the rename is free.

`up` is one `pgm.sql()` per table plus its indexes, in FK order: organizations, users,
memberships, conversations, messages. Every table gets `created_at`/`updated_at
timestamptz NOT NULL DEFAULT now()`. No `updated_at` trigger — the application sets it, and
a trigger firing invisibly on every write is not something to introduce right before a
series of drills that measure writes.

Three named `CHECK` constraints: `organizations.plan IN ('free','basic','pro')`,
`memberships.role IN ('admin','editor')`, `conversations.status IN ('open','closed')`.
Named explicitly rather than left to Postgres, because the STRETCH turns on what comes back
through `pg` when one is violated.

**`conversations.subject text NOT NULL` is created here and dropped in 002.** The final
schema has no such column — it exists so the rollback exercise has something lossy to roll
back. See below.

`down` drops the five tables in reverse FK order.

### 3. Migration 002 — drop `conversations.subject`

`ALTER TABLE conversations DROP COLUMN subject;`

The `down` is where the lesson is. It cannot restore the column as it was: re-adding a
`NOT NULL` column to a populated table requires inventing a `DEFAULT ''` that the original
never had, and then dropping the default to match. The schema comes back; the data does
not. That asymmetry is the WRITEUP question, and it's better observed than asserted.

### 4. `apps/backend/db/seed.sql`

~23 rows for development: 2 orgs, 4 users, 6 memberships, 4 conversations, 7 messages.
Plain SQL, chained with CTEs and `RETURNING` so no ID is hard-coded and `uuidv7()` supplies
the conversation PKs. Opens with `TRUNCATE … RESTART IDENTITY CASCADE` so it is
re-runnable. Not a migration — seeds must not run in CI or production, and the
`pgmigrations` ledger is not the place for fixtures.

### 5. `apps/backend/test/schema.e2e-spec.ts`

Boots `PostgresModule` alone (not `AppModule`) and drives `PostgresService.query()`, which
keeps the drill-01 rule that every read goes through the one chokepoint. It inserts an org,
a user, a membership, a conversation and a message, reads all five back, asserts the
`uuidv7()` default produced a v7 UUID, and deletes them in FK order in `afterAll`.

Also covers the STRETCH: an insert with `plan = 'enterprise'` is expected to reject, and
the test asserts on the actual `error.code` (`23514`) and `error.constraint`
(`organizations_plan_check`) that `pg` surfaces — which is what an API layer would need to
turn it into something a caller can act on.

Runs inside the container, where `env_file` has already supplied the credentials.

### 6. Scripts

Root `package.json`:

- `db:migrate` → `docker compose exec nest_server pnpm --filter=backend run migrate up`
- `db:migrate:down` → same, `migrate down 1`
- `db:seed` → `docker compose exec -T postgres_db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < apps/backend/db/seed.sql`
- `db:test` → `docker compose exec nest_server pnpm --filter=backend run test:e2e`

The seed command quotes the variables single so the *container's* shell expands them from
`env_file` — the host has no `POSTGRES_USER`.

**`node-pg-migrate` was added to `package.json` after the current image was built**, so the
drill-01 anonymous-volume trap applies verbatim: `docker:rebuild` (with
`--renew-anon-volumes`) before any of these work, or the binary won't resolve.

## Non-goals

- No repositories, no query layer, no endpoints reading these tables. Tables and a test.
- No `updated_at` trigger, no soft deletes, no tags table (later drills).
- No transaction helper on `PostgresService`. The test cleans up with ordered deletes
  instead. Multi-statement atomicity is the concurrency drill's problem, not this one's.
- No auto-migrate on backend boot. Migrations are run deliberately.

## Verification

1. `pnpm docker:rebuild` — gets `node-pg-migrate` into the container.
2. `pnpm db:migrate` from the current empty database; `\d` shows five tables, the indexes
   listed above and nothing else.
3. `pnpm db:seed`, then row counts.
4. `pnpm db:migrate:down` → `subject` is back, `NOT NULL`, every row empty string; the
   seeded subjects are gone. `pnpm db:migrate` re-applies with no hand-editing.
5. `docker compose down -v` → `up` → `db:migrate` against a genuinely fresh volume. This is
   the CI-like condition: empty to full schema in one command.
6. `pnpm db:test`.
