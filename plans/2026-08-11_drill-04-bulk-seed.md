# Drill 04 — A skewed 2.5M-conversation seed that loads in under six minutes

**Status:** shipped

## Context

Every performance claim this repo has made so far is a guess written against 64 rows.
`plans/2026-08-09_drill-03-conversation-list.md` closes with four numbered predictions about
what breaks at 2.5M rows, and there is currently no way to check any of them. Drill 04 builds
the data that makes those predictions falsifiable — and cards 08, 09 and 10 unusable until it
exists.

The dataset has to be *skewed*, not just large. Uniform data flatters date-range indexes,
flatters partial indexes, and makes tenant-scoped queries look identical for every tenant.
A seed where one org holds 40% of the rows and recent months hold most of the timestamps is
the difference between measuring the system and measuring the fixture.

Secondary goal, and the actual new tech: **`COPY` instead of an insert loop**, and knowing
which of the load's costs are the tuples, which are the indexes, and which are the WAL.

### Targets

| Table | Target | Notes |
|---|---|---|
| `organizations` | 200 | |
| `users` | ~1,200 | |
| `memberships` | ~1,800 | No target of its own — falls out of users × orgs they belong to |
| `conversations` | 2,500,000 | 40 / 40 / 20 across 1 whale, 9 mid, 190 small orgs |
| `messages` | 10,000,000 | ~180 char bodies |
| On disk, incl. indexes | 4–5GB budget | Predicted ~3.6GB; see Writeup |
| Seed wall-clock | under 6 min | From empty |

### Scope notes

- **`usage_events` is deferred to drill 13.** No migration in this drill, no table, no 2M
  rows. Two decisions worth carrying forward rather than re-deriving: it should be
  **org-grained** (a metering table's natural grain, and `org_id` direct is this schema's
  load-bearing rule), and it should ship with **no index on `occurred_at`** — 2M append-mostly
  rows ordered by time is the textbook BRIN case, and handing it a btree now removes the
  moment where that lands.
- **`apps/backend/db/seed.sql` is retired**, not kept alongside. Consequence tracked under
  Decisions: drill 03's four named conversations disappear, and its deliberate `updated_at`
  ties have to be reproduced by other means.
- **Data content comes from `@faker-js/faker`**, seeded, and has to *read* like a real support
  inbox — not lorem ipsum with the right row count. See the realism decision below.

### Result

**104.3s to seed, 1:49.2 for `db:reset` from empty**, against a six-minute budget. 3.2GB of
relations against a 4–5GB budget. Skew exact, data deterministic, all 20 e2e tests still
passing. Full numbers in the Writeup.

*(Revised the same day — see "Micro-optimisation, measured and reverted". Post-revision runs
are 108.2s and 109.7s, inside the noise band. `messages` fingerprints changed; nothing else
did.)*

---

## What gets built

| File | Role |
|---|---|
| `apps/backend/db/seed.mjs` | **new** — the seeder. Plain Node ESM, deterministic, `--scale` |
| `apps/backend/db/lib/corpus.mjs` | **new** — support-ticket templates + faker slot pools, shared by the seeder and the bench so the benchmark measures shipping code |
| `apps/backend/db/bench-copy.mjs` | done — + the body-generation bench (Build order step 1) |
| `apps/backend/db/seed.sql` | **deleted** |
| `apps/backend/package.json` | + `pg-copy-streams` (done), + `@faker-js/faker` |
| `docker-compose.yml` | done — `command:` override on `postgres_db` |
| `package.json` (root) | `db:seed` repointed, + `db:seed:ci`, + `db:reset` |
| `plans/2026-08-11_drill-04-bulk-seed.md` | overwritten with this revision, + the `## Writeup` |
| `drills/04-copy-and-bulk-load.md` | the teaching guide (gitignored, local only) |

No migration. No application code. `PostgresService` is untouched — see Decisions.

---

## Decisions

### Realistic data, which rules out the obvious fast answer

Three requirements collide here: generate the data with a library, make it *realistic*, and
seed in under six minutes.

**Realism kills `faker.lorem` outright.** This is a customer-feedback product. A `messages`
table full of *"Lorem ipsum dolor sit amet consectetur"* has the right row count, the right
byte width and no other property of the real thing — you cannot read a page of it and tell
whether the app renders a support inbox sensibly, and any future full-text-search drill
against Latin filler is measuring nothing.

**Speed kills per-row faker.** `faker.lorem` runs in the 30–100k strings/sec range; 10M direct
calls is 100–330 seconds of pure JavaScript against a 360-second budget that also owes COPY
and three index builds.

So the design is **templates plus faker-generated slot pools**, which satisfies both:

- At startup, `faker.seed(SEED)` then generate pools — a few thousand each of product/feature
  names, person names, cities, error codes, amounts, order references.
- ~120 hand-written sentence templates in real support-ticket voice, with slots:
  `"We were charged twice for {plan} on the {ordinal} — same amount, two line items."`,
  `"{feature} export stops at {number} rows with no warning."`,
  `"Confirmed a duplicate authorisation on our side. Refunding to {name} today."`
- Each row composes 2–3 templates and fills their slots from the pools.

Combinatorially that is hundreds of millions of distinct bodies, so they are effectively
unique across 10M rows rather than a few thousand repeats — and faker still authors every
proper noun in the corpus. It is out of the hot loop, not out of the seeder.

**Conversations read as conversations, not as N independent strings.** Message 0 states a
problem, message 1 acknowledges it, later messages resolve or follow up, and the last one
closes if the conversation is closed. The schema has **no author column** on `messages`, so
the customer/agent alternation lives in the prose only — worth saying out loud, because it is
the kind of thing that looks like an omission later.

Where volume is low, faker is called per row because there it is free: **200 organizations get
`faker.company.name()`, ~1,200 users get `faker.person.fullName()`.** `conversations` needs no
faker at all — migration 002 dropped `subject`, so it has no text column. All 10M of the text
problem is in one column of one table.

**Build order step 1 still measures it**, because "templates are faster" is a prediction until
it is a number, and the writeup asks what the bottleneck was. The rule is fixed in advance so
it cannot be rationalised afterwards:

