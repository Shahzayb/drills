import { Injectable } from '@nestjs/common';
import { QueryResult, QueryResultRow } from 'pg';
import { logger, since } from '../observability/logger';
import { getRequestId } from '../observability/request-context';
import { PostgresService } from '../postgres/postgres.service';

export const ORG_SETTING = 'app.org_id';

export interface TenantQuery {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

@Injectable()
export class TenantDb {
  private readonly logger = logger;

  constructor(private readonly postgres: PostgresService) {}

  async withOrg<T>(
    orgId: string,
    fn: (tx: TenantQuery) => Promise<T>,
  ): Promise<T> {
    const startedAt = performance.now();

    return this.postgres.withClient(async (client) => {
      await client.control('BEGIN');

      try {
        await client.control(`SELECT set_config($1, $2, true)`, [
          ORG_SETTING,
          orgId,
        ]);

        if (this.logger.isLevelEnabled('debug')) {
          this.logger.debug(
            { rid: getRequestId(), orgId, durMs: since(startedAt) },
            'tenant_scope',
          );
        }

        const scoped: TenantQuery = {
          query: <T extends QueryResultRow = QueryResultRow>(
            text: string,
            params?: unknown[],
          ) => client.query<T>(text, params),
        };

        const result = await fn(scoped);

        await client.control('COMMIT');
        return result;
      } catch (error) {
        await client.control('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }
}
