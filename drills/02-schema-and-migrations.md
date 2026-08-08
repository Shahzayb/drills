# 02 — Schema and migrations

The tech behind drill 02. `plans/2026-08-07_drill-02-schema-and-migrations.md` records
*what* was decided; this explains the *why* and the *how*, and is meant to be re-readable
without the code open.

---

## 1. Why a migration runner exists

**What.** A migration is one file holding one change to the database's structure, plus how
to undo it. A runner applies them in order and remembers which ones it applied.

**Why not just run SQL by hand.** Because you have more than one database — your machine,
a colleague's, CI's throwaway container, staging, production. Hand-run SQL means those four
drift, and nothing tells you they have. The runner turns "what shape is this database in?"
into a query instead of an archaeology problem.

**Why not an ORM that syncs the schema for you.** Auto-sync decides *for* you what
statement to run, and the statement is the thing that takes a lock on a live table. When a
deploy freezes for four minutes, you need to know it was an `ALTER TABLE` doing a full
rewrite. That's the whole reason this repo writes the SQL by hand.

**Where.** `apps/backend/migrations/`, one file per change, filename-ordered by timestamp.

---

## 2. How node-pg-migrate works here

It does exactly four things:

| | |
|---|---|
| **Order** | Files sort by their numeric timestamp prefix. Never rename an applied file — the ledger stores the name. |
| **Ledger** | A `pgmigrations` table (`id`, `name`, `run_on`). Applied = there's a row. That's the entire state. |
| **Advisory lock** | Two deploys migrating at once: the second blocks. Otherwise both try to create the same table. |
| **Transaction** | Each migration is wrapped in `BEGIN`/`COMMIT`. Postgres does transactional DDL, so a migration that fails halfway leaves *nothing* behind. Most databases can't do this. Appreciate it. |

Note what it doesn't do: it never inspects your schema and never generates SQL. Your `up`
is your SQL.

**Config.** `apps/backend/migrate.config.mjs` returns a `pg` connection object built from
`POSTGRES_*`. Deliberately not a `DATABASE_URL` — `.env` already holds those variables, and
a second spelling of the same credentials is a thing that drifts apart.

**Commands** (all from the repo root; all `docker compose exec` into a container):

```bash
pnpm db:migrate          # apply everything pending
pnpm db:migrate:status   # what's applied, and when
pnpm db:migrate:down     # undo the most recent one
pnpm db:seed             # reset dev fixtures
pnpm db:psql             # a shell in the database
```

New migration:

```bash
docker compose exec nest_server pnpm --filter=backend run migrate create add-tags-table
```

**Why everything runs in the container.** Nothing loads `.env` into a host shell. Run the
migration on your Mac and `POSTGRES_DB` is undefined, the config falls through to its
`'postgres'` fallback, and you migrate the wrong database while it prints success.

**The trap that costs an hour.** The container's `node_modules` is an anonymous Docker
volume, created once when the image was first built and *carried over* on rebuild. Add a
dependency and `docker compose up --build` will not put it there. You need
`pnpm docker:rebuild`, which passes `--renew-anon-volumes`. Symptom: `Cannot find module`
from an image that visibly contains the module.

---

## 3. Writing the `up`

Raw SQL inside `pgm.sql()`, not the `pgm.createTable()` builder:

