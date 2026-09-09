# Drill 15 — Stream a 200MB CSV import without the process memory going up

> Card 15. Prereq 12. Topics: portable backend · failure & resilience · relational
> data layer · modern frontend · concurrency & atomicity.
>
> Sections below the fold are written as the work lands. Predictions are recorded
> before any measurement and are not edited afterwards.

## Context

The whale org wants its historical tickets imported: a 200MB CSV. The obvious
implementation reads the file into a string, parses it into an array, and inserts
row by row inside the request handler. That costs about a gigabyte of heap against
`nest_server`'s `mem_limit: 1g`, and it holds an HTTP request open for the whole
load. Both failures look identical to the customer.

This drill builds the naive version first and measures it against the container
limit, then builds the streaming version and measures it again. The card's real
question is the third one: the import fails at row 400,000, so what is the durable
state and what does a retry do?

Two earlier drills pay for this one. Drill 12's `conversations.provider_event_id`
and its partial unique index make a re-imported row harmless, which turns "restart
from zero" into a correct answer rather than a duplicate storm. Drill 04 already
proved `COPY` beats an `INSERT` loop, so the batch-size sweep has a known upper
bound to be measured against.

The bulk-import path this creates is also what card 30 uses to starve everyone
else. The in-process worker is deliberate, not an oversight.

## What ships

### Arms

Three knobs on `nest_server`, one per write-up question. All three are declared in
the `environment:` list in `docker-compose.yml`, reported by `GET /info`, and
asserted in `test/arms.e2e-spec.ts`.

| Knob | Values | Default | Question it answers |
|---|---|---|---|
| `IMPORT` | `buffer` \| `stream` | `stream` | What was peak memory before and after? |
| `IMPORT_BATCH_ROWS` | integer | `1000` | What set the batch size? |
| `IMPORT_ON_FAIL` | `resume` \| `restart` | `resume` | Resume or restart, and what does the schema need? |

`buffer` is a permanent red arm, the way `naive`, `like`, `rmw` and `lww` are. It
reads the whole file, parses the whole file, inserts one row per transaction, and
answers the request only when it finishes. It changes two things at once — memory
and synchronicity — on purpose. That is what the naive implementation is.

### Schema

One migration, `1788912000000_import-jobs.js`.

```sql
CREATE TABLE import_jobs (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  org_id         bigint NOT NULL REFERENCES organizations(id),
  filename       text NOT NULL,
  byte_size      bigint NOT NULL,
  status         text NOT NULL DEFAULT 'pending',
  mode           text NOT NULL,
  batch_rows     integer NOT NULL,
  rows_read      bigint NOT NULL DEFAULT 0,
  rows_written   bigint NOT NULL DEFAULT 0,
  rows_skipped   bigint NOT NULL DEFAULT 0,
  resume_row     bigint NOT NULL DEFAULT 0,
  peak_rss_bytes bigint,
  error          text,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
```

`resume_row` is the card's schema answer and is a separate column from `rows_read`
on purpose. `rows_read` is what the parser has seen. `resume_row` advances only
inside the transaction that committed those rows, so it can never name a row that
is not durable. That invariant is what makes resume safe.

`import_jobs` carries `org_id`, so it gets RLS enabled plus one
`FOR ALL … USING app_current_org() … WITH CHECK` policy, or `pnpm check:tenancy`
fails. Index `(org_id, created_at DESC)` serves the UI list. The table is added to
the `TRUNCATE` list in `db/seed.mts`, or `pnpm db:seed` fails with `0A000` naming
this table rather than the seed's own list.

No new uniqueness mechanism. An imported conversation reuses drill 12's
`provider_event_id`, set to `import:<external_id>` from the CSV, and the existing
partial unique index makes the insert `ON CONFLICT DO NOTHING`. Restarting from row
zero is therefore correct, and resume is a cost optimisation rather than a
correctness requirement. That distinction is the write-up's answer.

### Endpoint

