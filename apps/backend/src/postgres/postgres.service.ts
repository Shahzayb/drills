import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { Pool, QueryResult, QueryResultRow } from 'pg';

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

/**
 * Owns the connection pool. Every read goes through `query()` — that is the
 * point of this class, not an accident of style. Handing out the raw `Pool`
 * would mean later drills (timing, tracing, pool saturation) have nowhere
 * central to hook into.
 */
@Injectable()
export class PostgresService implements OnApplicationShutdown {
  private readonly logger = new Logger(PostgresService.name);
  private readonly pool: Pool;

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
      this.logger.warn(`Idle client error: ${error.message}`);
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    const startedAt = Date.now();
    try {
      return await this.pool.query<T>(text, params);
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= SLOW_QUERY_MS) {
        this.logger.warn(`Slow query (${elapsed}ms): ${text}`);
      }
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
      this.logger.warn(`Closing the pool failed: ${String(error)}`);
    }
  }
}