```js
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE organizations (
      id         bigserial    PRIMARY KEY,
      name       varchar(255) NOT NULL,
      plan       text         NOT NULL
                 CONSTRAINT organizations_plan_check
                 CHECK (plan IN ('free', 'basic', 'pro')),
      created_at timestamptz  NOT NULL DEFAULT now(),
      updated_at timestamptz  NOT NULL DEFAULT now()
    );
  `);
};
```

**When to prefer the builder instead:** when the migration is mechanical and you have a
hundred of them. **When to write SQL:** whenever the statement's cost matters — which is
every `ALTER` on a table with rows in it.

Two column-type habits worth carrying:

- **`timestamptz`, never `timestamp`.** `timestamp` throws the timezone away and keeps the
  wall-clock digits, so the same value means different instants depending on who reads it.
  `timestamptz` stores an instant. There is essentially no case for the other one.
- **`text` over `varchar(n)`** unless the limit is a real business rule. They're the same
  speed in Postgres; the difference is that shrinking a `varchar(n)` later needs a
  migration and a table scan.

---

## 4. The `down` is not an undo

This is the part worth actually internalising.

A `down` is just another forward migration — one that tries to restore a shape. It has no
special powers, and it cannot conjure deleted data.

Migration 002 drops a column. Here's its `down`:

```sql
ALTER TABLE conversations ADD COLUMN subject text NOT NULL DEFAULT '';
ALTER TABLE conversations ALTER COLUMN subject DROP DEFAULT;
```

Two statements, because the honest one-statement version is refused:

```
ERROR:  column "subject" of relation "conversations" contains null values
```

Adding a `NOT NULL` column to a populated table requires a value for existing rows. The
original column had no default, so the `down` has to invent one, apply it everywhere, then
drop it again so the *definition* matches. Run the round trip on real data and every row
comes back as `''`.

It also comes back in the **wrong position** — last in the table, not where it was declared.
Postgres has no way to reinsert a column at an ordinal. Nothing errors; `SELECT *` just
returns a different shape than it used to. (Reason enough to never write positional
`INSERT`s.)

**So what do you actually do?** Expand/contract, in three deploys:

1. **Expand** — add the new thing, write to both old and new.
2. **Migrate** — backfill, switch reads to the new thing, ship, let it bake.
3. **Contract** — stop writing the old thing, *then* drop it, a release later.

The window between 2 and 3 is your rollback. The `down` block is for keeping the ledger
consistent, not for saving you.

**Rule of thumb:** if the `up` destroys information, write the `down` anyway, and know it
restores structure only. The real reversal plan is a backup or a copied-aside table.

---

## 5. Locks: the part that bites in production

Every DDL statement takes a lock. `ACCESS EXCLUSIVE` — the strongest — blocks *everything*,
including `SELECT`. What matters is how long it's held.

| Statement | Cost |
|---|---|
| `ADD COLUMN` (nullable, or constant `DEFAULT`) | metadata only — microseconds, Postgres 11+ |
| `ADD COLUMN ... DEFAULT <volatile>` | **rewrites every row**, lock held throughout |
| `DROP COLUMN` | metadata only; bytes stay in the tuples until a rewrite, so the table doesn't shrink |
| `CREATE INDEX` | blocks writes for the whole build |
| `CREATE INDEX CONCURRENTLY` | doesn't block writes, but can't run in a transaction |
| `ALTER COLUMN TYPE` | usually a full rewrite |

Two traps that don't look like traps:

- **A fast statement can still cause a long outage.** `ACCESS EXCLUSIVE` has to *wait* for
  whatever holds a conflicting lock. A long-running `SELECT` makes your microsecond `ALTER`
  queue behind it — and every query arriving after now queues behind the `ALTER`. Set
  `lock_timeout` before DDL on a live table, and retry, rather than joining that queue.
- **`CREATE INDEX CONCURRENTLY` can't be in a transaction**, so it needs
  `pgm.noTransaction()`. It can also fail and leave an invalid index behind, which you have
  to drop by hand. Worth it on a big live table; pointless on an empty one.

Nothing in this drill has enough rows or concurrency to observe any of this. Card 09 will.

---

## 6. Primary keys: what each one costs

| | Size | Insert pattern | Leaks? |
|---|---|---|---|
| `bigserial` | 8 B | strictly sequential — always appends to the index's right edge | yes: row count and growth rate |
| `uuid` v4 | 16 B | fully random — writes land all over the index | no |
| `uuid` v7 | 16 B | timestamp-prefixed, so near-sequential | leaks creation time |

**Why random hurts.** A btree is pages. Sequential keys keep touching the same rightmost
page — it stays in memory, and it's one write. Random keys touch a different page every
insert, so the working set becomes the whole index, and pages split and fragment. On a big
table that's the difference between an index that fits in cache and one that doesn't.

**Why v7 fixes most of it.** The first 48 bits are a millisecond timestamp, so ids
generated near each other in time sort near each other. You keep the "generate it anywhere,
no round trip to the database" property without the write amplification.

**What v7 still costs you:** 8 extra bytes in the table, *and* 8 extra bytes in every index
and every foreign key that points at it. In this schema `conversations.id` is a uuid, so
all 10M `messages.conversation_id` values pay it too — that one index is roughly 3× the
size it would be with a `bigint`.

Postgres 18 has `uuidv7()` built in. No extension:

```sql
id uuid PRIMARY KEY DEFAULT uuidv7()
```

**One sharp edge, observed here:** four rows inserted in a single statement all share the
same millisecond, so their ids differ only in the random tail. "Sequential" holds *between*
batches, not inside one. Never use a v7 id as a chronological cursor.

**When to pick which.** `bigserial` by default. uuid when ids are public, or generated by
clients, or merged across databases — and then v7, not v4.

---

## 7. Indexes: what you get and what you pay

An index buys read speed with write cost and disk. Every index has to be updated on every
`INSERT`, `UPDATE` of its columns, and `DELETE`.

**Leftmost prefix.** An index on `(a, b)` also serves lookups on `a` alone. It does *not*
serve `b` alone. So order the columns by how you query them, and check whether an index you
were about to add is already the prefix of one you have. In this schema
`UNIQUE (user_id, org_id)` gives uniqueness *and* "which orgs is this user in?" — the
separate `user_id` index would have been redundant.

**Filter vs. sort.** This is the one that surprises people. The inbox query:

```sql
SELECT id, status, updated_at FROM conversations
 WHERE org_id = $1 AND status = 'open'
 ORDER BY updated_at DESC LIMIT 50;
```

with only `conversations_org_id_idx` gives:

```
Limit
  ->  Sort                              <-- here
        Sort Key: updated_at DESC
        ->  Bitmap Heap Scan on conversations
              Recheck Cond: (org_id = 1)
              Filter: (status = 'open')