New module `src/imports/`. Tenant identity comes from `@OrgId()`, the seam
`/conversations` uses. An import is a customer action rather than a webhook, so the
API key is not the right credential here.

- `POST /imports` — `Content-Type: text/csv`, raw body. `pipeline(req,
  createWriteStream('/tmp/imports/<jobId>.csv'))` spools it 64KB at a time, then one
  `INSERT` into `import_jobs`. On `stream`, respond **202** `{jobId}` and start the
  worker. On `buffer`, await the whole import and respond **200**. `@QueryBudget(1)`.
- `GET /imports/:id` — one job.
- `GET /imports` — the org's jobs, newest first, `LIMIT 20`.
- `POST /imports/:id/retry` — re-run a failed job. `@HttpCode(202)`.

Nest registers body parsers for `json` and `urlencoded` only. A `text/*` parser
would buffer the request body before the handler ever saw it, which is a 200MB bug
one tier above the code being measured. Verified rather than assumed.

### The worker

`ImportsService.run(jobId)`. Not a queue, not a child process — an in-process async
function, named as a shortcut in the guide. It is precisely the mechanism card 30
exploits.

The worker runs inside its own `runWithRequestContext({ requestId:
'import-<jobId>', queries: 0, roundTrips: 0, retries: 0 }, …)`. Without a fresh
store it inherits the upload request's counters through `AsyncLocalStorage` and
attributes tens of thousands of statements to a request that made one. The id keeps
`pnpm logs:trace` working and satisfies the `^[A-Za-z0-9_-]{8,64}$` allowlist by
construction, because it is interpolated into a SQL comment.

```
pipeline(
  createReadStream(path, { highWaterMark: 64 * 1024 }),
  parse({ columns: true, from_line: resumeRow + 2 }),   // +1 header, +1 next row
  batchWriter,                                          // highWaterMark: BATCH_ROWS
)
```

`batchWriter` is a `Writable` in object mode. It accumulates rows in `_write`,
flushes at `IMPORT_BATCH_ROWS`, and flushes the remainder in `_final`. Each flush is
one `TenantDb.withOrg` transaction of three statements:

1. multi-row `INSERT INTO conversations … ON CONFLICT (org_id, provider_event_id)
   WHERE provider_event_id IS NOT NULL DO NOTHING RETURNING id, provider_event_id`
2. multi-row `INSERT INTO messages` for the ids that came back
3. `UPDATE import_jobs SET rows_read, rows_written, rows_skipped, resume_row`

Statement 3 is the stretch's answer and costs nothing extra. Progress rides a
transaction the batch was already paying for, so the write side of "report progress
to the UI" is one more statement per thousand rows rather than a mechanism.

An RSS sampler on a 250ms `setInterval` records `process.memoryUsage.rss()` and
writes the peak to the job row on completion. The interval is cleared in a `finally`,
or a failed import leaves a timer holding the process awake.

Backpressure is the point and it is free. When the database is slower than the
parser, the writable's buffer fills, `write()` returns false, `pipeline` pauses the
parser, the parser stops pulling, and the file stream stops reading. Memory stays
flat and wall clock grows. Nothing in the code says "wait".

### CSV shape

`external_id,status,created_at,updated_at,subject,message`

`subject` is present in the file and dropped on import, because migration 002
dropped that column. A real historical export carries fields the current schema does
not have. Quoted fields with embedded commas and newlines are what require a real
parser.

### Dependency

`csv-parse` becomes a runtime dependency of `apps/backend`. It is stream-native, has
no dependencies of its own, and handles RFC 4180 quoting. Its `parse()` is a Node
`Transform`, so it is the backpressure lesson rather than a detour around it.

`pg-copy-streams` stays a `devDependency` and stays out of `src/`. The instrument's
`COPY` arm is its only new caller.

A new dependency needs `pnpm docker:rebuild`, not `up --build` — `/app/node_modules`
is an anonymous volume Compose carries over on recreate.

