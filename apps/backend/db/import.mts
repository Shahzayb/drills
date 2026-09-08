// Card 15's instrument: what a 200MB CSV costs, and what a failed import leaves
// behind.
//
//   pnpm db:import gen      write a deterministic CSV of MB megabytes
//   pnpm db:import fire     upload it through POST /imports — asserts, exits 1
//   pnpm db:import bench    per-row vs batched INSERT vs COPY, in raw SQL
//   pnpm db:import resume   poison a file, fail on it, then resume and restart
//
// The same split as db/claim.mts and db/quota.mts, for the same reason. `fire`
// measures the ENDPOINT on whichever arm the container is running. `bench`
// reimplements the write shapes in raw SQL against Postgres directly, because
// IMPORT_BATCH_ROWS resolves at module load and an over-HTTP sweep would have to
// restart the container between cells.
//
// `fire` is a correctness proof, not a benchmark. It ASSERTS and exits 1:
//
//   job status         == succeeded
//   rows written       == rows in the file
//   conversations      == rows in the file      nothing lost, nothing doubled
//   answered early     response before the work finished
//   peak app RSS       <  RSS_CEILING_BYTES     flat, not proportional
//   5xx responses      == 0
//
// Those assertions are arm-independent on purpose. `IMPORT=buffer` fails at
// least "answered early", and on a real 200MB file it fails by being OOM-killed
// instead of answering at all. That red run is the deliverable.
//
// TWO MEMORY NUMBERS, and they disagree on purpose:
//
//   app RSS       process.memoryUsage.rss() inside nest_server, sampled by the
//                 worker and stored on the job row. This is the one the card
//                 asks for and the one that must stay flat.
//   cgroup        /sys/fs/cgroup/memory.current, which is what `mem_limit: 1g`
//                 is enforced against. It INCLUDES page cache from reading the
//                 file, so it rises on the streaming arm too. That memory is
//                 reclaimable and does not cause an OOM. Reporting only this
//                 number would make a correct import look like a leak.
//
// `.mts` and not `.ts`: apps/backend/package.json has no `type` field, so a
// `.ts` here would be CommonJS and this file's top-level await would be a syntax
// error. See plans/2026-08-30_instrument-typescript.md.
//
// Full reasoning: plans/2026-09-09_drill-15-streaming-csv-import.md.

import { faker } from '@faker-js/faker';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { createCorpus, mulberry32, phaseFor } from './lib/corpus.mts';
import {
  client as pgClient,
  header,
  knob,
  knobList,
  knobNumber,
  median,
  record,
  serverArms,
} from './lib/run.mts';

const subcommand = process.argv[2];
const SUBCOMMANDS = ['gen', 'fire', 'bench', 'resume'];
const USAGE = `usage: node db/import.mts <${SUBCOMMANDS.join('|')}>`;

if (!SUBCOMMANDS.includes(subcommand)) {
  console.error(USAGE);
  process.exit(1);
}

// `||` and not `??` throughout: the root script forwards these with
// `docker compose exec -e ORG_ID`, and an unset host variable arrives as the
// empty string, not as absent.
const API = process.env.BACKEND_INTERNAL_URL || 'http://nest_server:3002';
const ORG_ID = knob('ORG_ID', '1');
const MB = knobNumber('MB', 200);
const POISON_AT = knobNumber('POISON_AT', 0);
const FILE = knob('FILE', 'history-200mb.csv');
const BATCHES = knobList('BATCHES', '100,1000,5000,10000,20000');
const ROWS = knobNumber('ROWS', 100_000);
const ROUNDS = knobNumber('ROUNDS', 3);
const ONLY = knob('ONLY', '');

/** Generated files live here. Separate from the app's own spool directory so a
 *  source file is never mistaken for an upload in flight. */
const DATA_DIR = '/tmp/import-files';

/** Half the container's 1g limit. An import whose peak RSS is a function of the
 *  file rather than of the batch blows past this long before the OOM killer
 *  arrives, so the assertion fails with a number instead of a dead container. */
