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

_Written as the measurements land._

## Verification

The stack must be brought up from this worktree before any of it runs.
`docker-compose.yml` has no `name:` key, so Compose derives the project from the
directory, and `container_name:` is pinned — two stacks cannot run at once.

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
docker compose up -d nest_server && pnpm db:import fire                 # expect exit 0
pnpm db:import gen --mb 400 --out history-400mb.csv
pnpm db:import fire --file history-400mb.csv                            # RSS must not move
pnpm db:import bench
pnpm db:import gen --mb 20 --poison-at 400000 --out poisoned.csv
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