> Generation gets ~120s of the 360s budget, so 10M bodies needs **83k/sec**. Require 2×
> margin: **≥150k/sec ships. Below that, the composition step gets simpler until it clears.**

`faker.seed()` makes faker's own generator deterministic, so it folds into the fixed-seed
requirement rather than fighting it — on the same condition as everything else here: the call
sequence has to be identical between runs.

`@faker-js/faker` is a second new dependency, so it needs the same `pnpm docker:rebuild` that
`pg-copy-streams` needed.

### The seeder bypasses `PostgresService`, and that is not a violation

`PostgresService`'s rule is *"every **read** goes through `query()`"* — a hook point for
timing, tracing and pool metrics. The seeder is a one-off writer that needs a raw `Client`
and a duplex stream, which the service deliberately does not hand out. Widening it to expose
the `Pool` would damage the one thing it exists to protect, for a script that runs outside
the application process entirely.

The seeder opens its own single `pg.Client`. Not a pool: the whole load is one transaction on
one connection, and that is load-bearing (below).

### One transaction, `wal_level=minimal`, and why that is the biggest single lever

Postgres skips WAL entirely for a table that was **created or truncated in the same
transaction** as the load — but only when `wal_level = minimal`. At the end, it fsyncs the
relation files instead of having journalled ~3.5GB of tuples.

So the shape is forced:

```
BEGIN;
  SET LOCAL maintenance_work_mem = '512MB';
  TRUNCATE messages, conversations, memberships, users, organizations RESTART IDENTITY;
  DROP INDEX conversations_org_id_idx, conversations_assignee_id_idx,
             messages_conversation_id_idx;
  COPY organizations ... FROM STDIN;   -- parents first, FK order
  COPY users ...        FROM STDIN;
  COPY memberships ...  FROM STDIN;
  COPY conversations ... FROM STDIN;
  COPY messages ...      FROM STDIN;
  CREATE INDEX ... x3;                 -- also WAL-skipped, same transaction
  SELECT setval(...);                  -- RESTART IDENTITY zeroed them; ids were explicit
COMMIT;
ANALYZE;                               -- outside the transaction
```

The cost of this choice: **`wal_level=minimal` forecloses streaming replication and PITR**,
so whichever card wants a read replica has to flip it back to `replica` and restart. Written
down here so that failure is a two-minute diagnosis rather than an afternoon.

Second cost: no parallel `COPY` streams. Separate connections cannot share the truncating
transaction, so WAL-skip and parallelism are mutually exclusive. Taking WAL-skip on the
assumption it wins; if the measured time misses 6 minutes, that assumption is the first thing
to re-test, not the last.

Third: a failure at row 9,000,000 rolls the whole thing back. For a seed that is the correct
behaviour — there is no such thing as a usefully half-seeded database.

### Explicit ids in the COPY, sequences fixed up afterwards

Every `bigserial` id is generated by the script and shipped in the `COPY`, rather than letting
the sequence default fire. Two reasons: determinism (identical bytes across runs, not merely
identical row *counts*), and it lets `messages.id` be strictly ascending, which turns 10M
primary-key btree inserts into right-most page appends instead of scattered ones.

`TRUNCATE ... RESTART IDENTITY` resets the sequences to 1, so the last statement before
`COMMIT` is a `setval()` per `bigserial` table. Forgetting this is the classic version of this
bug: the seed looks perfect and the first `INSERT` the app makes dies on a duplicate key.

### `conversations.id` is a client-side uuidv7 derived from the row's own `created_at`

The column default is `uuidv7()`, which embeds *insert* time — non-deterministic by
construction, and the existing `seed.sql` has a comment pointing out that this makes id order
and `created_at` order disagree.

The seeder builds the uuid itself: 48 bits of the row's synthetic `created_at`, then version
and variant bits, then random bits from the seeded RNG. Then it **emits conversations in
ascending `created_at` order**. Two consequences, both wanted:

1. The uuid PK is append-only during the load, like `messages.id`. Random uuid insertion into
   a btree causes page splits and is meaningfully slower.
2. Id order and creation order now *agree*, unlike drill 03's fixture. This is the honest
   shape for an 18-month-old app, and it makes the PK a usable chronological cursor — which
   card 08's keyset pagination will want.

### Skew is assigned exactly, not sampled

Drawing each conversation's org from a weighted random draw gives 40% *in expectation*, with
binomial noise of ±1,000 rows. The DONE WHEN asks for a `GROUP BY org` that proves the
distribution, and exact numbers prove it better than approximate ones.

So: fill an `Int32Array(2_500_000)` with exactly 1,000,000 / 1,000,000 / 500,000 org ids, then
Fisher–Yates shuffle it with the seeded RNG. O(n), exact, deterministic.

| Tier | Orgs | Conversations | Per org |
|---|---|---|---|
| Whale | org 1 | 1,000,000 (40%) | 1,000,000 |
| Mid | orgs 2–10 | 1,000,000 (40%) | ~111,111 |
| Tail | orgs 11–200 | 500,000 (20%) | ~2,632 |

`assignee_id` must reference a membership **in the same org**, so memberships are laid out in
contiguous id blocks per org and the pick is a range index. Roughly one conversation in five
is left `NULL` — an always-populated nullable column hides exactly the bugs it exists to
expose.

Simplification worth naming: org assignment is independent of time, so every org has rows
spread across the whole 18 months. A real tenant's history starts when it signs up. Uniform
signup would give the tail orgs too few recent rows to page through, which is the thing
drill 03's endpoint needs from them.

### Timestamps: `age = 18 months × u^2.5`

`u` uniform in [0,1). The exponent pushes mass toward zero, i.e. toward now. Median age lands
around 3.2 months rather than the 9 months a uniform spread would give, and roughly 8% of all
rows fall in the last 24 hours.

That last number is why this matters: a date-range index over uniform data reports a
selectivity that production will never reproduce, and "last 7 days" is the range every real
dashboard asks for. The writeup records the actual decile table as proof it isn't uniform.

### Status skew is correlated with age, not just weighted

Not 78% closed sprayed at random — `P(closed) = 0.55 + 0.40 × ageFraction`. Old conversations
are almost all closed; recent ones are mostly open. Overall lands near 78/22.

