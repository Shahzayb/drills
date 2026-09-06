import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { QueryResult, QueryResultRow } from 'pg';
import { logger, since } from '../observability/logger';
import { getRequestId, recordRetry } from '../observability/request-context';
import { ClientHandle, PostgresService } from '../postgres/postgres.service';

/** The name of the session setting the policies read. Must contain a dot — a
 *  custom GUC without one is rejected by Postgres. */
export const ORG_SETTING = 'app.org_id';

/**
 * What a scoped callback is allowed to do: run statements, nothing else. No
 * `BEGIN`, no `COMMIT`, no way to change the org half way through.
 */
export interface TenantQuery {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

/**
 * How many times a transaction may restart before the caller gets a 503.
 *
 * Card 13's `QUOTA=serializable` arm is the only thing that reaches this today.
 * It is a knob rather than a constant because the right number is a property of
 * the contention, not of the code: on one hot counter row every retry
 * re-conflicts, so a generous cap converts a serialization failure into a long
 * tail instead of a fast error, and which of those you want is a decision.
 */
export const QUOTA_MAX_RETRIES = Number(process.env.QUOTA_MAX_RETRIES || '5');

/** Postgres tells you to try again with exactly these two. 40001 is a
 *  serialization failure, 40P01 a deadlock; both mean "nothing you did was
 *  wrong, run it again". Anything else is a real error and is rethrown. */
const RETRYABLE = new Set(['40001', '40P01']);

const isRetryable = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  RETRYABLE.has(String((error as { code?: string }).code));

/** What a caller may change about the transaction wrapping its statements. */
export interface ScopeOptions {
  /**
   * `BEGIN ISOLATION LEVEL <this>` instead of a plain `BEGIN`. Omitted means
   * the server default, which this stack leaves at READ COMMITTED.
   */
  isolation?: 'REPEATABLE READ' | 'SERIALIZABLE';
  /** Restarts allowed on 40001/40P01. Zero means "fail on the first one". */
  retries?: number;
}

/**
 * The only way to run a statement with a tenant context attached.
 *
 * What this is NOT: the thing that guarantees isolation. The guarantee is the
 * row-level security policies in migration 003 — they hold for code that never
 * came through here at all, which is the only way "unwritable" means anything.
 * This class is how the policies learn *which* tenant, and it is the ergonomic
 * half of the pair. See plans/2026-08-15_drill-07-tenant-isolation.md for why
 * a seam like this was rejected as the mechanism on its own.
 */
@Injectable()
export class TenantDb {
  private readonly logger = logger;

  constructor(private readonly postgres: PostgresService) {}

  /**
   * Runs `fn` with `app.org_id` set for the duration of one transaction, on one
   * pinned connection, and commits — or rolls back and rethrows.
   *
   * `options.isolation` raises the level for that transaction and
   * `options.retries` restarts it on 40001/40P01. Both default to off, so every
   * caller written before card 13 behaves exactly as it did. See
   * plans/2026-09-07_drill-13-lost-update.md.
   *
   * Three things here are load-bearing:
   *
   * 1. **The `BEGIN` is not ceremony.** `set_config(..., is_local => true)`
   *    applies to the current transaction, and outside an explicit one that is
   *    the implicit single-statement transaction wrapping the `SELECT` itself.
   *    Drop the `BEGIN` and the setting evaporates before the next statement,
   *    every policy predicate goes NULL, and everything returns zero rows. That
   *    is the good failure — loud, immediate, and impossible to ship.
   *
   * 2. **`is_local => true`, not a session-level `SET`.** `pg` hands the same
   *    connection to the next request and `pg-pool` has no reliable reset hook,
   *    so a session-level setting outlives the request that set it. That is a
   *    cross-tenant leak that only appears under concurrency — strictly worse
   *    than the bug this drill is fixing. A transaction-local setting cannot
   *    outlive its transaction even if this code throws.
   *
   * 3. **One connection, not two.** `pool.query()` acquires and releases per
   *    call, which is why drill 05 measured `GET /conversations` wanting two of
   *    the pool's ten. Inside here the two queries share one client and
   *    therefore serialise. That is a real cost and it is measured in the plan
   *    file rather than assumed away.
   */
  async withOrg<T>(
    orgId: string,
    fn: (tx: TenantQuery) => Promise<T>,
    { isolation, retries = 0 }: ScopeOptions = {},
  ): Promise<T> {
    const startedAt = performance.now();
    const begin = isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN';

    return this.postgres.withClient(async (client) => {
      // The retry loop is INSIDE withClient, so a restart reuses the same
      // pinned connection rather than going back to a pool that may be
      // saturated by the very contention that caused the failure.
      //
      // It restarts the WHOLE callback, which is only safe because every
      // statement inside it is idempotent — drill 12's ON CONFLICT is what
      // pays for this. Without it a retry would insert a second conversation.
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.attempt(client, orgId, begin, fn, startedAt);
        } catch (error) {
          if (!isRetryable(error)) throw error;

          if (attempt >= retries) {
            // 503, not 500. Nothing is wrong with the request and it is worth
            // sending again — which is what the status code is for, and it
            // keeps the instruments' `5xx == 0` assertions meaningful about
            // real failures.
            this.logger.warn(
              {
                rid: getRequestId(),
                orgId,
                attempts: attempt + 1,
                code: (error as { code?: string }).code,
              },
              'serialization_failure_exhausted',
            );
            throw new ServiceUnavailableException(
              'concurrent update, please retry',
            );
          }

          recordRetry();

          // Jittered, and the jitter is the point: a hundred retriers that all
          // wake at the same millisecond re-collide as a herd. Full jitter over
          // an exponential window, capped — 1, 2, 4, 8, 16ms.
          const ceiling = Math.min(16, 1 << attempt);
          await new Promise((r) => setTimeout(r, Math.random() * ceiling));
        }
      }
    });
  }

  /** One attempt: BEGIN, scope, run, COMMIT — or ROLLBACK and rethrow. */
  private async attempt<T>(
    client: ClientHandle,
    orgId: string,
    begin: string,
    fn: (tx: TenantQuery) => Promise<T>,
    startedAt: number,
  ): Promise<T> {
    await client.control(begin);

    try {
      // A bind parameter, not interpolation. The @OrgId decorator already
      // allowlists this to digits, but a scoping mechanism that depends on a
      // validator three layers away is one refactor from being an injection.
      await client.control(`SELECT set_config($1, $2, true)`, [
        ORG_SETTING,
        orgId,
      ]);

      // One event for the scope, not three db_query lines. Drill 06's output
      // is already one line per query; tripling it would make `logs:trace`
      // unreadable for a two-query request.
      if (this.logger.isLevelEnabled('debug')) {
        this.logger.debug(
          { rid: getRequestId(), orgId, durMs: since(startedAt) },
          'tenant_scope',
        );
      }

      // Wrapped rather than passed as `{ query: client.query }`: handing out
      // a bare method detaches it from its receiver, which ESLint's
      // unbound-method rule flags and which would break the moment
      // ClientHandle stops being a closure over one client.
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
      // Best-effort: if the connection is already gone, ROLLBACK fails too,
      // and the original error is the one worth reporting.
      await client.control('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
}