const RSS_CEILING_BYTES = 512 * 1024 * 1024;

/** cgroup v2. The path exists on Linux under Docker; absent elsewhere, and the
 *  instrument degrades to the app's own number rather than failing. */
const CGROUP_CURRENT = '/sys/fs/cgroup/memory.current';

const SEED = 20260909;
const MEGABYTE = 1024 * 1024;

const client = pgClient();

const mb = (bytes: number) => `${(bytes / MEGABYTE).toFixed(1)} MB`;
const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

const filePath = (name = FILE) => join(DATA_DIR, name);

const failures: string[] = [];

/** One assertion. Collected rather than thrown, so a run reports every failure
 *  it found instead of only the first. */
function check(ok: boolean, message: string): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
}

// ------------------------------------------------------------------- memory

/** The cgroup's current charge, or null where the file does not exist. */
async function cgroupBytes(): Promise<number | null> {
  try {
    return Number((await readFile(CGROUP_CURRENT, 'utf8')).trim());
  } catch {
    return null;
  }
}

/** Samples the cgroup while `fn` runs. The app's own RSS is not reachable from
 *  this process, so it is read off the job row afterwards. */
async function withCgroupSampler<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; peak: number | null }> {
  let peak = await cgroupBytes();
  const timer = setInterval(() => {
    void cgroupBytes().then((now) => {
      if (now !== null) peak = Math.max(peak ?? 0, now);
    });
  }, 250);
  timer.unref();

  try {
    return { result: await fn(), peak };
  } finally {
    clearInterval(timer);
  }
}

// ------------------------------------------------------------ the generator

/**
 * Write a CSV of roughly MB megabytes.
 *
 * Deterministic: same seed, byte-identical file, so a re-run measures the same
 * thing. External ids are stable across runs on purpose — re-importing the same
 * file is supposed to be a no-op, and that only means something if the keys
 * match.
 *
 * Every 97th row carries a quoted body with an embedded comma and newline. That
 * is what makes a hand-rolled line splitter wrong and a real parser necessary,
 * and it is one row in 97 rather than every row because a file where every field
 * is quoted is not what an export looks like.
 */
async function generate(
  name: string,
  targetBytes: number,
  rowLimit: number,
  poisonAt: number,
): Promise<{ path: string; rows: number; bytes: number }> {
  await mkdir(DATA_DIR, { recursive: true });

  faker.seed(SEED);
  const corpus = createCorpus(faker, mulberry32(SEED + 1));
  const rnd = mulberry32(SEED + 2);

  const path = filePath(name);
  const out = createWriteStream(path);

  const headerLine =
    'external_id,status,created_at,updated_at,subject,message\n';

  let bytes = headerLine.length;
  let rows = 0;

  const write = (chunk: string): Promise<void> =>
    out.write(chunk)
      ? Promise.resolve()
      : new Promise((resolve) => out.once('drain', () => resolve()));

  await write(headerLine);

  // Buffered into ~256KB chunks. One write() per row spends most of the run in
  // stream bookkeeping, and the file this produces is identical either way.
  let pending = '';

  while (bytes < targetBytes && (rowLimit === 0 || rows < rowLimit)) {
    rows += 1;

    const closed = rnd() < 0.55;
    const day = 1 + Math.floor(rnd() * 900);
    const createdAt = new Date(Date.UTC(2023, 0, day, 9, 30, 0)).toISOString();
    const updatedAt = new Date(Date.UTC(2023, 0, day, 14, 15, 0)).toISOString();
    const body = corpus.body(phaseFor(0, 3, closed));

    // THE POISON. A timestamp Postgres cannot parse, so the failure is a real
    // 22007 raised by the database on the batch that contains it, not an
    // exception this code invented. The distinction matters: the point of the
    // experiment is what a transaction does when a statement fails.
    const created = rows === poisonAt ? 'not-a-timestamp' : createdAt;

    const message =
      rows % 97 === 0
        ? `"${body.replace(/"/g, '""')}, and a second line:\nsteps to reproduce"`
        : body;

    pending +=
      `hist-${rows},${closed ? 'closed' : 'open'},${created},${updatedAt},` +
      `"Ticket ${rows}, imported",${message}\n`;

    if (pending.length >= 256 * 1024) {
      bytes += pending.length;
      await write(pending);
      pending = '';
    }
  }

  if (pending) {
    bytes += pending.length;
    await write(pending);
  }

  await new Promise<void>((resolve, reject) => {
    out.end((error?: Error) => (error ? reject(error) : resolve()));
  });

  const { size } = await stat(path);
  return { path, rows, bytes: size };
}