Being explicit about the consequence: this correlation will make a partial index on
`status = 'open'` look *very* good in card 09, better than uniform data would suggest. That is
not the fixture cheating — it is the fixture matching the reason partial indexes work in
production. But the number has to be read knowing the correlation is there.

### `updated_at` is the last message's timestamp, not an independent draw

An inbox sorted by `updated_at DESC` — which is exactly what drill 03's endpoint does — means
"most recently active first". If `updated_at` is drawn independently of the messages, that
sort is sorting by a number with no referent, and every later drill that reasons about it is
reasoning about noise.

So the planning pass computes each conversation's active span first, spreads its messages
across it, and sets `updated_at` to **exactly the last message's `created_at`**. No extra
storage: messages are distributed between `created_at` and `updated_at` with the final one
landing on the endpoint, so the messages pass recomputes the same values without a replay.

Consequence worth having: `updated_at ≥ created_at` always, closed old conversations sit far
down the inbox, and a conversation with one message has `updated_at = created_at`.

### `updated_at` is truncated to the second, to keep drill 03's tie honest

Retiring `seed.sql` deletes the deliberate `updated_at` ties that drill 03's
`ORDER BY updated_at DESC, id DESC` tiebreaker was justified against, and losing the
adversarial property would quietly weaken a shipped decision.

Second-granularity restores it by density rather than by hand: org 1 has ~80,000
conversations in the last 24 hours, which is ~86,400 seconds — birthday-paradox arithmetic
puts expected collisions in the tens of thousands. Page 1 of the inbox is exactly where the
ties are, which is exactly where they matter.

### Indexes dropped, foreign keys kept — but the expensive one gets measured

Dropped for the load, rebuilt inside the transaction: `conversations_org_id_idx`,
`conversations_assignee_id_idx`, `messages_conversation_id_idx`. Both primary keys **stay** —
`conversations_pkey` is referenced by a foreign key and cannot be dropped without dropping
that too, and both PKs receive strictly ascending values, so they cost little.

Foreign keys stay by default. Three of them are cheap: `conversations.assignee_id` and
`messages.org_id` probe tables of ~1,800 and 200 rows that live permanently in cache. One is
not: **`messages.conversation_id` is 10,000,000 per-row trigger firings against a 2.5M-row
uuid index.** These are immediate, not deferred — the constraints are not `DEFERRABLE`.

That single constraint is a plausible top-two bottleneck, so the seeder drops
`messages_conversation_id_fkey` before the `COPY` and re-adds it with `NOT VALID` +
`VALIDATE CONSTRAINT` after. Run both, record both, keep whichever wins.

**Measured, and it wins decisively: 157.3s → 105.9s**, with the messages `COPY` falling from
124.9s to 73.3s. The 10M per-row checks were ~40% of that phase. So dropping is now the
default and `--keep-fks` opts out — a default earned by measurement rather than taken on
principle. `VALIDATE CONSTRAINT` costs 2.2s and still proves every row, so the database ends
in exactly the same state either way.

### `maintenance_work_mem = '512MB'`, sized from the actual sort

Not a round number picked for feeling large. The biggest index build is
`messages_conversation_id_idx`: 10M entries × ~24 bytes ≈ **240MB** of sort data. Above that
threshold the build spills to a disk-based external merge; below it, it is an in-memory
quicksort. 512MB keeps it in memory with headroom.

Session-level `SET LOCAL`, not a server setting — it is only wanted for the seed. Ceiling
check: 128MB `shared_buffers` + 512MB here, inside a 3g container, with
`max_parallel_maintenance_workers = 2` sharing that same 512MB budget rather than each taking
it. Comfortable.

**Measured, and the two levers turn out to be coupled.** `messages_conversation_id_idx` takes
**16.98s** to build at the 64MB default and **2.25s** at 512MB — 7.5×, because 240MB of sort
data either fits in memory or becomes an external merge sort against disk. That changes the
verdict on dropping indexes entirely: at the default it costs 18.1s to rebuild and saves 14.2s
during the `COPY`, a net **loss**; at 512MB it costs 3.1s and is a net win. Neither lever is
worth much without the other, which is not something either would show on its own.

This split is itself the lesson, and `pg_settings.context` is the map: `shared_buffers` and
`wal_level` are `postmaster` (restart), `max_wal_size` and `checkpoint_timeout` are `sighup`
(reload), `maintenance_work_mem` and `synchronous_commit` are `user` (session `SET`). Knowing
which is which is the difference between tuning a database and restarting one.

### `shared_buffers = 128MB` — already landed, recorded here

Previously `POSTGRES_INITDB_ARGS: "-c shared_buffers=768MB"`, which applied **only at
`initdb`**. On an existing `drills_pgdata` volume, editing that line did nothing at all and
gave no warning. That is a trap, not a configuration mechanism, and it is gone — replaced by
the `command:` override, which applies on every start.

128MB is chosen against the standard 25%-of-RAM rule on purpose. At 768MB the `conversations`
heap (~230MB) *fits*, and every later `EXPLAIN (ANALYZE, BUFFERS)` reports `shared hit` for
the interesting cases — the instrument reads flat. At 128MB, `conversations` is ~1.8× over and
`messages` ~20× over, so cache misses stay visible for the rest of the drill series. Realism
traded for legibility, deliberately.

**Caveat to carry into the writeup:** `shared read` is not the same as *disk*. The container
has 3g and the host has more, so most of those misses are served by the OS page cache. The
card's question — "what does that do to a full scan" — has a more interesting answer than
"it goes to disk", and answering it that way would be wrong.

### Plain `.mjs`, run with `exec` into `nest_server`

No transpiler between the profiler and a hot loop, no build step, and it matches
`migrate.config.mjs` and the `.js` migrations. Run through `nest_server` because that is where
the workspace `node_modules` and the network route to `postgres_db` already are — the same
reason `db:migrate` does it.

### Generator technique, because the bottleneck may well be Node

Serialising ~2.9GB of text is not obviously cheaper than ingesting it, and the 59× COPY result
already says the ingest side has headroom. Four things decided up front:

