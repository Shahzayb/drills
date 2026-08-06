import { Controller, Get } from '@nestjs/common';
import { PostgresService } from '../postgres/postgres.service';

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
    };
  }
}
