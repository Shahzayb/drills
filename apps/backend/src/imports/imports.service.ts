import { Injectable, NotFoundException } from '@nestjs/common';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse } from 'csv-parse';
import { parse as parseAll } from 'csv-parse/sync';
import { errorMessage, logger } from '../observability/logger';
import { runWithRequestContext } from '../observability/request-context';
import { TenantDb, TenantQuery } from '../tenancy/tenant-db.service';

/**
 * How a CSV becomes rows. Card 15.
 *
 * - `buffer`  read the whole file into a string, parse it into an array, insert
 *             one row per transaction, and answer the request only when the
 *             last one lands. This is what gets written first, every time. It
 *             spends heap proportional to the file and holds the connection
 *             open for the whole load, and both of those look to the customer
 *             like the import being broken.
 * - `stream`  parse incrementally, insert in batches, answer 202 with a job id
 *             and do the work afterwards. Memory is proportional to the BATCH,
 *             not to the file.
 *
 * `stream` is the default because it is what you would ship. `buffer` is a
 * permanent measurement arm, the way `naive`, `like`, `rmw` and `lww` are, and
 * it deliberately changes two things at once — memory and synchronicity —
 * because that is what the naive implementation is rather than a variable
 * someone chose to vary.
 *
 * See plans/2026-09-09_drill-15-streaming-csv-import.md.
 */
export type ImportMode = 'buffer' | 'stream';

export const IMPORT: ImportMode =
  process.env.IMPORT === 'buffer' ? 'buffer' : 'stream';

/**
 * Rows per INSERT, and per transaction.
 *
 * Two ceilings, and only one of them is a judgement call.
 *
 * The hard one is the wire protocol: a Bind message counts its parameters in an
 * unsigned 16-bit integer, so 65535 is the limit. The conversation insert binds
 * four per row plus one shared org_id, which puts the ceiling at 16,383 rows.
 * Past it the count WRAPS rather than erroring cleanly — 20,000 rows reports
 * `bind message has 14465 parameter formats but 0 parameters`, a number that
 * appears nowhere in the request. Measured in `pnpm db:import bench`.
 *
 * The soft one is the shape of the curve, and it has a knee rather than a
 * slope: 100 rows a batch runs at 231k rows/s, 1000 at 291k, 5000 at 266k and
 * 10000 at 255k. Bigger stops helping at 1000 and starts hurting, so 1000 is
 * measured rather than picked.
 */
export const IMPORT_BATCH_ROWS = Number(
  process.env.IMPORT_BATCH_ROWS || '1000',
);

/**
 * What a retry of a failed job does.
 *
 * - `resume`   pick up at `resume_row`, the last row a transaction committed.
 * - `restart`  walk the file from the top again.
 *
 * BOTH ARE CORRECT, and that is the finding rather than a caveat. An imported
 * conversation carries drill 12's `provider_event_id` as `import:<external_id>`,
 * so re-importing a row the database already has is an `ON CONFLICT DO NOTHING`.
 * Resume is therefore a cost optimisation and not a correctness requirement,
 * which is why `pnpm db:test:restart` is expected GREEN where every other red
 * arm in this repo is expected to fail.
 *
 * What resume does NOT save is the parse. `from` skips emitting records, not
 * reading them, so a resume at row 400,000 still runs the CSV parser over the
 * first 400,000 rows. Making that cheap needs a byte offset in the schema and a
 * parser that hands back record boundaries. Priced in the guide, not built.
 */
export type FailMode = 'resume' | 'restart';

export const IMPORT_ON_FAIL: FailMode =
  process.env.IMPORT_ON_FAIL === 'restart' ? 'restart' : 'resume';

/** Where the request body is spooled. Not a knob: the path is derived from the
 *  job id, so the job row is the only thing that has to be looked up. */
const SPOOL_DIR = join(tmpdir(), 'imports');

/** What the file stream reads at a time. Node's own default for a file is 64KB;
 *  stated here because it is one of the two numbers that bound peak memory. */
const FILE_CHUNK_BYTES = 64 * 1024;

/** How often the RSS sampler looks. Fine enough to catch a spike inside a
 *  sub-second import, coarse enough to be free on a forty-minute one. */
const RSS_SAMPLE_MS = 250;

/** The namespace this import's rows occupy in `conversations.provider_event_id`.
 *  The webhook receiver owns the same column, so the two must not collide. */