- **Batched writes.** Accumulate ~10,000 lines, `join('\n')`, one write. Not a write per row.
- **Backpressure is mandatory.** The generator is a `Readable.from(generator)` piped into the
  COPY stream, so pull-based backpressure is structural rather than something to remember.
  Ignoring it buffers gigabytes in the Node heap against a 1g container limit — the most
  likely way a first attempt dies rather than merely runs slowly.
- **Timestamp formatting is cached by day.** `toISOString()` at ~300ns × ~15M calls is ~4.5s
  of pure formatting. A `Map` from day-start to `YYYY-MM-DD` holds at most ~550 entries across
  18 months. (The cache survives — measured at 3.8s. The hand-rolled arithmetic that was built
  around it does not; see "Micro-optimisation, measured and reverted".)
- **No escaping, by construction.** `COPY` text format needs `\`, `\t`, `\n`, `\r` escaped.
  The generated alphabet excludes all four and an assertion enforces it at startup. Real
  loaders must escape; this one is allowed to cheat because it owns its own corpus.

Memory budget: conversation uuids held as one 40MB `Buffer` (16 bytes each, hex-encoded once
per conversation during the messages pass, not once per message) plus typed arrays for org
ids, both timestamps and message counts — ~93MB total, comfortably inside `nest_server`'s 1g.
Holding 2.5M uuid *strings* instead would be ~250MB and is the obvious way to hit the limit.

### Determinism: a fixed seed, and the property that makes it real

One `mulberry32` RNG plus `faker.seed()`, both from a fixed constant, re-seeded per pass.
Determinism here relies on the passes being ordered and single-threaded — which they are,
because the whole load is one connection.

Recorded as a constraint rather than an accident: **if parallel `COPY` streams are ever
added, per-row values must become a pure function of `(seed, rowIndex)`**, or reproducibility
dies silently and the two runs differ in ways no row count will reveal.

### `--scale` scales the two big tables only

`--scale=0.1` gives 250k conversations and 1M messages, but **still 200 orgs and 1,200 users**.
Scaling the org count would change the shape of the skew, and the skew is the thing CI most
needs to keep testing. Card 31 wants this flag; the constant org count is the part that makes
it useful there.

The bucket fractions are chosen so both scales land exactly: 46% × 2 + 25% × 3 + 17% × 5 +
9% × 8 + 2.6% × 20 + 0.4% × 60 = **exactly 4.00 messages per conversation**, so 2.5M
conversations produce exactly 10,000,000 messages and 250k produce exactly 1,000,000, with no
rounding residue to patch up.

---

## Deliberately not done

- **No `usage_events`.** Drill 13's, per your call. Design notes preserved in Scope notes so
  it does not get re-derived.
- **No binary `COPY`.** Text format ships first. Binary would let timestamptz go over as 8 raw
  bytes and remove the formatting cost entirely, but it means hand-encoding every type. It is
  the documented next lever if 6 minutes is missed — not a starting position.
- **No parallel `COPY` streams.** Mutually exclusive with the WAL-skip, above.
- **No `fsync=off`.** Tempting for a seed, and a genuinely dangerous thing to leave in a
  compose file that later drills will run failure experiments against.
- **No index on `messages.org_id`**, still. Drill 02 left it out on purpose and drill 04 is
  not the card that gets to change that.
- **No application or test changes.** Both e2e specs create their own tagged orgs and assert
  nothing about seed contents, so they should pass unchanged — verified below, not assumed.

---

## Build order

1. **Body-generation bench.** Add to `bench-copy.mjs`: bodies/sec for per-row faker against
   bodies/sec for template-plus-pools, same count, same realism bar. **Decision rule, fixed
   now: ≥150k/sec ships.** Record both numbers regardless — the gap is writeup material either
   way, and it is the evidence that the template approach was a measurement and not a
   preference.
2. **First honest attempt.** Full seeder, all indexes and FKs live, no transaction wrapper, no
   session tuning. **This number is what the writeup's "before" means** — take it before
   fixing anything, because it is unrecoverable afterwards.
3. **Apply the levers one at a time**, timing each: drop/rebuild indexes → single transaction
   with the `wal_level=minimal` skip → `maintenance_work_mem` → generator batching. One at a
   time is what turns a total into an attribution. Individual flags (`--no-txn`,
   `--keep-indexes`, `--no-tuning`) exist so each lever can be isolated; `--naive` sets all
   three.
4. **`--drop-fks` run**, compared against step 3. Keep the winner.
5. **`--scale=0.1`, then `db:reset`**, then the measurements below.

---

## Verification

1. `pnpm docker:rebuild` — required, not `docker:up`, because of `@faker-js/faker`. Same
   anonymous-volume trap `pg-copy-streams` already went through.
2. `pnpm db:reset` — drops and recreates `public` (taking the `pgmigrations` ledger with it),
   re-migrates, seeds. This is the "from empty" the 6-minute claim is about. The seeder prints
   per-phase timings and a total; `time` wraps the whole thing as a cross-check.
3. **Row counts** — one `UNION ALL` per table, as `seed.sql` did.
4. **`pg_total_relation_size` per table**, plus the heap/index split, since the split is half
   the answer to which table is biggest and why.
5. **Skew proof** — `SELECT org_id, count(*) FROM conversations GROUP BY 1 ORDER BY 2 DESC`,
   reported as the three tiers with percentages.
6. **Distribution proof** — conversations bucketed by month over the 18 months, and the
   open/closed split overall and within the most recent month. Uniform data must be visibly
   ruled out, not merely denied.
7. **Determinism** — seed twice, and per table compare
   `SELECT count(*), sum(hashtext(t::text)::bigint) FROM t`. Order-independent, single pass,
   no `string_agg` building a multi-gigabyte string. It proves content equality up to hash
   collision; state that limit rather than overclaiming byte-identity.
8. **On-disk total** — `pg_database_size`, plus `du -sh` on the volume so `pg_wal` is counted
   too. The 4–5GB budget is about the volume, not just the relations.
9. **`pnpm db:test`** — both e2e specs, unchanged, now against 2.5M rows. Expected to pass and
   to be slower; if either fails, that is a finding.
10. **Re-measure drill 03.** `GET /conversations?pageSize=50` for org 1 (1M rows), the same
    endpoint for a tail org (~2,600 rows), and `EXPLAIN (ANALYZE, BUFFERS)` on both. Drill 03
    wrote down four ranked predictions; this is the first opportunity to check them, and
    checking them is the most valuable thing this drill produces.

---

## Divergence from the plan

Four things changed against what is written above.

1. **The status formula was wrong twice.** The planned `P(closed) = 0.55 + 0.40 × ageFrac`
   predicted ~78% closed; it actually yields **66%**, because recency weighting makes
   `E[ageFrac] = 1/3.5`, not the ~0.5 the estimate assumed. Worse, a linear ramp closes 55% of
   conversations created *seconds* ago, which no support inbox does. Replaced with
   `P(closed) = 1 − 0.73 × e^(−15 × ageFrac)`: 78.1% overall, 27.7% under a day, 99.9% past six
   months.
2. **The `NOW` anchor was in the future.** Pinned to 12:00 UTC on the drill date while the wall
   clock read 09:53, which put **75,606 conversations after `now()`**. Caught by an integrity
   check that existed only because the verification script asserts on things that should be
   impossible. Re-anchored to midnight UTC — still fixed, so determinism holds, but it can no
   longer forward-date.
3. **`--drop-fks` became the default**, renamed to `--keep-fks` for the opt-out. It won by more
   than everything else combined.
4. **The corpus needed two casing fixes** that only showed up by reading actual rows: a
   `{feature}` slot carrying its own article produced "the the public status page team", and a
   slot landing after a sentence boundary produced "everyone. the API should behave normally".

---

## Micro-optimisation, measured and reverted

*Revision, same day, after a readability pass over `db/`.*

The seeder shipped with four hand-optimised hot paths whose cost had never been measured
against their simple equivalents — they were written on the assumption that Node would be the
bottleneck, which the writeup below then disproved and nobody went back to act on. Measured,
scaled to the real workload:

| Hot path | Simple equivalent | What the clever version bought | Kept? |
|---|---|---|---|
| `compile()` — templates pre-split into parts/slots | `.replace(/\{(\w+)\}/g, …)` per row | **5.5s** (8.7×) | ~~yes~~ **no** |
| `stamp()` day cache | fresh `toISOString()` per row | **3.8s** | ~~yes~~ **no** |
| `HEX` byte→hex table in `uuidHex()` | `Buffer.toString('hex')` + slicing | **0.38s** (7.1×) | ~~yes~~ **no** |
| `stamp()` `TWO`/`THREE` tables + hand divmod | `String(x).padStart(2, '0')` | **0.05s** | **no** |
| `writeUuid()` — 16 byte writes with magic divisors | `writeUIntBE(t, off, 6)` + two `writeUInt32BE` | **0.07s** | **no** |
| `hash2(i, k)` jitter | one sequential `mulberry32` call | **0.03s** | **no** |

> **Superseded 2026-08-12** by [seed-simplification](2026-08-12_seed-simplification.md). The
> top three went too, and **the column this table is missing is the one that mattered**: every
> figure above is *CPU*, never wall clock. Measured after removing all three — 108.21s against
> 108.2s, `copy messages` 78.32s against 78.4s. **9.7s of CPU bought ~0s of wall clock.**
>
> The reason is the one this section already argued for the bottom three, and it applies just
> as well to the top three: the pipeline is pull-based, so the generator only costs wall clock
> if it becomes the *slower* side. The bench puts numbers on it — generation fell from ~2M
> bodies/s to 1,113,828/s while Postgres ingests at 127,680 rows/s, so it stayed 8.7× ahead.
>
> **Reverting the cheap three and keeping the expensive three was the wrong cut.** The right
> question was never "how much CPU does this save" but "is this side of the pipe the bottleneck"
> — and the answer was no for all six.

Two conclusions, and the second is the one worth carrying forward.

**The payoff ranking is inverted from the complexity ranking.** The three techniques worth
keeping are the three plainest — cache a repeated computation, split a string once instead of
per row, index a lookup table. The two most opaque blocks in the repo were worth 0.12s
combined out of a 104s run with a 256s surplus. `hash2`'s comment claimed it avoided "a
closure per row", which the alternative never incurred: one generator called sequentially is
what every other pass in the file already does.

**The generator was never on the critical path, and the pipeline says so structurally.** It is
`Readable.from(gen).pipe(copyStream)` — pull-based. Postgres ingests messages at ~137k rows/s;
the corpus produces bodies at ~2M/s. During the phase that dominates the load, the generator
is suspended at its `yield` roughly 93% of the time, so the true wall-clock saving from all of
this is nearer zero than 9.5s. **This is the same mistake as the headline finding, one level
down** — the writeup records predicting text generation would dominate and being wrong about
it, then the code kept optimising the side of the pipe that was already 15× ahead.

Also simplified in the same pass, for legibility rather than measured cost:

- `body()`'s next-template pick was `(index + 1 + ((rng() * (list.length - 1)) | 0)) % list.length`
  — a random-offset trick that guaranteed difference only from the *immediately preceding*
  template, so a three-sentence body could still repeat its first sentence. Replaced with a
  retry loop against every template already used, which is both obvious and actually correct.
- Casing was fixed in two places at two layers (`render()` uppercased character zero, `body()`
  ran a second regex for sentence boundaries). Both of the casing bugs in Divergence item 4
  got through that split. Now one `capitalise()` pass over the finished body, handling `.`,
  `!` and `?` seams.
- `phase()` inferred a phase's row count from `typeof result === 'number'`. Now an explicit
  third argument. It also pushed to a `phases` array nothing ever read.
- `structureLines()` ran 10,000-row batching over tables of 200, 1,200 and 1,778 rows, none of
  which reach a second batch. Now a plain `map().join()`.

**Consequence: the data changed, but only where it had to.** The message-jitter RNG and the
corpus's draw sequence both moved, so bodies and mid-thread message timestamps differ from the
first release. Everything else is bit-for-bit identical — `organizations`, `users`,
`memberships` and all 2,500,000 `conversations` produce the same fingerprints as before, which
is how the rewritten `writeUuid()` and `stamp()` were confirmed faithful at scale. Fingerprints
in the Writeup are re-recorded; any number quoted from a pre-revision seed of `messages` is
against different bytes.

**Verified after the pass:** exact 40/40/20 skew; zero rows dated after the `NOW` anchor; zero
`updated_at < created_at`; zero messages outside their conversation's span; zero assignees in
the wrong org; `updated_at` equal to the last message's timestamp across all 2,631 sampled
conversations; all four sequences past `max(id)`; `convalidated = t`; 78.1% closed overall and
27.7% inside the last 24h; mean 3.997 messages per conversation. All 20 e2e tests pass.

**Timing is unchanged within noise, which is the prediction the numbers were supposed to
test.** Two post-revision runs: **108.2s** and **109.7s**, against a pre-revision spread of
104.3 / 107.7 / 107.1s. Overlapping, at the top of the band. The reverted paths measured 0.12s
together and the phase that moved (`messages` COPY, 73.3s → 78.4s) is the Postgres-bound one,
so the difference is not attributable to the change — but it is not a clean win either, and
saying "no measurable cost" on two samples that both sit above the old mean would be
overclaiming.

---

## Writeup

### What was the bottleneck, and what was the first attempt's time?

**First attempt: 176.0s. Final: 104.3s** (`pnpm db:reset` from empty, 1:49.2 wall clock
including drop-schema and migrate). Both already inside the six-minute budget, which is itself
the first honest finding — **there was no crisis here, only headroom.** The card is written as
though the naive version fails; on this hardware it does not.

**The ranking going in was wrong.** I predicted text generation in Node would dominate, on the
grounds that COPY ingest had proven headroom. Generation was never in contention: the template
corpus produces 10M bodies in ~3–5s. Measured attribution, one lever at a time:

| Run | Config | Total | messages COPY | index rebuild |
|---|---|---|---|---|
| A | naive | 176.0s | 145.4s | — |
| B | drop/rebuild indexes only | 178.1s | 131.2s | 18.1s |
| C | WAL-skip only | 152.7s | 122.8s | — |
| D | session tuning only | 159.7s | 131.3s | — |
| E | all three | 157.3s | 124.9s | 3.1s |
| **F** | **all three + drop FK** | **105.9s** | **73.3s** | 3.1s |

**The bottleneck was `messages_conversation_id_fkey`** — 10,000,000 immediate per-row trigger
firings against a 2.5M-row uuid index, worth **51.6s**, more than the other three levers
combined. It is not `DEFERRABLE`, so nothing batches. `NOT VALID` + `VALIDATE CONSTRAINT` puts
it back in 2.2s with `convalidated = t`, so the end state is identical.

Second: **WAL.** Measured directly with `pg_current_wal_lsn()` before and after — the naive
load journals **4960MB**, the single-transaction load **450MB**. An 11× reduction for identical
data, and the 450MB that remains is catalog churn, `ANALYZE` and the FK revalidation rather
than table content.

Third, and the most interesting: **dropping indexes is worth nothing on its own.** A vs B is a
net *loss* — 14.2s saved during the COPY against 18.1s spent rebuilding. The reason is
`maintenance_work_mem`: `messages_conversation_id_idx` takes **16.98s** to build at the 64MB
default and **2.25s** at 512MB, because 240MB of sort data either fits in memory or becomes an
external merge. **The two levers are coupled, and neither shows that alone.** Standard advice
says "drop your indexes before a bulk load"; standard advice is incomplete.

Timing noise is ~3% (tuned runs: 104.3s, 107.7s, 107.1s; naive: 176.0s, 161.5s), so the index
lever is genuinely inside the noise band and the FK lever is far outside it.

### Which table is biggest on disk, and is that what you expected?

`messages`, by 9.7× — and the prediction was directionally right but ~20% off in both places.

| Table | Total | Heap | Indexes | Index share | Predicted |
|---|---|---|---|---|---|
| `messages` | 2979 MB | 2616 MB | 363 MB | 12.2% | ~3.15GB |
| `conversations` | 307 MB | 198 MB | 109 MB | 35.4% | ~430MB |
| everything else | < 1 MB | | | | |
| **database** | **3294 MB** | | | | ~3.6GB |

Expected: `messages` dominating, and the ~186-char body being most of the row. Confirmed —
`pg_column_size` over 100k rows gives **265.6 bytes per row, of which the body is 190.1 —
71.6%**. Nothing TOASTs, because TOAST only engages past ~2KB, so **none of that 2.6GB is
compressed.** A production system with an `lz4`-compressed body column would be materially
smaller.

Not expected: **the index share is inverted between the two tables.** `messages` is 12% index
while `conversations` is 35%, despite `messages` carrying the larger indexes in absolute terms:

| Index | Size |
|---|---|
| `messages_pkey` | 214 MB |
| `messages_conversation_id_idx` | 150 MB |
| `conversations_pkey` | 75 MB |
| `conversations_assignee_id_idx` | 18 MB |
| `conversations_org_id_idx` | 17 MB |

The uuid is why. `conversations_pkey` is **75MB of that table's 109MB of indexes — 69%** — and
`messages_conversation_id_idx` is 150MB against `messages_pkey`'s 214MB despite indexing one
column instead of being the table's own key, because it stores the same 16-byte uuid 10M times.
This is drill 02's "16 bytes against bigserial's 8, chosen to be measured rather than read
about", finally measured: **the uuid choice costs ~225MB across the two tables.**

On-disk total: **3.2GB of relations**, inside the 4–5GB budget. The *volume* is 5.3GB, because
`pg_wal` holds 2.0GB of recycled segments — Postgres grows to `max_wal_size` and then recycles
rather than deleting. Worth stating separately, since "the database is 3.2GB" and "the volume
is 5.3GB" are both true and only one of them is what a disk quota sees.

### `conversations` is N× `shared_buffers`. What does that do to a full scan?

At 128MB `shared_buffers`: `conversations` heap is **1.5×**, its total relation **2.4×**, and
`messages` **23×**.

Measured on the whale's list query:

```
Buffers: shared hit=14942 read=10542
->  Parallel Seq Scan on conversations (actual time=0.069..69.792 rows=333333 loops=3)
```

**41% of buffer accesses miss.** So the prediction that misses would become visible is
confirmed — the instrument works.

But the interesting part is what the misses *cost*, and the answer is: **much less than "it
goes to disk" implies.** 10,542 misses × 8KB ≈ 84MB, fetched inside a 70ms scan — roughly
1.2GB/s, which is not a disk. Those pages are in the OS page cache, which the container has
~3GB for and Postgres can neither see nor control. The honest answer to the card's question is
that a table larger than `shared_buffers` **stops being free and starts depending on a cache
Postgres does not manage** — and the cliff only arrives when the working set outgrows RAM
entirely, which 3.2GB on this machine does not.

### Drill 03's four predictions, checked

This is the part the drill exists for. Drill 03 wrote down a ranked guess; three hold and one
is falsified.

HTTP p50, 12 warmed requests each, against the state `pnpm db:seed` actually produces:

| | Drill 03 (64 rows) | Drill 04 (1M rows, org 1) | |
|---|---|---|---|
| `pageSize=50` | 2.0 ms | **73.8 ms** | 37× |
| `pageSize=1` | 1.5 ms | 66.2 ms | page size is nearly free |
| `page=2000` | — | 125.0 ms | |
| `page=10000` | — | 140.3 ms | |
| tail org 150, `pageSize=50` | — | **3.2 ms** | 23× faster than the whale |
| `/health` control | 1.3 ms | 1.2 ms | unchanged |
| RSC page | 65.7 ms | 142.8 ms | |

1. **"`Sort` is the first casualty, and `LIMIT` will not save it."** ✅ **Confirmed.** The plan
   is `Parallel Seq Scan → top-N heapsort → Limit`, 105.6ms, of which scanning all 1M matching
   rows is 65ms. `pageSize=1` costs 66.2ms against `pageSize=50`'s 73.8ms — **the page size is
   almost irrelevant**, exactly as predicted, because the work scales with the tenant, not the
   page. The planner also *declines* `conversations_org_id_idx` here: at 40% selectivity a
   sequential scan is genuinely cheaper.
2. **"`count(*)` becomes the slowest half of the response."** ⚠️ **Half right, and the half
   that is wrong is the more interesting one.** The answer depends on something drill 03 had no
   reason to consider: **whether the table has been vacuumed.**

   | State of `conversations` | Plan for `count(*)` | Execution |
   |---|---|---|
   | immediately after the seed commits | `Parallel Seq Scan` | **60.1 ms** |
   | after autovacuum ran (~1 min later) | `Parallel Index Only Scan`, `Heap Fetches: 0` | **35.0 ms** |
   | after an explicit `VACUUM` | same, `relallvisible` = all 25,345 pages | **27.5 ms** |

   An index-only scan is only legal when the *visibility map* marks a page all-visible, and
   **`ANALYZE` does not set the visibility map — only `VACUUM` does.** So a freshly bulk-loaded
   table cannot use one, and `count(*)` costs 60ms; minutes later, with no change to the query,
   the schema, or the data, autovacuum halves it.

   So: `count(*)` is a large fraction of the page cost (57% of the list query when fresh), which
   is the prediction's substance. But it is never *the slowest* part, and it is the only part of
   this endpoint that gets faster on its own. Card 08 should re-measure after real `UPDATE`
   churn, which dirties the visibility map again and should push it back toward the seq-scan
   number.
3. **"`OFFSET` degrades with depth, not with data."** ✅ **Confirmed, and worse than the guess.**
   Page 1 sorts 50 rows in 30kB via top-N heapsort. Page 10,000 must materialise 500,000 rows
   before discarding them, and the plan changes to `Sort Method: external merge Disk: 12344kB`
   — **it spills to disk.** 213.0ms, and the degradation is a step change in algorithm, not a
   gradual slope.
4. **"Response size, far behind the other three."** ✅ Confirmed and last: `pageSize=1` → 50
   costs ~8ms.

**The ranking held where it mattered** — `Sort` first, response size last. The `count(*)` guess
was directionally right about cost and wrong about mechanism, and finding out why turned up the
most transferable fact in the drill: **`ANALYZE` makes the planner smart, `VACUUM` makes
index-only scans possible, and they are not the same operation.**

**The skew earned its keep here.** Org 1 gets `Parallel Seq Scan` (reading 40% of a table via
an index is worse than reading it whole); org 150 gets `Bitmap Index Scan` on the same index
for the same SQL. **One query, two opposite-but-correct plans**, and a uniform 12,500-per-org
fixture would have produced only one of them.

### `COPY` versus the insert loop, and why it is not 1000×

100k identical rows, `apps/backend/db/bench-copy.mjs`:

```
INSERT loop : 7.73s  (12,933 rows/s)
COPY        : 0.11s  (875,610 rows/s)   → 67.7×
```

Across four runs the multiplier ranged 59–68×. The card says a thousand. **The card is right
about the mechanism and wrong about this environment:** both processes are on one laptop on a
Docker bridge, so the round trip a loop pays per row is a memory copy, not a network hop. At a
1ms RTT those 100k inserts would cost 100s on latency alone and the ratio would be in the
thousands. 67× is the *pessimistic* case for `COPY`.

### Realism: what the data actually reads like

Per-row faker measured **131,990 bodies/sec** — below the 150k bar fixed in advance, projecting
76s of the 360s budget. The template corpus runs at ~2M/sec, 40× clear of the bar. The rule
decided it, not preference.

Mean body 187 chars, min 63, max 394; 65,627 distinct 60-char openings per 200,000 rows
sampled. One real thread, top to bottom:

```
2026-05-02 03:08  Can you confirm whether saved views is included on the Basic plan? The
                  pricing page and the in-app banner disagree.