```

The index finds the tenant, then Postgres reads **every** matching row and sorts it before
throwing away all but 50. A `LIMIT` does not save you — the sort has to see everything
first. An index on `(org_id, status, updated_at DESC)` would let it walk the index in order
and stop after 50 rows. That's the difference between a query that scales with the page
size and one that scales with the tenant.

**How to read a plan, minimally:** read it inside-out, bottom-up. `Seq Scan` = whole table.
`Index Scan` = walking the index. `Bitmap Heap Scan` = index found many rows, fetch them in
disk order. `Filter:` = rows the index couldn't exclude, checked one by one. `Sort` above a
scan = no index provided the ordering. Use `EXPLAIN (ANALYZE, BUFFERS)` when you want real
timings and page counts rather than estimates.

**The cost nobody mentions:** an *unindexed* foreign key column. `messages.org_id` has an FK
to `organizations` and no index, so deleting an organization has to sequential-scan all of
`messages` to prove nothing references it. The missing index shows up as a slow `DELETE` on
a completely different table.

**When to leave an index out.** When you haven't seen the query yet. Indexes are cheap to
add later and each one taxes every write forever. In this drill two are missing on purpose
so card 09 has something to fix.

---

## 8. Constraints, and the errors they produce

```sql
plan text NOT NULL
     CONSTRAINT organizations_plan_check
     CHECK (plan IN ('free', 'basic', 'pro'))
```

**Why `text` + `CHECK` rather than an enum type.** Changing the allowed set is a one-line
constraint swap; changing an enum is its own DDL dance, and you can't remove a value at all.

**Name your constraints.** Postgres generates a name if you don't, but the generated one
changes if the column is ever recreated. The name is what your API layer branches on.

**Why this matters for the API.** A violation reaches Node as a `pg` error with structured
fields, not just a string:

```js
catch (error) {
  error.code        // '23514'  — check_violation
  error.constraint  // 'organizations_plan_check'
}
```

Error classes worth memorising:

| Code | Meaning | Usually means |
|---|---|---|
| `23505` | unique violation | 409 Conflict |
| `23503` | foreign key violation | 422, or a bug |
| `23514` | check violation | 400 Bad Request |
| `23502` | not-null violation | 400 |
| `40001` | serialization failure | retry it |
| `40P01` | deadlock detected | retry it |

The whole `23xxx` class is *your* bug or the caller's — never retry it, since a retry fails
identically. `PostgresService` already encodes that. `40001`/`40P01` are the opposite: they
mean "try again" and nothing else.

The error *message* names the table and the constraint but never the offending value —
it's for your logs, not for the caller.

---

## 9. Multi-tenancy: `org_id` on every row

The rule this schema is built on: **every tenant-owned row carries `org_id` directly**, even
when a join could reach it. `messages` has one, despite `messages → conversations → org_id`
being available.

**Why.** Every query in a multi-tenant app is scoped by tenant. If the tenant is two joins
away, then *every* query carries those joins, every index has to support them, and — worse
— the leak-proofing you add later has to reason across three tables to answer "who owns
this?". One denormalized column makes tenant scoping a `WHERE` clause.

**What it costs.** 8 bytes per row, and the copy can now disagree with the truth. Nothing
in this schema stops a bug writing the wrong `org_id` onto a message.

**How you'd close that**, when it's worth an index:

```sql
UNIQUE (id, org_id)                              -- on conversations
FOREIGN KEY (conversation_id, org_id)
  REFERENCES conversations (id, org_id)          -- on messages
```

Now a message can only point at a conversation *in the same org* — the database enforces it
rather than your discipline. The price is another index on a 2.5M-row table with a 16-byte
key. Deferred to card 07 deliberately: decide it when the leak is real.

---

## 10. Seeds are not migrations

`apps/backend/db/seed.sql` is plain SQL, run through `psql`, and is **not** in the
migrations directory.

**Why the separation.** Migrations run everywhere, including production. Fixtures must run
nowhere except your machine. Putting seed data in the `pgmigrations` ledger makes "has this
database been set up?" and "does this database have fake customers in it?" the same
question.

**Two things the seed teaches:**

- It starts with `TRUNCATE ... RESTART IDENTITY CASCADE` so it's re-runnable. `RESTART
  IDENTITY` resets the `bigserial` sequences, so ids are stable across runs.
- It's **sequential `INSERT`s in one transaction**, not a chain of CTEs. Later statements in
  a transaction see what earlier ones wrote, so each insert can look its parents up by name.
  Data-modifying CTEs all share **one snapshot** — a CTE cannot read rows a sibling CTE just
  inserted. That's a real Postgres rule, and the first draft of this seed got it wrong.

**Seed fixtures for the leak you'll test later.** Two of the four users belong to *both*
orgs. A tenant-isolation bug that only manifests for a shared identity is exactly the one a
single-org fixture hides.

---

## The five-line summary

1. Migrations are ordered files plus a ledger table; the runner adds nothing else.
2. A `down` restores shape, never data — expand/contract is the real rollback.
3. Every DDL statement takes a lock; know whether it rewrites the table, and use
   `lock_timeout` on live ones.
4. `bigserial` unless ids are public; uuid **v7**, never v4.
5. Index for the `ORDER BY`, not just the `WHERE` — and put `org_id` on every tenant row.