/** How many data rows a file holds. Counted by streaming it, not remembered
 *  from `gen` — a sidecar that drifts from its file is worse than a scan. */
async function countRows(path: string): Promise<number> {
  let newlines = 0;
  let inQuotes = false;
  let previous = 0;

  for await (const chunk of createReadStream(path)) {
    const buffer = chunk as Buffer;
    for (const byte of buffer) {
      // A quote toggles the state unless it is escaped, and an escaped quote
      // ("") toggles twice, which is the same as not toggling at all.
      if (byte === 0x22) inQuotes = !inQuotes;
      else if (byte === 0x0a && !inQuotes) newlines += 1;
      previous = byte;
    }
  }

  // Minus the header. A file not ending in a newline still has its last row.
  return Math.max(0, newlines - 1 + (previous === 0x0a ? 0 : 1));
}

// ------------------------------------------------------------------ the API

interface Job {
  id: string;
  filename: string;
  byteSize: number;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  mode: string;
  batchRows: number;
  rowsRead: number;
  rowsWritten: number;
  rowsSkipped: number;
  resumeRow: number;
  peakRssBytes: number | null;
  error: string | null;
}

const headers = () => ({
  'content-type': 'text/csv',
  'x-org-id': ORG_ID,
});

/** Upload one file. Returns the job and how long the RESPONSE took, which is a
 *  different number from how long the import took and is the whole point. */
async function upload(
  path: string,
): Promise<{ job: Job; status: number; responseMs: number }> {
  const startedAt = performance.now();

  const response = await fetch(`${API}/imports`, {
    method: 'POST',
    headers: { ...headers(), 'x-filename': 'history.csv' },
    // A web stream, so the body is sent as it is read rather than buffered into
    // one Buffer first. `duplex: 'half'` is mandatory for a streaming body and
    // is not in the DOM RequestInit type, hence the cast.
    body: Readable.toWeb(createReadStream(path)) as ReadableStream,
    duplex: 'half',
  } as RequestInit);

  const responseMs = performance.now() - startedAt;
  const body = (await response.json()) as Job;

  return { job: body, status: response.status, responseMs };
}

async function fetchJob(id: string): Promise<Job> {
  const response = await fetch(`${API}/imports/${id}`, {
    headers: { 'x-org-id': ORG_ID },
  });
  return (await response.json()) as Job;
}