### Instrument

`db/import.mts`, wired as `pnpm db:import` through `scripts/measure.ts`.

- `gen` — write the CSV. Knobs `MB` (default 200), `POISON_AT` (default 0, meaning
  none), `OUT`. Deterministic, reusing `db/lib/corpus.mts` so bodies look real. The
  poison row carries an unparseable `created_at`, so Postgres raises a real `22007`
  rather than the application throwing a synthetic error.
- `fire` — upload one file through `POST /imports` and assert, exiting 1 on any
  failure: rows landed equals rows in the file, zero 5xx, peak RSS under a stated
  ceiling, and the job reaching `succeeded`. Red on `IMPORT=buffer`.
- `bench` — the batch-size sweep in raw SQL on a scratch table: per-row `INSERT` vs
  batched `INSERT` at 100/1000/5000/10000 vs `COPY`. Reports rows/s and peak RSS per
  arm. Raw SQL rather than over HTTP, for the reason `db:claim bench` states — the
  arm resolves at module load, so an over-HTTP sweep would restart the container
  between arms.
- `resume` — the failure drill. Import a poisoned file, print the durable state,
  retry both ways, assert the final count.

Two memory numbers, and they disagree on purpose. `process.memoryUsage().rss()` is
the application's. `/sys/fs/cgroup/memory.peak` is the container's, and it includes
page cache from reading the file, which is reclaimable and does not cause an OOM.
The instrument reports both and the guide explains the gap. Reporting only the
cgroup number would make the streaming arm look like it leaks.

### Tests

New `test/imports.e2e-spec.ts`, small files only.

- 202 with a job id, the job reaches `succeeded`, row count matches the file.
- Re-uploading the same file writes zero new conversations. Drill 12's index as an
  import property.
- A poisoned file leaves `status='failed'`, an `error` naming the row, `resume_row`
  on a batch boundary, and `count(conversations) == resume_row`. That assertion is
  the card's "what's the state" question with an answer that cannot drift.
- Retry completes the job with no duplicates.
- Org A cannot read org B's job.

`arms.e2e-spec.ts`'s exact `toEqual` gains three keys.

Two new runs:

- `pnpm db:test:buffer` (`IMPORT=buffer`) — expected RED.
- `pnpm db:test:restart` (`IMPORT_ON_FAIL=restart`) — expected GREEN. Restart is
  slower and correct, and a green run is the proof that both answers work.

### UI

New route `app/imports/page.tsx`, plus `app/api/imports/route.ts`.

- A file form and a job table: status, rows read/written/skipped, resume row, wall
  clock, peak RSS, error.
- Progress without JavaScript: `<meta http-equiv="refresh" content="2">` rendered
  only while a job is `running`. One indexed read per poll.
- The browser form is a small-file affordance and is labelled as one. A plain HTML
  file form sends `multipart/form-data`, and reading it back out buffers the whole
  part. The 200MB path goes straight to the API through the instrument or
  `curl --data-binary`. What good looks like is a presigned upload direct to object
  storage, with the API told only the key.
- A Server Action is the rejected alternative. Next buffers a Server Action's body
  and caps it at `serverActions.bodySizeLimit`, default 1MB. A Route Handler has
  neither limit.

### Wiring

- `docker-compose.yml`: three variables in the `nest_server` `environment:` list.
- `scripts/measure.ts`: an `import` catalog entry declaring every knob. Both
  directions are checked by `pnpm check:arms`.
- `package.json`: `db:import`, `db:test:buffer`, `db:test:restart`.
- `README.md`: one progression row and one command line.

## Predictions, recorded before measuring

1. The `buffer` arm exceeds `mem_limit: 1g` on the 200MB file and the container is
   OOM-killed with exit 137, taking the whole API down and restarting it.
2. Streaming peak RSS lands between 120MB and 200MB, most of it the baseline Nest
   process rather than the import.