2026-05-02 08:38  Thanks for the detail — that is enough to reproduce. I have escalated it to
                  the team that owns the Slack integration as HVG-32068. That is not expected
                  behaviour. Logged as UOO-91157. Would you be able to share the exact time
                  you saw ERR_2092?
2026-05-02 15:34  Our Rodneyshire office sees it consistently; the rest of the team does not
                  see it at all.
2026-05-03 01:06  We traced the duplicate charges to a retry in the payment webhook. 6296
                  accounts were affected, including yours.
2026-05-03 07:46  The seats have been removed and your next invoice drops to $590.16. Sorry it
                  took a few rounds. Closing this one out. The reporting dashboard now respects
                  your retention settings, effective immediately. Confirmed resolved on our
                  side. I have credited $1271.24 to the account for the disruption.
```

Two honest limits, both visible in that thread:

1. **Coherent in register, not in content.** Message 3 does not answer message 2. Bodies are
   drawn per phase and nothing threads a topic through a conversation.
2. **Slots are drawn independently per sentence**, so one message can carry two different
   ticket references (`HVG-32068` and `UOO-91157` above) or two unrelated amounts. Composing
   2–3 templates is what buys the length variance and the combinatorial uniqueness; this is
   the price. Not introduced by the revision — it was always there, just never written down.

Good enough to judge rendering, pagination and text volume; not good enough to demo semantic
search against.

### Determinism

Full-scale runs, `sum(hashtext(t::text))` per table. **Re-recorded after the
micro-optimisation revision**, which changed message bodies and mid-thread timestamps:

| Table | Rows | Fingerprint | vs. pre-revision |
|---|---|---|---|
| organizations | 200 | 26709482305 | unchanged |
| users | 1,200 | 894726501 | unchanged |
| memberships | 1,778 | 42058786904 | unchanged |
| conversations | 2,500,000 | −2209565241383 | unchanged |
| messages | 10,000,000 | 2014037425657 | was 7013585600148 |

Identical across consecutive runs. This is equality **up to hash collision**, not
byte-identity — worth saying rather than overclaiming, though agreement across five tables and
12.5M rows makes coincidence implausible.

**Four of the five tables surviving the revision bit-for-bit is the useful result here**, not
the determinism itself. `conversations` matching across 2,500,000 rows means the rewritten
`writeUuid()` and `stamp()` produce byte-identical output at database scale, which is a
stronger check than the unit-level byte comparison that motivated the change.

### The `pg_settings.context` map

The split that decides how you change anything:

| `context` | To change it | Settings here |
|---|---|---|
| `postmaster` | restart the server | `shared_buffers`, `wal_level`, `max_wal_senders` |
| `sighup` | reload config | `max_wal_size`, `checkpoint_timeout` |
| `user` | `SET` in the session | `maintenance_work_mem`, `synchronous_commit` |

This is why `shared_buffers` had to move into `command:` while the seeder can raise
`maintenance_work_mem` on its own connection — and why `POSTGRES_INITDB_ARGS` was never a
configuration mechanism at all.

## Also on completion

### The guide — `drills/04-copy-and-bulk-load.md`

Written for someone who has not met any of this before. **No assumed vocabulary**: every term
gets defined the first time it appears, in one sentence, before it gets used. Not matched to
the shape of `drills/02` or `drills/03` — those were written for a reader who already had the
context. This one teaches.

Hard limit: **~250 lines**, and it opens with a five-bullet "if you read nothing else" box so
the whole thing is optional past the first screen. Each section is a question a beginner would
actually ask, answered in a few short paragraphs with one concrete example. No section runs
longer than a screen.

Sections, each answering its own title:

1. **What is `COPY`, and why is an `INSERT` loop slow?** — The thing the whole drill is about.
   `INSERT` is one message to the server per row: the server parses the SQL, plans it, runs
   it, and answers, and your program waits for the answer before sending the next. 100k rows
   is 100k of those round trips. `COPY` is one message that says "here comes a stream of rows"
   followed by the rows as plain text — one parse, one plan, no waiting. Our measured number
   goes here: 7.63s vs 0.13s for the same 100k rows. Includes why it is 59× and not the 1000×
   the card advertises (both processes are on one laptop, so the round trip is nearly free —
   over a real network the gap would be far bigger).
2. **What is WAL, and why does it double the work?** — Write-Ahead Log: before Postgres
   changes any data file, it first writes a description of the change to a separate append-only
   file and makes sure that hit the disk. That is what lets it recover after a power cut — on
   restart it replays the log. The cost is that every row gets written twice, once to the log
   and once to the table. Then: the exception we exploit (if a table was emptied inside the
   same transaction that is filling it, a crash can just leave it empty, so the log is
   pointless and Postgres skips it), what `wal_level=minimal` is, and what it costs us
   (no replicas, no point-in-time restore, until it goes back).
3. **Why did the Postgres settings move into `docker-compose.yml`?** — `POSTGRES_INITDB_ARGS`
   runs once, ever, when the database's data directory is first created. Change it later and
   nothing happens, with no error. `command:` passes the flags to the server on every start.
   Includes how to check what the server is *actually* running (`SHOW shared_buffers`, or the
   `pg_settings` query), because trusting the config file is how the hour gets lost.
4. **What is `shared_buffers`, and what does "the table is 20× bigger than it" mean?** —
   Postgres' own page cache, and why 128MB was picked here on purpose to make cache misses
   visible. Includes the honest caveat that a miss usually still hits the OS page cache, so
   `shared read` is not `disk read`.
5. **Why build indexes *after* loading, instead of during?** — An index is a sorted structure
   maintained on every insert; 10M inserts means 10M small updates to it, each possibly
   splitting a page. Building it once at the end is one big sort instead. Includes why
   `maintenance_work_mem` is the setting that decides whether that sort happens in memory or
   spills to disk, and how 512MB was derived from the actual data size rather than guessed.
6. **What is backpressure, and why does ignoring it crash the process?** — Generating rows is
   faster than the database accepts them. Without backpressure the surplus piles up in your
   program's memory until it dies. What `Readable.from(...).pipe(...)` does about it for free.
7. **Why does skewed data matter more than a lot of data?** — The 40/40/20 split and the
   recency weighting, and the specific way uniform data lies to you about index performance.
8. **What's deliberately wrong here** — the short table of things a production system would do
   differently, so none of this gets copied out as best practice.
9. **The five-line summary.**

### Memory bank

Bullet points, no prose paragraphs, no duplication of what the plan already says.

- `memory-bank/progress.md` — current focus and next step updated; one bullet per shipped item.
- `memory-bank/techContext.md` — new bullets only: the Postgres `command:` block and its
  values, `wal_level=minimal` blocks replication until changed, `db:seed` / `db:seed:ci` /
  `db:reset`, and the two new dependencies. Existing entries left alone.

Verified facts written directly, judgments proposed first.