/** Poll until the job stops moving, printing progress on the way. */
async function waitFor(id: string): Promise<{ job: Job; doneMs: number }> {
  const startedAt = performance.now();
  let last = -1;

  for (;;) {
    const job = await fetchJob(id);

    if (job.rowsWritten !== last) {
      last = job.rowsWritten;
      process.stdout.write(
        `\r  ${job.status.padEnd(9)} read ${job.rowsRead}  written ${job.rowsWritten}  skipped ${job.rowsSkipped}   `,
      );
    }

    if (job.status === 'succeeded' || job.status === 'failed') {
      process.stdout.write('\n');
      return { job, doneMs: performance.now() - startedAt };
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Every conversation this instrument has ever imported into this org. */
async function importedRows(): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM conversations
      WHERE org_id = $1::bigint AND provider_event_id LIKE 'import:%'`,
    [ORG_ID],
  );
  return Number(rows[0].n);
}

/**
 * Remove them. Messages first — the FK has no ON DELETE, deliberately, so this
 * is the order the schema forces.
 *
 * Runs as POSTGRES_USER, which owns the tables and is therefore outside RLS.
 * That is the same exemption drill 07 recorded and the reason the seed can
 * write across tenants.
 */
async function cleanup(): Promise<number> {
  await client.query(
    `DELETE FROM messages m USING conversations c
      WHERE m.conversation_id = c.id AND c.org_id = $1::bigint
        AND c.provider_event_id LIKE 'import:%'`,
    [ORG_ID],
  );
  const { rowCount } = await client.query(
    `DELETE FROM conversations
      WHERE org_id = $1::bigint AND provider_event_id LIKE 'import:%'`,
    [ORG_ID],
  );
  return rowCount ?? 0;
}

// --------------------------------------------------------------- gen

async function gen(): Promise<void> {
  header(`generating ${FILE}`);

  const startedAt = performance.now();
  const result = await generate(FILE, MB * MEGABYTE, 0, POISON_AT);
  const elapsed = performance.now() - startedAt;

  console.log(`  path      ${result.path}`);
  console.log(`  size      ${mb(result.bytes)}`);
  console.log(`  rows      ${result.rows.toLocaleString()}`);
  console.log(`  poison    ${POISON_AT || 'none'}`);
  console.log(`  wrote in  ${secs(elapsed)}`);

  record('import', 'gen', {
    rows: [
      {
        path: result.path,
        bytes: result.bytes,
        rows: result.rows,
        poisonAt: POISON_AT,
        writeMs: Math.round(elapsed),
      },
    ],
  });
}

// -------------------------------------------------------------- fire

async function fire(): Promise<void> {
  const path = filePath();

  if (!existsSync(path)) {
    console.error(`${path} does not exist — run \`pnpm db:import gen\` first`);
    process.exit(1);
  }

  const arms = await serverArms(API);
  header(`importing ${FILE}`);

  if (arms) console.log(`  server arm  IMPORT=${arms.import} batch=${arms.importBatchRows}\n`); // prettier-ignore

  const { size } = await stat(path);
  const removed = await cleanup();
  const fileRows = await countRows(path);

  console.log(`  file       ${mb(size)}, ${fileRows.toLocaleString()} rows`);
  console.log(`  cleaned    ${removed.toLocaleString()} rows from a previous run\n`); // prettier-ignore

  const before = await cgroupBytes();

  const { result, peak: cgroupPeak } = await withCgroupSampler(async () => {
    const uploaded = await upload(path);
    const finished = await waitFor(uploaded.job.id);
    return { ...uploaded, ...finished };
  });

  const landed = await importedRows();

  console.log('');
  console.log(`  response          ${result.status} after ${secs(result.responseMs)}`); // prettier-ignore
  console.log(`  import finished   ${secs(result.doneMs)} after the upload started`); // prettier-ignore
  console.log(`  rows written      ${result.job.rowsWritten.toLocaleString()}`);
  console.log(`  rows skipped      ${result.job.rowsSkipped.toLocaleString()}`);
  console.log(`  conversations     ${landed.toLocaleString()}`);
  console.log(
    `  peak app RSS      ${result.job.peakRssBytes === null ? 'n/a' : mb(result.job.peakRssBytes)}`,
  );
  console.log(
    `  cgroup            ${before === null ? 'n/a' : mb(before)} -> ${cgroupPeak === null ? 'n/a' : mb(cgroupPeak)}  (includes page cache)`,
  );
  if (result.job.error) console.log(`  error             ${result.job.error}`);

  console.log('');
  check(result.job.status === 'succeeded', `job succeeded (${result.job.status})`); // prettier-ignore
  check(result.job.rowsWritten === fileRows, `wrote every row (${result.job.rowsWritten} of ${fileRows})`); // prettier-ignore
  check(landed === fileRows, `database holds every row (${landed} of ${fileRows})`); // prettier-ignore
  check(result.status < 500, `no 5xx (${result.status})`);
  check(
    result.responseMs < result.doneMs / 2,
    `answered before the work finished (${secs(result.responseMs)} vs ${secs(result.doneMs)})`,
  );
  check(
    result.job.peakRssBytes !== null &&
      result.job.peakRssBytes < RSS_CEILING_BYTES,
    `peak app RSS under ${mb(RSS_CEILING_BYTES)}`,
  );

  record('import', 'fire', {
    arms,
    rows: [
      {
        file: FILE,
        bytes: size,
        fileRows,
        httpStatus: result.status,
        responseMs: Math.round(result.responseMs),
        doneMs: Math.round(result.doneMs),
        mode: result.job.mode,
        batchRows: result.job.batchRows,
        rowsWritten: result.job.rowsWritten,
        rowsSkipped: result.job.rowsSkipped,
        conversations: landed,
        peakRssBytes: result.job.peakRssBytes,
        cgroupBeforeBytes: before,
        cgroupPeakBytes: cgroupPeak,
        error: result.job.error,
      },
    ],
  });
}