3. Doubling the file to 400MB moves streaming peak RSS by less than 10%, inside this
   repo's stated noise floor.
4. The batch-size sweep has a hard wall, not a curve. Postgres caps bind parameters
   at 65535, so at six parameters per row anything above ~10,900 rows per statement
   fails outright.
5. `COPY` beats batched `INSERT` by 2-4x on rows/s, and the gap is smaller than
   drill 04's because the parse is now in Node either way.
6. Wall clock is dominated by Postgres, not by the parser. The stream sits idle at
   the writable's high-water mark for most of the run, the same finding drill 04
   recorded about the seed generator.

## Results

Every number below is a report directory under `apps/backend/db/reports/`, named
by its `NAME` knob. All of them are org 1 on the seeded 2.5M-row database.

### The DONE WHEN

| file | rows | HTTP answer | wall clock | peak app RSS |
|---|---|---|---|---|
| 20 MB | 72,517 | **202 in 0.06s** | 4.36s | **123.3 MB** |
| 200 MB | 719,503 | **202 in 0.39s** | 42.70s | **129.8 MB** |
| 400 MB | 1,434,889 | **202 in 0.89s** | 87.44s | **116.5 MB** |

Twenty times the file moves peak RSS by **-5.5%**. Doubling 200MB to 400MB moved
it *down*, from 129.8 to 116.5 MB, so what is being measured there is GC timing
rather than file size. Wall clock is linear: 42.70s to 87.44s is 2.05x for 2x the
rows, at **16,400 rows/s** end to end through the endpoint.

### The naive arm does not get slow. It dies in 2.6 seconds.

`IMPORT=buffer` on the 200MB file never wrote a row. The upload finished, the
worker called `readFile` and then parsed, and the process was gone 2.63 seconds
later with `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap
out of memory`. All six assertions failed, including the two that need a job to
have run at all.

At 20MB the same arm works and can be compared:

| arm | HTTP answer | wall clock | peak app RSS |
|---|---|---|---|
| `buffer` | 200 in **35.08s** | 35.08s | **233.9 MB** |
| `stream` | 202 in **0.06s** | 4.36s | **123.3 MB** |

**8.0x the wall clock, 1.9x the memory, and 585x the time to first answer** — on
a file one tenth the size of the one the card is about.

### Prediction 1 was wrong, and the correction is the better fact

The container was **not** OOM-killed. `docker inspect` reports
`OOMKilled=false`, `RestartCount=0`, and the container stayed up. V8's own heap
limit fired first, at 511MB, while `mem_limit` is 1024MB.

That limit is derived from the cgroup, and it is exactly half of it:

```bash
for LIM in 512m 1g 2g 4g; do docker run --rm -m $LIM drills-nest_server \
  node -e "console.log(require('v8').getHeapStatistics().heap_size_limit/1048576, require('os').totalmem()/1048576)"; done
```

| `mem_limit` | V8 `heap_size_limit` | `os.totalmem()` |
|---|---|---|
| 512m | 259.0 MB | 7935 MB |
| 1g | **524.0 MB** | 7935 MB |
| 2g | 1048.0 MB | 7935 MB |
| 4g | 2096.0 MB | 7935 MB |

So **`os.totalmem()` lies inside a container and V8 does not.** Node reads the
host's `/proc/meminfo`, which is not namespaced, and reports 8GB every time;
V8 reads the cgroup and sizes its heap at half the limit. Two numbers, one of
them the actual constraint. The symptoms differ too: a V8 heap-limit crash
writes a `<--- Last few GCs --->` report and a stack trace, a cgroup OOM is a
silent SIGKILL. Which one you got decides whether the lever is
`--max-old-space-size` or the container limit, and here neither fixes anything —
both just move the wall.

### What a crashed import leaves behind

The job row survives, because it is written before the work starts. It is stuck
on `status = 'running'` forever, with `rows_read = 0`, and the `/imports` page
polls it every two seconds for as long as the tenant leaves the tab open. Nothing
marks it failed, because the code that would have done that was in the process
that died. A worker needs a lease and a heartbeat; this one has neither, and it
is recorded as a gap rather than patched over.

