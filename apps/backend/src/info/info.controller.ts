import { Controller, Get } from '@nestjs/common';
import { PostgresService } from '../postgres/postgres.service';
import {
  KEYSET_TIEBREAK,
  LIST_STRATEGY,
} from '../conversations/conversations.service';
import { SEARCH_STRATEGY } from '../search/search.service';
import { QUERY_COUNTER_MODE } from '../observability/query-counter';
import { TRACING_ENABLED } from '../observability/trace';
import { logger } from '../observability/logger';

interface InfoRow {
  version: string;
  server_time: Date;
}

export interface InfoResponse {
  postgres: {
    version: string;
    serverTime: string;
    poolStats: ReturnType<PostgresService['stats']>;
  };
  arms: {
    listStrategy: string;
    keysetTiebreak: string;
    searchStrategy: string;
    queryCounter: string;
    logLevel: string;
    tracing: string;
  };
}

/**
 * The value the web app displays. Deliberately a real read through the pool
 * rather than a constant — if this renders, the whole path is proven:
 * browser -> Next server -> nest_server by service name -> pool -> Postgres.
 */
@Controller('info')
export class InfoController {
  constructor(private readonly postgres: PostgresService) {}

  @Get()
  async getInfo(): Promise<InfoResponse> {
    const { rows } = await this.postgres.query<InfoRow>(
      'SELECT version() AS version, now() AS server_time',
    );

    return {
      postgres: {
        version: rows[0].version,
        serverTime: rows[0].server_time.toISOString(),
        poolStats: this.postgres.stats(),
      },
      // Every value here is the resolved module constant the request path
      // branches on, imported rather than re-read from process.env. A second
      // read would agree with the shell while the running code disagreed, which
      // is exactly the failure this reports (drill 10). `pnpm arms` prints it.
      // Local-only affordance: a real service should not publish its flag state
      // unauthenticated. See plans/2026-08-30_instrument-hardening.md.
      arms: {
        listStrategy: LIST_STRATEGY,
        keysetTiebreak: KEYSET_TIEBREAK,
        searchStrategy: SEARCH_STRATEGY,
        queryCounter: QUERY_COUNTER_MODE,
        logLevel: logger.level,
        tracing: TRACING_ENABLED ? 'on' : 'off',
      },
    };
  }
}