// ------------------------------------------------------------- bench

const SCRATCH = `
  CREATE UNLOGGED TABLE import_bench (
    id          bigserial   PRIMARY KEY,
    org_id      bigint      NOT NULL,
    status      text        NOT NULL,
    external_id text        NOT NULL,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL
  );
`;

interface Row {
  externalId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

function corpusRows(count: number): Row[] {
  const rnd = mulberry32(SEED + 3);
  return Array.from({ length: count }, (_, i) => {
    const day = 1 + Math.floor(rnd() * 900);
    return {
      externalId: `bench-${i}`,
      status: rnd() < 0.55 ? 'closed' : 'open',
      createdAt: new Date(Date.UTC(2023, 0, day, 9, 30, 0)).toISOString(),
      updatedAt: new Date(Date.UTC(2023, 0, day, 14, 15, 0)).toISOString(),
    };
  });
}

/** One row per statement. The shape the buffered arm uses, and the control. */
async function insertOneByOne(rows: Row[]): Promise<void> {
  for (const row of rows) {
    await client.query(
      `INSERT INTO import_bench (org_id, status, external_id, created_at, updated_at)
       VALUES ($1::bigint, $2, $3, $4::timestamptz, $5::timestamptz)`,
      [ORG_ID, row.status, row.externalId, row.createdAt, row.updatedAt],
    );
  }
}

/**
 * N rows per statement, five bind parameters each.
 *
 * The ceiling is Postgres's and it is hard: a statement may bind at most 65535
 * parameters, so 13,107 rows is the last legal batch at this arity. The error
 * above it is not a slow query, it is a protocol error, which is why the ladder
 * runs past the wall on purpose.
 */
async function insertBatched(rows: Row[], size: number): Promise<void> {
  for (let start = 0; start < rows.length; start += size) {
    const slice = rows.slice(start, start + size);
    const params: unknown[] = [ORG_ID];
    const values = slice.map((row) => {
      const base = params.length;
      params.push(row.status, row.externalId, row.createdAt, row.updatedAt);
      return `($1::bigint, $${base + 1}, $${base + 2}, $${base + 3}::timestamptz, $${base + 4}::timestamptz)`;
    });

    await client.query(
      `INSERT INTO import_bench (org_id, status, external_id, created_at, updated_at)
       VALUES ${values.join(', ')}`,
      params,
    );
  }
}

/** The upper bound. No bind parameters at all, so no ceiling to hit. */
async function copyRows(rows: Row[]): Promise<void> {
  const source = Readable.from(
    (function* () {
      for (const row of rows) {
        yield `${ORG_ID}\t${row.status}\t${row.externalId}\t${row.createdAt}\t${row.updatedAt}\n`;
      }
    })(),
  );

  await pipeline(
    source,
    client.query(
      copyFrom(
        `COPY import_bench (org_id, status, external_id, created_at, updated_at) FROM STDIN`,
      ),
    ),
  );
}

async function bench(): Promise<void> {
  header(`write shapes at ${ROWS.toLocaleString()} rows`);

  const rows = corpusRows(ROWS);

  const arms: { label: string; run: () => Promise<void> }[] = [
    { label: 'insert-per-row', run: () => insertOneByOne(rows) },
    ...BATCHES.map((size) => ({
      label: `insert-batch-${size}`,
      run: () => insertBatched(rows, size),
    })),
    { label: 'copy', run: () => copyRows(rows) },
  ].filter((arm) => !ONLY || arm.label.includes(ONLY));

  // Per-row at 100k rows is 100k round trips and takes minutes. Measured once
  // rather than ROUNDS times, and the summary says so — a control that triples
  // the run time teaches nothing the first measurement did not.
  const roundsFor = (label: string) =>
    label === 'insert-per-row' ? 1 : ROUNDS;

  const samples = new Map<string, number[]>();
  const peaks = new Map<string, number>();
  const errors = new Map<string, string>();

  for (let round = 0; round < ROUNDS; round++) {
    // Interleaved, not grouped: drill 05's method, so a machine drifting slower
    // over the run cannot be mistaken for an arm being slower.
    for (const arm of arms) {
      if (round >= roundsFor(arm.label)) continue;
      if (errors.has(arm.label)) continue;

      await client.query('DROP TABLE IF EXISTS import_bench');
      await client.query(SCRATCH);

      let peak = process.memoryUsage.rss();
      const sampler = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage.rss());
      }, 100);
      sampler.unref();

