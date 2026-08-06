import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { PG_POOL, REDIS_CLIENT } from '../database/database.constants';

const PROBE_TIMEOUT_MS = 2000;

export type CheckResult =
  { status: 'up'; latencyMs: number } | { status: 'down'; error: string };

export interface HealthReport {
  status: 'ok' | 'error';
  checks: {
    postgres: CheckResult;
    redis: CheckResult;
  };
}

/**
 * Runs `probe` under a deadline and reports how long it took. Never throws —
 * a failed dependency is a result, not an exception. The timeout is what makes
 * a down dependency fail fast, since ioredis keeps retrying in the background.
 */
async function measure(probe: () => Promise<unknown>): Promise<CheckResult> {
  const startedAt = Date.now();
  let timer: NodeJS.Timeout | undefined;

  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${PROBE_TIMEOUT_MS}ms`)),
          PROBE_TIMEOUT_MS,
        );
      }),
    ]);
    return { status: 'up', latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      status: 'down',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async check(): Promise<HealthReport> {
    const [postgres, redis] = await Promise.all([
      measure(() => this.pool.query('SELECT 1')),
      measure(() => this.redis.ping()),
    ]);

    const status =
      postgres.status === 'up' && redis.status === 'up' ? 'ok' : 'error';

    return { status, checks: { postgres, redis } };
  }
}