### What set the batch size: a knee, then a wall

`pnpm db:import bench`, 100,000 rows on an unlogged scratch table, arms
interleaved, median of 3.

| arm | ms | rows/s | peak RSS |
|---|---|---|---|
| `insert-per-row` | 7046.4 | 14,192 | 140.0 MB |
| `insert-batch-100` | 432.3 | 231,345 | 142.3 MB |
| **`insert-batch-1000`** | **343.6** | **291,010** | 143.1 MB |
| `insert-batch-5000` | 376.2 | 265,805 | 149.3 MB |
| `insert-batch-10000` | 392.7 | 254,651 | 151.1 MB |
| `insert-batch-20000` | — | — | `08P01 bind message has 14465 parameter formats but 0 parameters` |
| `copy` | 544.1 | 183,804 | 153.7 MB |

Three findings, and two of them contradict the predictions.

**The curve has a knee at 1,000 and then goes backwards.** 100 to 1,000 buys
26%; 1,000 to 10,000 *loses* 12.5%. Batching is worth 20.5x over a per-row loop
and the last 10x of batch size is worth nothing.

**Prediction 4 held, and the error message is a lie.** The ceiling is the wire
protocol's, not the planner's: a Bind message counts its parameters in an
unsigned 16-bit integer. The insert binds four per row plus one shared `org_id`,
so 16,383 rows is the last legal batch. At 20,000 rows it sends 80,001
parameters, and 80001 mod 65536 is **14,465** — the number in the error, which
appears nowhere in the request.

**Prediction 5 was wrong: `COPY` lost.** 183,804 rows/s against batched
`INSERT`'s 291,010 — batched INSERT is **1.58x faster**. Drill 04's "COPY beats
INSERT" is still true against the shape it measured (a per-row loop, 13.0x here)
and is false against a batch of 1,000. The difference is where the work is:
`COPY FROM STDIN` makes Node serialise every row to tab-delimited text through a
generator and a stream, and at this row count that per-row cost in JavaScript
outweighs the per-statement cost it removes.

### Mid-import failure: resume or restart

`pnpm db:import resume` — 100,000 rows, an unparseable `created_at` at row
40,000, batch 1,000.

```
error          row 40001: invalid input syntax for type timestamp with time zone: "not-a-timestamp"
resume_row     39,000        <- committed
rows_read      40,000        <- parsed
conversations  39,000
```

`rows_read` is exactly one batch ahead of `resume_row`, which is why they are two
columns. The batch that contained the poison rolled back whole, so what is
durable is a batch boundary and the database holds exactly `resume_row` rows.

The retry then **fails at the same row and writes nothing**. A retry is not a
repair. Fixing the file and re-uploading writes the missing 61,000, skips the
39,000 already there, and lands at exactly 100,000.

Both fail-modes reach the identical end state, and they differ only in cost:

| `IMPORT_ON_FAIL` | retry wall clock | end state |
|---|---|---|
| `resume` | **0.01s** | failed, `resume_row` 39,000, 39,000 rows |
| `restart` | **0.65s** | failed, `resume_row` 39,000, 39,000 rows |

65x, and the 0.64s is the cost of re-walking 39,000 rows that all skip. Skipping
runs at ~60,000 rows/s against ~19,000 rows/s for writing, so a restart is
roughly a third the price of the original import and it is linear in the cursor.

**What the schema needs for this is one column**, and it needs the column to be
written by the transaction that committed the rows it counts. What resume does
*not* save is the parse: `from` skips emitting records, not reading them, so a
resume at row 400,000 still runs the CSV parser over 400,000 rows. Making that
cheap needs a byte offset and a parser that reports record boundaries.

### Predictions, and what happened

