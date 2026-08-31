import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { errorMessage, logger, since } from '../observability/logger';
import {
  getRequestId,
  recordQuery,
  recordRoundTrip,
} from '../observability/request-context';
import { TRACING_ENABLED } from '../observability/trace';

const POOL_MAX = 10;
const CONNECTION_TIMEOUT_MS = 2000;
const IDLE_TIMEOUT_MS = 30_000;
const SLOW_QUERY_MS = 200;
const SQL_LOG_MAX = 200;

const summarise = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > SQL_LOG_MAX ? `${flat.slice(0, SQL_LOG_MAX)}…` : flat;
};

export interface ClientHandle {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
  control(text: string, params?: unknown[]): Promise<void>;
}

@Injectable()
export class PostgresService implements OnApplicationShutdown {
  private readonly pool: Pool;
  private readonly logger = logger;

  constructor() {
    const user = process.env.POSTGRES_APP_USER;
    const password = process.env.POSTGRES_APP_PASSWORD;

    if (!user || !password) {
      throw new Error(
        'POSTGRES_APP_USER and POSTGRES_APP_PASSWORD are required — ' +
          'the API must not serve as the database owner. See ' +
          'plans/2026-08-15_drill-07-tenant-isolation.md',
      );
    }

    this.pool = new Pool({
      host: process.env.POSTGRES_HOST ?? 'localhost',
      port: Number(process.env.POSTGRES_PORT ?? 5432),
      user,
      password,
      database: process.env.POSTGRES_DB ?? 'postgres',
      max: POOL_MAX,
      connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: IDLE_TIMEOUT_MS,
    });

    this.pool.on('error', (error: Error) => {
      this.logger.warn({ err: error.message }, 'pool_idle_client_error');
    });
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.runOn(this.pool, text, params);
  }

  async withClient<T>(fn: (client: ClientHandle) => Promise<T>): Promise<T> {
    const client: PoolClient = await this.pool.connect();

    const handle: ClientHandle = {
      query: (text, params) => this.runOn(client, text, params),
      control: async (text, params) => {
        recordRoundTrip();
        await client.query(text, params as unknown[]);
      },
    };

    try {
      return await fn(handle);
    } finally {
      client.release();
    }
  }

  private async runOn<T extends QueryResultRow = QueryResultRow>(
    executor: Pool | PoolClient,
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>> {
    const rid = getRequestId();
    recordQuery();

    const sql = rid && !TRACING_ENABLED ? `${text} /* rid=${rid} */` : text;

    const startedAt = performance.now();

    try {
      const result = await executor.query<T>(sql, params);
      this.record(rid, startedAt, text, result.rowCount, null);
      return result;
    } catch (error) {
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

    if (this.logger.isLevelEnabled('debug')) {
      this.logger.debug({ rid, durMs, rows, sql: summarise(text) }, 'db_query');
    }
    if (durMs >= SLOW_QUERY_MS) {
      this.logger.warn({ rid, durMs, sql: summarise(text) }, 'slow_query');
    }
  }

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