      const startedAt = performance.now();
      try {
        await arm.run();
      } catch (error) {
        const e = error as { code?: string; message?: string };
        errors.set(arm.label, `${e.code ?? ''} ${e.message ?? ''}`.trim());
        clearInterval(sampler);
        continue;
      } finally {
        clearInterval(sampler);
      }

      const elapsed = performance.now() - startedAt;
      samples.set(arm.label, [...(samples.get(arm.label) ?? []), elapsed]);
      peaks.set(arm.label, Math.max(peaks.get(arm.label) ?? 0, peak));
    }
  }

  await client.query('DROP TABLE IF EXISTS import_bench');

  const table = arms.map((arm) => {
    const failed = errors.get(arm.label);
    if (failed) {
      return { arm: arm.label, ms: null, 'rows/s': null, 'peak RSS': null, error: failed }; // prettier-ignore
    }
    const ms = median(samples.get(arm.label) ?? [0]);
    return {
      arm: arm.label,
      ms: Number(ms.toFixed(1)),
      'rows/s': Math.round(ROWS / (ms / 1000)),
      'peak RSS': mb(peaks.get(arm.label) ?? 0),
      error: '',
    };
  });

  console.table(table);
  record('import', 'bench', { rows: table });
}

// ------------------------------------------------------------ resume

/**
 * The card's third question, run rather than argued.
 *
 * A poisoned file fails inside one batch. That batch's transaction rolls back,
 * so what is durable is exactly the batches before it — and `resume_row` names
 * that boundary because it was written by the same transaction.
 *
 * The retry then fails at the same row, which is the honest answer: a retry is
 * not a repair. What it proves is that the cursor did not move and nothing was
 * double-written. Fixing the data and re-uploading is the other half, and it
 * lands only the rows that were missing.
 */
