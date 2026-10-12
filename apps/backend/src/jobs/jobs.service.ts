import {
  BeforeApplicationShutdown,
  Injectable,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { errorMessage, logger, since } from '../observability/logger';
import { PostgresService } from '../postgres/postgres.service';
import { RedisService } from '../redis/redis.service';

/**
 * Who runs the usage rollup when several replicas are up.
 *
 * - `off`     no loop.
 * - `all`     every process runs every slot. The single-instance assumption.
 * - `lease`   only the Redis lease holder runs. The last slot it ran lives in its memory.
 * - `fenced`  the lease, plus a `job_runs` claim committed with the rollup. Shipped.
 *
 * See plans/2026-10-12_drill-24-three-replicas.md.
 */
export type SchedulerMode = 'off' | 'all' | 'lease' | 'fenced';

const MODES: SchedulerMode[] = ['off', 'all', 'lease', 'fenced'];

export const SCHEDULER: SchedulerMode = MODES.includes(
  process.env.SCHEDULER as SchedulerMode,
)
  ? (process.env.SCHEDULER as SchedulerMode)
  : 'fenced';

/** How often the loop looks for a due slot. 0 starts no loop; `test:e2e` sets it. */
export const SCHEDULER_TICK_MS = Number(process.env.SCHEDULER_TICK_MS || 1000);

/** Slot length. 60s stands in for "nightly". */
export const JOB_SLOT_S = Number(process.env.JOB_SLOT_S || 60);

/** A slot is due this long after it ends, so ingest transactions that began inside it have committed. */
export const JOB_GRACE_S = Number(process.env.JOB_GRACE_S || 5);

export const LEASE_TTL_MS = Number(process.env.LEASE_TTL_MS || 10_000);

/** Instrument knob: a `pg_sleep` inside the job transaction, so a kill or pause lands mid-job. */
export const JOB_WORK_MS = Number(process.env.JOB_WORK_MS || 0);

export const JOB = 'usage-rollup';
export const LEASE_KEY = `lease:v1:job:${JOB}`;

/** How far back a new `fenced` leader looks for slots nobody finished. */
const CATCHUP_SLOTS = 10;

const slotMs = () => JOB_SLOT_S * 1000;

export type SlotResult = 'ran' | 'skipped' | 'blocked' | 'failed';

/** Per process, like every other /metrics counter. */
const counters = {
  runs: { ran: 0, skipped: 0, blocked: 0, failed: 0 } as Record<
    SlotResult,
    number
  >,
  leaseAcquired: 0,
  leaseLost: 0,
};

let leading = 0;

export function jobsMetrics(): string {
  return [
    '# HELP jobs_info The scheduler arm, slot and lease TTL.',
    '# TYPE jobs_info gauge',
    `jobs_info{scheduler="${SCHEDULER}",slot_seconds="${JOB_SLOT_S}",lease_ttl_ms="${LEASE_TTL_MS}"} 1`,
    '# HELP jobs_runs_total Rollup slots this process attempted, by outcome.',
    '# TYPE jobs_runs_total counter',
    ...Object.entries(counters.runs).map(
      ([result, n]) => `jobs_runs_total{result="${result}"} ${n}`,
    ),
    '# HELP jobs_lease_acquired_total Times this process took the lease.',
    '# TYPE jobs_lease_acquired_total counter',
    `jobs_lease_acquired_total ${counters.leaseAcquired}`,
    '# HELP jobs_lease_lost_total Times a renewal found the lease gone or taken.',
    '# TYPE jobs_lease_lost_total counter',
    `jobs_lease_lost_total ${counters.leaseLost}`,
    '# HELP jobs_leader 1 while this process holds the lease.',
    '# TYPE jobs_leader gauge',
    `jobs_leader ${leading}`,
    '',
  ].join('\n');
}

@Injectable()
export class JobsService
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  /** Unique per process, and per app when a test boots three in one process. */
  readonly holder = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  /** The lease's term while held, 0 otherwise. */
  private term = 0;
  /** `all` and `lease` only: the progress record that dies with the process. */
  private lastSlot: number | undefined;
  private timers: NodeJS.Timeout[] = [];
  private running: Promise<unknown> = Promise.resolve();
  private busy = false;

  constructor(
    private readonly postgres: PostgresService,
    private readonly redis: RedisService,
  ) {}

  onApplicationBootstrap(): void {
    if (SCHEDULER === 'off' || SCHEDULER_TICK_MS <= 0) return;
    if (SCHEDULER !== 'all') {
      this.every(LEASE_TTL_MS / 3, () => this.lead());
    }
    this.every(SCHEDULER_TICK_MS, () => this.tick());
    logger.info(
      { scheduler: SCHEDULER, holder: this.holder, slotS: JOB_SLOT_S },
      'scheduler_started',
    );
  }

  /** Stops the loop, lets a running slot finish, then hands the lease back so failover is immediate. */
  async beforeApplicationShutdown(): Promise<void> {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    await this.running.catch(() => undefined);
    if (!this.term) return;
    await this.redis.delIfEquals(LEASE_KEY, this.holder).catch(() => undefined);
    logger.info({ holder: this.holder, term: this.term }, 'leader_released');
    this.setTerm(0);
  }

  /** Renews a held lease or tries for a free one. A Redis error steps down: fail closed. */
  async lead(): Promise<boolean> {
    try {
      if (this.term) {
        if (await this.redis.renewLease(LEASE_KEY, this.holder, LEASE_TTL_MS))
          return true;
        counters.leaseLost += 1;
        logger.warn({ holder: this.holder, term: this.term }, 'leader_lost');
        this.setTerm(0);
        return false;
      }
      const term = await this.redis.acquireLease(
        LEASE_KEY,
        this.holder,
        LEASE_TTL_MS,
      );
      if (!term) return false;
      counters.leaseAcquired += 1;
      this.setTerm(term);
      logger.info({ holder: this.holder, term }, 'leader_acquired');
      return true;
    } catch (error) {
      if (this.term) {
        logger.warn(
          { holder: this.holder, term: this.term, err: errorMessage(error) },
          'leader_lost',
        );
        counters.leaseLost += 1;
        this.setTerm(0);
      }
      return false;
    }
  }

  /** Runs every due slot this process is responsible for. `now` is injectable so tests pin a slot. */
  async tick(now = Date.now()): Promise<SlotResult[]> {
    if (SCHEDULER === 'off' || this.busy) return [];
    this.busy = true;
    const run = this.dueAndRun(now);
    this.running = run;
    try {
      return await run;
    } finally {
      this.busy = false;
    }
  }

  /**
   * One slot in one transaction. On `fenced` the claim is the first statement, so a second runner
   * waits on it and then finds it taken; a killed runner's claim rolls back with its work.
   */
  async runSlot(slot: number, workMs = JOB_WORK_MS): Promise<SlotResult> {
    const startedAt = performance.now();
    const start = new Date(slot);
    const term = this.term;
    const fields = { slot: start.toISOString(), holder: this.holder, term };

    try {
      return await this.postgres.withClient(async (client) => {
        await client.control('BEGIN');
        try {
          await client.control(`SET LOCAL lock_timeout = '5s'`);
          // Bounds how long a paused holder's open claim can block the next leader.
          await client.control(
            `SET LOCAL idle_in_transaction_session_timeout = '30s'`,
          );
          // Names the runner in pg_stat_activity for this transaction only.
          await client.control(
            `SELECT set_config('application_name', $1, true)`,
            [`job:${this.holder}`],
          );

          if (SCHEDULER === 'fenced') {
            const claim = await client.query(
              `INSERT INTO job_runs (job, slot_start, holder, term)
               VALUES ($1, $2, $3, $4)
               ON CONFLICT DO NOTHING RETURNING 1`,
              [JOB, start, this.holder, term],
            );
            if (!claim.rowCount) {
              await client.control('ROLLBACK');
              counters.runs.skipped += 1;
              logger.info(fields, 'job_slot_taken');
              return 'skipped';
            }
          }

          const { rows } = await client.query<{ rows: number }>(
            `SELECT app_rollup_usage($1, $2, $3, $4) AS rows`,
            [start, new Date(slot + slotMs()), this.holder, term],
          );
          if (workMs > 0) {
            await client.query(`SELECT pg_sleep($1)`, [workMs / 1000]);
          }
          if (SCHEDULER === 'fenced') {
            await client.query(
              `UPDATE job_runs SET rows = $3, finished_at = now()
                WHERE job = $1 AND slot_start = $2`,
              [JOB, start, rows[0].rows],
            );
          }
          await client.control('COMMIT');

          counters.runs.ran += 1;
          logger.info(
            { ...fields, rows: rows[0].rows, ms: since(startedAt) },
            'job_ran',
          );
          return 'ran';
        } catch (error) {
          await client.control('ROLLBACK').catch(() => undefined);
          throw error;
        }
      });
    } catch (error) {
      // 55P03: the claim waited out lock_timeout behind another runner's open transaction.
      const blocked = (error as { code?: string }).code === '55P03';
      counters.runs[blocked ? 'blocked' : 'failed'] += 1;
      logger.warn(
        { ...fields, err: errorMessage(error), ms: since(startedAt) },
        blocked ? 'job_claim_blocked' : 'job_failed',
      );
      return blocked ? 'blocked' : 'failed';
    }
  }

  private async dueAndRun(now: number): Promise<SlotResult[]> {
    if (SCHEDULER !== 'all' && !this.term && !(await this.lead())) return [];

    // The newest slot whose end plus the grace has passed.
    const latest =
      Math.floor((now - JOB_GRACE_S * 1000) / slotMs()) * slotMs() - slotMs();

    if (SCHEDULER !== 'fenced') {
      if (this.lastSlot === latest) return [];
      const result = await this.runSlot(latest);
      if (result === 'ran') this.lastSlot = latest;
      return [result];
    }

    const { rows } = await this.postgres.query<{ slot: Date }>(
      `SELECT s AS slot
         FROM generate_series($1::timestamptz, $2::timestamptz, $3::interval) s
        WHERE NOT EXISTS (SELECT 1 FROM job_runs WHERE job = $4 AND slot_start = s)
        ORDER BY s`,
      [
        new Date(latest - (CATCHUP_SLOTS - 1) * slotMs()),
        new Date(latest),
        `${JOB_SLOT_S} seconds`,
        JOB,
      ],
    );
    const results: SlotResult[] = [];
    for (const { slot } of rows) {
      const result = await this.runSlot(slot.getTime());
      results.push(result);
      if (result === 'blocked' || result === 'failed') break;
    }
    return results;
  }

  private every(ms: number, fn: () => Promise<unknown>): void {
    const timer = setInterval(() => {
      fn().catch((error: unknown) =>
        logger.error({ err: errorMessage(error) }, 'scheduler_tick_failed'),
      );
    }, ms);
    timer.unref();
    this.timers.push(timer);
  }

  private setTerm(term: number): void {
    this.term = term;
    leading = term ? 1 : 0;
  }
}
