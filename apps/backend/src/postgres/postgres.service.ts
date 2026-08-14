import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Pool, QueryResult, QueryResultRow } from 'pg';
import { errorMessage, logger, since } from '../observability/logger';
import { getRequestId } from '../observability/request-context';
import { TRACING_ENABLED } from '../observability/trace';

// Every number here is chosen, not inherited. Reasoning lives in
// plans/2026-08-06_drill-01-health-endpoint.md under "Numbers we chose".
//
// Postgres reports max_connections=100 with 3 reserved for superusers, leaving
// 97. At 10 per API container that is room for ~9 replicas before the database
// is the thing that says no — plus headroom for psql sessions during drills.
const POOL_MAX = 10;
// Long enough to survive a GC pause, short enough that /health answers inside
// its own 2s probe budget instead of hanging.
const CONNECTION_TIMEOUT_MS = 2000;
// pg defaults this to 10s. 30s keeps connections warm between the sparse
// requests a dev stack sees, without holding them open indefinitely.
const IDLE_TIMEOUT_MS = 30_000;
// Not a limit, just the line above which a query gets noticed.
const SLOW_QUERY_MS = 200;
// Long enough to tell two queries apart, short enough that a log line stays one
// line. The full text is recoverable from the source; this is for recognising.
const SQL_LOG_MAX = 200;

/** One line, no runs of whitespace, bounded. */
const summarise = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SQL_LOG_MAX ? `${flat.slice(0, SQL_LOG_MAX)}…` : flat;
};

/**
 * Owns the connection pool. Every read goes through `query()` — that is the
 * point of this class, not an accident of style. Handing out the raw `Pool`
 * would mean later drills (timing, tracing, pool saturation) have nowhere
 * central to hook into.
 */
@Injectable()
export class PostgresService implements OnApplicationShutdown {
  private readonly pool: Pool;
  // Imported, not injected — see observability/logger.ts. Keeping this out of
  // the constructor is what lets schema.e2e-spec.ts boot PostgresModule alone.
  private readonly logger = logger;

  constructor() {
    this.pool = new Pool({
      host: process.env.POSTGRES_HOST ?? 'localhost',
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user: process.env.POSTGRES_USER ?? 'postgres',
      password: process.env.POSTGRES_PASSWORD ?? 'postgres',
      database: process.env.POSTGRES_DB ?? 'postgres',
      max: POOL_MAX,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
    });

    // A pool emits 'error' for *idle* clients that die out from under it, which
    // is what happens the moment Postgres restarts. Node exits on an unhandled
    // 'error' event, so without this the process dies whenever the database
    // bounces instead of reporting itself unhealthy.
    this.pool.on('error', (error: Error) => {
      this.logger.warn({ err: error.message }, 'pool_idle_client_error');
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    const rid = getRequestId();

    // The id rides inside the statement — the only channel that reaches
    // Postgres's own log and pg_stat_activity without pinning a connection.
    // Interpolating into SQL is safe *only* because deriveRequestId allowlists
    // the character set. See the plan file.
    //
    // Skipped when tracing is on, because the two mechanisms cancel: the
    // sqlcommenter spec forbids adding a comment to a statement that has one,
    // so this line silently disables instrumentation-pg's traceparent — which
    // identifies the *span*, not just the request. The standard wins where they
    // overlap; `trace_id` on every log line is how one grep still reaches
    // Postgres.
    //
    // Trailing, not leading: instrumentation-pg names its span from the first
    // whitespace-delimited token, so a leading comment renamed every query span
    // to `pg.query:/*`. Assumes `text` does not end in `;` — none here do.
    // Both found by reading spans; see the plan file's "Revised while shipping".
    const sql = rid && !TRACING_ENABLED ? `${text} /* rid=${rid} */` : text;

    const startedAt = performance.now();

    try {
      const result = await this.pool.query<T>(sql, params);
      this.record(rid, startedAt, text, result.rowCount, null);
      return result;
    } catch (error) {
      // A failed query gets its own event. Reporting it as a db_query with
      // rows: null would read as an empty result set on exactly the request
      // worth reconstructing.
      this.record(rid, startedAt, text, null, error);
      throw error;
    }
  }

  private record(
    rid: string | undefined,
    startedAt: number,
    text: string,
    rows: number | null,
    error: unknown,
  ): void {
    const durMs = since(startedAt);

    if (error) {
      this.logger.error(
        {
          rid,
          durMs,
          sql: summarise(text),
          err: errorMessage(error),
        },
        'db_query_failed',
      );
      return;
    }

    // Guarded, not just called: a logger call below the active level still
    // evaluates its arguments, so summarise() would run a regex over every
    // statement only to have the line discarded. Worth ~5-6% of tail-org
    // throughput — measured in the plan file.
    if (this.logger.isLevelEnabled('debug')) {
      this.logger.debug({ rid, durMs, rows, sql: summarise(text) }, 'db_query');
    }
    if (durMs >= SLOW_QUERY_MS) {
      // Stays at warn so it survives the default level, which is the whole
      // reason a threshold exists.
      this.logger.warn({ rid, durMs, sql: summarise(text) }, 'slow_query');
    }
  }

  /** Pool saturation is the thing later drills will want to watch. */
  stats(): { total: number; idle: number; waiting: number; max: number } {
    return {
      total: this.pool.totalCount,
      idle: this.pool.idleCount,
      waiting: this.pool.waitingCount,
      max: POOL_MAX,
    };
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.pool.end();
    } catch (error) {
      this.logger.warn({ err: errorMessage(error) }, 'pool_close_failed');
    }
  }
}