| # | Prediction | Outcome |
|---|---|---|
| 1 | `buffer` OOM-kills the container | **Wrong.** V8's heap limit fired at 511MB, `OOMKilled=false`, and the limit is half the cgroup's |
| 2 | Streaming peak RSS 120-200MB | **Right.** 116.5-129.8 MB across a 20x range of file sizes |
| 3 | Doubling the file moves RSS <10% | **Right**, and it moved *down* 10.3% |
| 4 | A hard parameter wall, not a curve | **Right**, at 16,383 rows rather than the predicted ~10,900, and the error wraps |
| 5 | `COPY` beats batched `INSERT` 2-4x | **Wrong.** Batched `INSERT` is 1.58x faster |
| 6 | Postgres dominates wall clock | **Right.** Batching alone bought 20.5x, so the round trips were the cost |

### Two bugs the measurements found

**The generator wrote unquoted message bodies**, and the corpus writes real
sentences, which contain commas. The first 200MB file failed on line 5 with
`Invalid Record Length: columns length is 6, got 7`. A hand-rolled line splitter
would have accepted that file and written the wrong rows.

**`generate()` read its byte bound as a bare `bytes < targetBytes`**, so the
`resume` subcommand — which passes a row count and leaves the byte target at
zero — wrote an empty file. Every assertion in the run passed against nothing.
Drill 08's rule again: a check that stops checking goes green.

### The red arms

`pnpm db:test:buffer` fails **4**, not the 3 the predictions expected. The fourth
is the retry route answering 500 instead of 202, because the work it does
synchronously is what throws. `pnpm db:test:restart` is green, and a red arm
expected to pass is the point: both answers to the failure question are correct.

Backend suite 118 -> **131**.

## Verification

The stack must be brought up from this worktree before any of it runs.
`docker-compose.yml` has no `name:` key, so Compose derives the project from the
directory, and `container_name:` is pinned — two stacks cannot run at once. Set
`COMPOSE_PROJECT_NAME=drills` on every compose and `pnpm db:*` call to reuse the
existing project, and therefore the seeded volume, with this tree's bind mounts.

Two operational facts that cost a run each:

- **Recreating the container wipes `/tmp`**, so every arm switch loses both the
  generated CSVs and the API's own spooled uploads. Regenerate after a switch.
  `docker compose restart` keeps them; `up -d --force-recreate` does not.
- **`nest start --watch` does not restart a process the heap limit killed.** The
  container stays up and reports unhealthy, and the next run gets
  `ECONNREFUSED`. Restart it after every `IMPORT=buffer` run.

```bash
pnpm docker:rebuild          # csv-parse is a new dependency
pnpm db:migrate
pnpm check:tenancy           # import_jobs has a policy
pnpm check:arms              # three new knobs reach the code that reads them
pnpm arms                    # the container resolved them
```

Then, in order:

```bash
pnpm db:import gen --mb 200
IMPORT=buffer docker compose up -d nest_server && pnpm db:import fire   # expect exit 1
docker compose up -d nest_server && pnpm db:import gen --mb 200
pnpm db:import fire                                                    # expect exit 0
pnpm db:import gen --mb 400 --file history-400mb.csv
pnpm db:import fire --file history-400mb.csv                           # RSS must not move
pnpm db:import bench
pnpm db:import resume
```

Suite runs:

```bash
pnpm db:test                 # 118 plus the new imports spec, all green
pnpm db:test:buffer          # expected RED
pnpm db:test:restart         # expected GREEN
pnpm test:ui                 # unchanged, still 3
```

By hand: `/imports`, upload a small file, watch the row count climb without touching
the browser, confirm the meta refresh stops when the job finishes.

Before done: `pnpm format`, `pnpm lint`, `pnpm typecheck`.

## Release

Bump the root `package.json` to `0.15.0`, tag `drill/15` on the branch (the
`drill/14` precedent), push tags, `gh release create drill/15 --generate-notes`, and
record the release row in `memory-bank/progress.md`. The PR is opened and left
unmerged.
