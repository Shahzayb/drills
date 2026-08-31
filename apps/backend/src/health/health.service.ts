import { Injectable } from '@nestjs/common';
import { PostgresService } from '../postgres/postgres.service';
import { RedisService } from '../redis/redis.service';

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
    private readonly postgres: PostgresService,
    private readonly redis: RedisService,
  ) {}

  async check(): Promise<HealthReport> {
    const [postgres, redis] = await Promise.all([
      measure(() => this.postgres.query('SELECT 1')),
      measure(() => this.redis.ping()),
    ]);

    const status =
      postgres.status === 'up' && redis.status === 'up' ? 'ok' : 'error';

    return { status, checks: { postgres, redis } };
  }
}