const KEY_PREFIX = 'import:';

export type ImportStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface ImportJob {
  id: string;
  filename: string;
  byteSize: number;
  status: ImportStatus;
  mode: ImportMode;
  batchRows: number;
  /** Records the parser has emitted. Ahead of the database by up to one batch. */
  rowsRead: number;
  rowsWritten: number;
  /** Rows the unique index refused because they were already imported. */
  rowsSkipped: number;
  /** Rows a transaction has COMMITTED. The only number a retry may trust. */
  resumeRow: number;
  peakRssBytes: number | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One CSV record. `subject` is read and dropped — migration 002 removed that
 *  column, and a real historical export carries fields you no longer have. */
interface CsvRow {
  external_id: string;
  status: string;
  created_at: string;
  updated_at: string;
  subject: string;
  message: string;
}

interface JobRow {
  id: string;
  filename: string;
  byte_size: string;
  status: ImportStatus;
  mode: ImportMode;
  batch_rows: number;
  rows_read: string;
  rows_written: string;
  rows_skipped: string;
  resume_row: string;
  peak_rss_bytes: string | null;
  error: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const JOB_COLUMNS = `id, filename, byte_size, status, mode, batch_rows,
                     rows_read, rows_written, rows_skipped, resume_row,
                     peak_rss_bytes, error, started_at, finished_at,
                     created_at, updated_at`;

const toJob = (row: JobRow): ImportJob => ({
  id: row.id,
  filename: row.filename,
  byteSize: Number(row.byte_size),
  status: row.status,
  mode: row.mode,
  batchRows: row.batch_rows,
  rowsRead: Number(row.rows_read),
  rowsWritten: Number(row.rows_written),
  rowsSkipped: Number(row.rows_skipped),
  resumeRow: Number(row.resume_row),
  peakRssBytes: row.peak_rss_bytes === null ? null : Number(row.peak_rss_bytes),
  error: row.error,
  startedAt: row.started_at?.toISOString() ?? null,
  finishedAt: row.finished_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const spoolPath = (jobId: string) => join(SPOOL_DIR, `${jobId}.csv`);

/** Running totals for one attempt. Held in JS and written once per batch, so
 *  the progress update rides a transaction the batch was already paying for. */
interface Counters {
  read: number;
  written: number;
  skipped: number;
  committed: number;
}

@Injectable()
export class ImportsService {
  private readonly logger = logger;

  constructor(private readonly tenants: TenantDb) {}

  /**
   * Take the upload and decide who waits for it.
   *
   * The body is spooled to disk before anything else, at 64KB a time, so this
   * step is bounded no matter how big the file is. Spooling to a temporary name
   * and renaming afterwards is what lets the path be derived from the job id
   * without carrying a `spool_path` column that would only ever hold one value.
   */
  async receive(
    orgId: string,
    filename: string,
    body: NodeJS.ReadableStream,
  ): Promise<ImportJob> {
    await mkdir(SPOOL_DIR, { recursive: true });

    const staging = join(SPOOL_DIR, `upload-${Date.now()}-${process.pid}.csv`);

    await pipeline(body, createWriteStream(staging));

    const { size } = await stat(staging);

    const job = await this.tenants.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<JobRow>(
        `INSERT INTO import_jobs (org_id, filename, byte_size, mode, batch_rows)
         VALUES ($1::bigint, $2, $3::bigint, $4, $5)
         RETURNING ${JOB_COLUMNS}`,
        [orgId, filename, size, IMPORT, IMPORT_BATCH_ROWS],
      );
      return toJob(rows[0]);
    });

    await rename(staging, spoolPath(job.id));

    // The whole arm, in one branch. `buffer` makes the caller wait; `stream`
    // answers now and works afterwards.
    if (IMPORT === 'buffer') return this.run(orgId, job.id);

    this.detach(orgId, job.id);
    return job;
  }

  /**
   * Start the worker without the caller's request context.
   *
   * A bare `void this.run(...)` inherits the upload request's AsyncLocalStorage
   * store, so every statement of a million-row import increments the counters
   * of a request that made one — the query budget then reports tens of
   * thousands and `x-query-count` becomes a lie. A fresh store fixes it.
   *
   * The id is kept human and greppable rather than random, and it satisfies
   * deriveRequestId's `^[A-Za-z0-9_-]{8,64}$` allowlist by construction, which
   * matters because it is interpolated into a SQL comment.
   */
  private detach(orgId: string, jobId: string): void {
    void runWithRequestContext(
      { requestId: `import-${jobId}`, queries: 0, roundTrips: 0, retries: 0 },
      () =>
        this.run(orgId, jobId).catch((error: unknown) => {
          // Already recorded on the job row by run(); this line is so a failed
          // import is visible in `docker compose logs` without a query.
          this.logger.error(
            { jobId, orgId, err: errorMessage(error) },
            'import_failed',
          );
        }),
    );
  }

  /**
   * One attempt at one job.
   *
   * Every exit path — success, parse error, constraint violation — leaves the
   * job row describing what is durable. Nothing about the state of an import is
   * recoverable from the file alone.
   */
  async run(orgId: string, jobId: string): Promise<ImportJob> {
    const job = await this.mustGet(orgId, jobId);

    // `restart` throws away the claim that anything is already imported. It is
    // still correct, because the unique index makes the re-insert a no-op —
    // which is the whole reason this is a knob and not a bug.
    const from = IMPORT_ON_FAIL === 'restart' ? 0 : job.resumeRow;

    const counters: Counters =
      from === 0
        ? { read: 0, written: 0, skipped: 0, committed: 0 }
        : {
            read: job.rowsRead,
            written: job.rowsWritten,
            skipped: job.rowsSkipped,
            committed: job.resumeRow,
          };

    await this.setStatus(orgId, jobId, 'running', counters);

    let peakRss = process.memoryUsage.rss();
    const sampler = setInterval(() => {
      peakRss = Math.max(peakRss, process.memoryUsage.rss());
    }, RSS_SAMPLE_MS);
    // Not a reason for the process to stay alive, and cleared below regardless.
    sampler.unref();

    try {
      if (IMPORT === 'buffer') {
        await this.runBuffered(orgId, jobId, counters);
      } else {
        await this.runStreamed(orgId, jobId, from, counters);
      }

      clearInterval(sampler);
      return this.finish(orgId, jobId, 'succeeded', counters, peakRss, null);
    } catch (error) {
      clearInterval(sampler);
      // The row keeps `resume_row` from the last batch that committed. The
      // failing batch rolled back, so nothing between resume_row and the error
      // is in the database — which is what makes "what is the state" a question
      // with one answer.
      await this.finish(
        orgId,
        jobId,
        'failed',
        counters,
        peakRss,
        `row ${counters.read + 1}: ${errorMessage(error)}`,
      );
      throw error;
    }
  }

  /**
   * The naive arm.
   *
   * `readFile` materialises the whole file as one string; `parse` materialises
   * every record as an object; the loop then opens one transaction per row.
   * Three separate ways to spend memory and time, and it is written as one
   * obvious block on purpose. Tidying it would stop it being the control.
   */
  private async runBuffered(
    orgId: string,
    jobId: string,
    counters: Counters,
  ): Promise<void> {
    const text = await readFile(spoolPath(jobId), 'utf8');
    const rows: CsvRow[] = parseAll(text, { columns: true, bom: true });

    for (const row of rows) {
      counters.read += 1;
      await this.writeBatch(orgId, jobId, [row], counters);
    }
  }

  /**
   * The streaming arm. Three stages, and the middle one is a real Transform.
   *
   * Backpressure is what makes this bounded and it is not written anywhere.
   * When Postgres is slower than the parser, the writable's buffer reaches its
   * high-water mark, `write()` returns false, `pipeline` stops the parser
   * pulling, and the parser stops the file stream reading. Wall clock grows and
   * memory does not. Delete the awaits inside `writeBatch` and that stops being
   * true immediately: the writable would accept every row, and the file would
   * be in memory again with extra steps.
   *
   * `from`, not `from_line`. `from_line` counts the header, so resuming with it
   * and `columns: true` would consume the first DATA row as the column names —
   * a silent off-by-one that costs one row per retry and reports success.
   */
  private async runStreamed(
    orgId: string,
    jobId: string,
    from: number,
    counters: Counters,
  ): Promise<void> {
    const batch: CsvRow[] = [];

    const flush = async (): Promise<void> => {
      if (!batch.length) return;
      const rows = batch.splice(0, batch.length);
      await this.writeBatch(orgId, jobId, rows, counters);
    };

    const writer = new Writable({
      objectMode: true,
      // The stream's own buffer is sized to the batch, so the two numbers that
      // bound memory are this and FILE_CHUNK_BYTES.
      highWaterMark: IMPORT_BATCH_ROWS,
      write: (chunk: CsvRow, _encoding, callback) => {
        batch.push(chunk);
        counters.read += 1;
        if (batch.length < IMPORT_BATCH_ROWS) {
          callback();
          return;
        }
        flush().then(() => callback(), callback);
      },
      final: (callback) => {
        flush().then(() => callback(), callback);
      },
    });

    await pipeline(
      createReadStream(spoolPath(jobId), { highWaterMark: FILE_CHUNK_BYTES }),
      parse({ columns: true, bom: true, from: from + 1 }),
      writer,
    );
  }

  /**
   * One batch, one transaction, three statements.
   *
   * Statement 3 is the progress report, and it is the answer to the card's
   * stretch: the cheapest mechanism that does not hammer the database is one
   * more statement inside a transaction the batch is already paying for. A
   * separate progress write would double the transactions.
   *
   * `resume_row` is set from the same in-memory counter the rows came from, in
   * the same transaction that inserted them. It commits with them or it rolls
   * back with them. There is no third outcome, and that is the entire safety
   * argument for resuming.
   */
  private async writeBatch(
    orgId: string,
    jobId: string,
    rows: CsvRow[],
    counters: Counters,
  ): Promise<void> {
    await this.tenants.withOrg(orgId, async (tx) => {
      const inserted = await this.insertConversations(tx, orgId, rows);

      counters.written += inserted.size;
      counters.skipped += rows.length - inserted.size;
      counters.committed += rows.length;

      await this.insertMessages(tx, orgId, rows, inserted);

      await tx.query(
        `UPDATE import_jobs
            SET rows_read = $2::bigint, rows_written = $3::bigint,
                rows_skipped = $4::bigint, resume_row = $5::bigint,
                updated_at = now()
          WHERE id = $1::uuid`,
        [
          jobId,
          counters.read,
          counters.written,
          counters.skipped,
          counters.committed,
        ],
      );
    });
  }

  /**
   * The conversations half. Returns external_id -> new conversation id for the
   * rows that actually landed; a row missing from the map was already imported.
   *
   * `DO NOTHING` and not `DO UPDATE`. Two rows carrying the same external_id
   * inside ONE statement are legal here — the second conflicts with the first's
   * speculative insertion and is skipped. `DO UPDATE` raises 21000 on exactly
   * that input, which a customer's export produces without trying.
   *
   * `WHERE provider_event_id IS NOT NULL` repeats the partial index's predicate
   * because Postgres will not match a statement to a partial index otherwise —
   * 42P10, the same trap drill 12 recorded.
   *
   * `created_at`/`updated_at` are bound as text and cast by Postgres. A row
   * whose timestamp does not parse raises 22007 from the database rather than
   * being silently coerced in JavaScript, which is what makes the poisoned-file
   * experiment a real failure instead of a simulated one.
   *
   * `last_message_at` takes the CSV's own `updated_at` rather than the column
   * default. A historical export imported today did not have its last message
   * today, and `DEFAULT now()` would say it did. Card 16.
   */
  private async insertConversations(
    tx: TenantQuery,
    orgId: string,
    rows: CsvRow[],
  ): Promise<Map<string, string>> {
    const params: unknown[] = [orgId];
    const values = rows.map((row) => {
      const key = (row.external_id ?? '').trim();
      // Every row shares one namespace, so an empty key would make every such
      // row the same key and the unique index would silently keep one of them.
      if (!key) throw new Error('external_id is empty');

      const base = params.length;
      params.push(
        row.status,
        `${KEY_PREFIX}${key}`,
        row.created_at,
        row.updated_at,
      );
      // last_message_at reuses updated_at's placeholder rather than binding a
      // fifth parameter, so the arity stays at four and the 16,383-row ceiling
      // above is unchanged. See card 16.
      return `($1::bigint, $${base + 1}, $${base + 2}, $${base + 3}::timestamptz, $${base + 4}::timestamptz, $${base + 4}::timestamptz)`;
    });

    const { rows: landed } = await tx.query<{
      id: string;
      provider_event_id: string;
    }>(
      `INSERT INTO conversations (org_id, status, provider_event_id, created_at, updated_at, last_message_at)
       VALUES ${values.join(', ')}
       ON CONFLICT (org_id, provider_event_id) WHERE provider_event_id IS NOT NULL
         DO NOTHING
       RETURNING id, provider_event_id`,
      params,
    );

    return new Map(landed.map((row) => [row.provider_event_id, row.id]));
  }

  /** The messages half, for the rows that landed. Skipped entirely when the
   *  whole batch was a duplicate, which is the common case on a restart. */
  private async insertMessages(
    tx: TenantQuery,
    orgId: string,
    rows: CsvRow[],
    inserted: Map<string, string>,
  ): Promise<void> {
    const params: unknown[] = [orgId];
    const values: string[] = [];

    for (const row of rows) {
      const id = inserted.get(`${KEY_PREFIX}${row.external_id.trim()}`);
      if (!id) continue;
      const base = params.length;
      params.push(id, row.message);
      values.push(`($${base + 1}::uuid, $1::bigint, $${base + 2})`);
    }

    if (!values.length) return;

    await tx.query(
      `INSERT INTO messages (conversation_id, org_id, message)
       VALUES ${values.join(', ')}`,
      params,
    );
  }

  // ------------------------------------------------------------------ reads

  async list(orgId: string, limit = 20): Promise<ImportJob[]> {
    return this.tenants.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM import_jobs
          ORDER BY created_at DESC, id DESC
          LIMIT $1`,
        [limit],
      );
      return rows.map(toJob);
    });
  }

  /** No `org_id` filter, the same as drill 07's conversation endpoints: the
   *  policy is what scopes this, and removing the filter is how that stays
   *  provable. */
  async get(orgId: string, jobId: string): Promise<ImportJob | null> {
    return this.tenants.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<JobRow>(
        `SELECT ${JOB_COLUMNS} FROM import_jobs WHERE id = $1::uuid`,
        [jobId],
      );
      return rows[0] ? toJob(rows[0]) : null;
    });
  }

  private async mustGet(orgId: string, jobId: string): Promise<ImportJob> {
    const job = await this.get(orgId, jobId);
    if (!job) throw new NotFoundException('import job not found');
    return job;
  }

  /** Re-run a job whose file is still spooled. Answers 202 and works after. */
  async retry(orgId: string, jobId: string): Promise<ImportJob> {
    const job = await this.mustGet(orgId, jobId);
    if (job.status === 'running') return job;

    if (IMPORT === 'buffer') return this.run(orgId, jobId);

    this.detach(orgId, jobId);
    return { ...job, status: 'pending' };
  }

  /** Drops the spooled file. The job row stays — it is the record that the
   *  import happened, and a deleted row would take the audit with it. */
  async discard(orgId: string, jobId: string): Promise<void> {
    await this.mustGet(orgId, jobId);
    await rm(spoolPath(jobId), { force: true });
  }

  // ----------------------------------------------------------------- writes

  private async setStatus(
    orgId: string,
    jobId: string,
    status: ImportStatus,
    counters: Counters,
  ): Promise<void> {
    await this.tenants.withOrg(orgId, (tx) =>
      tx.query(
        `UPDATE import_jobs
            SET status = $2, error = NULL, updated_at = now(),
                started_at = now(), finished_at = NULL,
                rows_read = $3::bigint, rows_written = $4::bigint,
                rows_skipped = $5::bigint, resume_row = $6::bigint
          WHERE id = $1::uuid`,
        [
          jobId,
          status,
          counters.read,
          counters.written,
          counters.skipped,
          counters.committed,
        ],
      ),
    );
  }

  private async finish(
    orgId: string,
    jobId: string,
    status: ImportStatus,
    counters: Counters,
    peakRssBytes: number,
    error: string | null,
  ): Promise<ImportJob> {
    return this.tenants.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<JobRow>(
        `UPDATE import_jobs
            SET status = $2, error = $3, peak_rss_bytes = $4::bigint,
                rows_read = $5::bigint, rows_written = $6::bigint,
                rows_skipped = $7::bigint, resume_row = $8::bigint,
                finished_at = now(), updated_at = now()
          WHERE id = $1::uuid
        RETURNING ${JOB_COLUMNS}`,
        [
          jobId,
          status,
          error,
          peakRssBytes,
          counters.read,
          counters.written,
          counters.skipped,
          counters.committed,
        ],
      );
      return toJob(rows[0]);
    });
  }
}