async function resume(): Promise<void> {
  const arms = await serverArms(API);
  const poisonAt = POISON_AT || Math.floor(ROWS * 0.4);

  header(`failing an import at row ${poisonAt.toLocaleString()} of ${ROWS.toLocaleString()}`); // prettier-ignore

  if (arms) console.log(`  server arm  IMPORT_ON_FAIL=${arms.importOnFail} batch=${arms.importBatchRows}\n`); // prettier-ignore

  await cleanup();

  const bad = await generate('resume-poisoned.csv', 0, ROWS, poisonAt);
  const good = await generate('resume-clean.csv', 0, ROWS, 0);

  console.log(
    `  poisoned  ${mb(bad.bytes)}, ${bad.rows.toLocaleString()} rows`,
  );
  console.log(`  clean     ${mb(good.bytes)}, ${good.rows.toLocaleString()} rows\n`); // prettier-ignore

  // ---- attempt 1: it fails
  const first = await upload(bad.path);
  const failed = await waitFor(first.job.id);
  const afterFail = await importedRows();

  console.log('\n  after the failure');
  console.log(`    status         ${failed.job.status}`);
  console.log(`    error          ${failed.job.error}`);
  console.log(`    resume_row     ${failed.job.resumeRow.toLocaleString()}`);
  console.log(`    rows_read      ${failed.job.rowsRead.toLocaleString()}`);
  console.log(`    conversations  ${afterFail.toLocaleString()}\n`);

  check(failed.job.status === 'failed', 'the job is marked failed');
  check(afterFail === failed.job.resumeRow, `the database holds exactly resume_row rows (${afterFail} vs ${failed.job.resumeRow})`); // prettier-ignore
  check(
    failed.job.resumeRow % failed.job.batchRows === 0,
    `resume_row is on a batch boundary (${failed.job.resumeRow} % ${failed.job.batchRows})`,
  );
  check(failed.job.resumeRow < poisonAt, 'nothing past the poison row committed'); // prettier-ignore

  // ---- attempt 2: retrying the same bad file
  const retryStartedAt = performance.now();
  const retried = await fetch(`${API}/imports/${first.job.id}/retry`, {
    method: 'POST',
    headers: { 'x-org-id': ORG_ID },
  });
  await retried.arrayBuffer();
  const second = await waitFor(first.job.id);
  const retryMs = performance.now() - retryStartedAt;
  const afterRetry = await importedRows();

  console.log('\n  after the retry');
  console.log(`    status         ${second.job.status}`);
  console.log(`    resume_row     ${second.job.resumeRow.toLocaleString()}`);
  console.log(`    conversations  ${afterRetry.toLocaleString()}`);
  console.log(`    took           ${secs(retryMs)}\n`);

  check(second.job.status === 'failed', 'the retry fails at the same row — a retry is not a repair'); // prettier-ignore
  check(afterRetry === afterFail, `the retry double-wrote nothing (${afterRetry} vs ${afterFail})`); // prettier-ignore

  // ---- attempt 3: the fixed file, uploaded fresh
  const fixStartedAt = performance.now();
  const third = await upload(good.path);
  const fixed = await waitFor(third.job.id);
  const fixMs = performance.now() - fixStartedAt;
  const afterFix = await importedRows();

  console.log('\n  after re-uploading the fixed file');
  console.log(`    status         ${fixed.job.status}`);
  console.log(`    rows_written   ${fixed.job.rowsWritten.toLocaleString()}`);
  console.log(`    rows_skipped   ${fixed.job.rowsSkipped.toLocaleString()}   <- already imported`); // prettier-ignore
  console.log(`    conversations  ${afterFix.toLocaleString()}`);
  console.log(`    took           ${secs(fixMs)}\n`);

  check(fixed.job.status === 'succeeded', 'the fixed file imports cleanly');
  check(afterFix === good.rows, `every row is present exactly once (${afterFix} of ${good.rows})`); // prettier-ignore
  check(fixed.job.rowsSkipped === afterFail, `it skipped exactly what was already there (${fixed.job.rowsSkipped} vs ${afterFail})`); // prettier-ignore

  record('import', 'resume', {
    arms,
    rows: [
      {
        rows: ROWS,
        poisonAt,
        batchRows: failed.job.batchRows,
        failedResumeRow: failed.job.resumeRow,
        conversationsAfterFail: afterFail,
        retryResumeRow: second.job.resumeRow,
        conversationsAfterRetry: afterRetry,
        retryMs: Math.round(retryMs),
        fixedWritten: fixed.job.rowsWritten,
        fixedSkipped: fixed.job.rowsSkipped,
        conversationsAfterFix: afterFix,
        fixMs: Math.round(fixMs),
      },
    ],
  });
}

// ------------------------------------------------------------------ dispatch

await client.connect();

try {
  if (subcommand === 'gen') await gen();
  else if (subcommand === 'fire') await fire();
  else if (subcommand === 'bench') await bench();
  else await resume();
} finally {
  await client.end();
}

if (failures.length) {
  console.error(`\n${failures.length} assertion(s) failed`);
  process.exit(1);
}
