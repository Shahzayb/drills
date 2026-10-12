import {
  BeforeApplicationShutdown,
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Server, ServerResponse } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { logger, since } from '../observability/logger';
import { PostgresService } from '../postgres/postgres.service';
import { RedisService } from '../redis/redis.service';

// Backstop only. Each client already has its own deadline (pool connection
// timeout, ioredis commandTimeout); this catches the case where a client hangs
// somewhere those don't cover, so /health can never outlive its own answer.
const PROBE_TIMEOUT_MS = 2000;

/** Card 23: what SIGTERM does. See plans/2026-10-11_drill-23-graceful-shutdown.md. */
export type ShutdownMode = 'exit' | 'nest' | 'graceful';

export const SHUTDOWN: ShutdownMode =
  process.env.SHUTDOWN === 'exit' || process.env.SHUTDOWN === 'nest'
    ? process.env.SHUTDOWN
    : 'graceful';

/** Readiness 503 while still serving. ≥ 1.5 × the measured SIGTERM→LB DOWN (1.93s max at inter 1s, fall 2). */
export const DRAIN_DELAY_MS = Number(process.env.DRAIN_DELAY_MS || 3000);

/** Signal to `process.exit(1)`. Delay 3s + 2 × the slowest request (4.67s whale stats), rounded up. Card 23. */
export const SHUTDOWN_TIMEOUT_MS = Number(
  process.env.SHUTDOWN_TIMEOUT_MS || 15_000,
);

/**
 * What readiness asks. `local`: this process's own phase only, never the pool or a dependency.
 * `deps`: the shipped check through the request pool, which took the last replica out under load.
 */
export type ReadinessMode = 'local' | 'deps';

export const READINESS: ReadinessMode =
  process.env.READINESS === 'deps' ? 'deps' : 'local';

/** Idle keep-alive. Above nginx's 60s upstream `keepalive_timeout`, so the proxy closes first. Node: 5s. */
export const KEEP_ALIVE_TIMEOUT_MS = Number(
  process.env.KEEP_ALIVE_TIMEOUT_MS || 65_000,
);

/** Logs an `event_loop` line per window when > 0. The window is 1s otherwise. */
export const EVENT_LOOP_LOG_MS = Number(process.env.EVENT_LOOP_LOG_MS || 0);

// The histogram records the time between timer ticks, so an idle loop reads ~this. Subtracted below.
const LAG_RESOLUTION_MS = 10;

export type Phase = 'serving' | 'draining' | 'closing' | 'closed';

export interface LagWindow {
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
}

export type CheckResult =
  { status: 'up'; latencyMs: number } | { status: 'down'; error: string };

export interface HealthReport {
  status: 'ok' | 'error' | 'draining';
  checks?: {
    postgres: CheckResult;
    redis: CheckResult;
  };
}

export interface LivenessReport {
  status: 'ok';
  phase: Phase;
  inFlight: number;
  eventLoop: LagWindow;
}

/**
 * Runs `probe` under a deadline and reports how long it took. Never throws —
 * a failed dependency is a result, not an exception.
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

const lagMs = (ns: number) =>
  Number(Math.max(0, ns / 1e6 - LAG_RESOLUTION_MS).toFixed(2));

@Injectable()
export class HealthService
  implements
    OnApplicationBootstrap,
    BeforeApplicationShutdown,
    OnApplicationShutdown
{
  private phase: Phase = 'serving';
  private server: Server | undefined;
  private readonly open = new Set<ServerResponse>();
  private readonly histogram = monitorEventLoopDelay({
    resolution: LAG_RESOLUTION_MS,
  });
  private lag: LagWindow = { p50Ms: 0, p99Ms: 0, maxMs: 0 };
  private readonly window: NodeJS.Timeout;

  constructor(
    private readonly postgres: PostgresService,
    private readonly redis: RedisService,
    private readonly adapterHost: HttpAdapterHost,
  ) {
    this.histogram.enable();
    this.window = setInterval(
      () => this.closeWindow(),
      EVENT_LOOP_LOG_MS || 1000,
    );
    this.window.unref();
  }

  /** Readiness. 503 while draining, so the LB takes this replica out before it closes. */
  async ready(): Promise<HealthReport> {
    if (this.phase !== 'serving') return { status: 'draining' };
    if (READINESS === 'deps') return this.deps();
    return { status: 'ok' };
  }

  /** Dependency report for people and alerts. Routing on it turns one slow query into an outage. */
  async deps(): Promise<HealthReport> {
    const [postgres, redis] = await Promise.all([
      measure(() => this.postgres.query('SELECT 1')),
      measure(() => this.redis.ping()),
    ]);

    const status =
      postgres.status === 'up' && redis.status === 'up' ? 'ok' : 'error';

    return { status, checks: { postgres, redis } };
  }

  /** Liveness. 200 through the drain: failing it would get the process killed mid-drain. */
  live(): LivenessReport {
    return {
      status: 'ok',
      phase: this.phase,
      inFlight: this.open.size,
      eventLoop: this.lag,
    };
  }

  snapshot(): { phase: Phase; inFlight: number } {
    return { phase: this.phase, inFlight: this.open.size };
  }

  // Prepended so it runs before Express: a request arriving while closing gets the header first.
  onApplicationBootstrap(): void {
    this.server = this.adapterHost.httpAdapter?.getHttpServer() as
      Server | undefined;
    if (this.server) {
      this.server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
      // Must outlast keepAliveTimeout, or a slow first request on a reused socket is cut off.
      this.server.headersTimeout = KEEP_ALIVE_TIMEOUT_MS + 1000;
    }
    this.server?.prependListener('request', (_request, response) => {
      this.open.add(response);
      if (this.phase === 'closing') response.setHeader('connection', 'close');
      response.once('close', () => this.open.delete(response));
    });
  }

  /** The drain. Nest closes the server, then the pool and Redis, only after this returns. */
  async beforeApplicationShutdown(signal?: string): Promise<void> {
    if (!signal) return;
    const startedAt = performance.now();
    logger.info(
      { signal, shutdown: SHUTDOWN, inFlight: this.open.size },
      'shutdown_started',
    );
    if (SHUTDOWN !== 'graceful') return;

    this.phase = 'draining';
    await sleep(DRAIN_DELAY_MS);

    this.phase = 'closing';
    logger.info(
      { inFlight: this.open.size, ms: since(startedAt) },
      'drain_listener_closed',
    );
    const server = this.server;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // close() alone keeps serving every keep-alive socket; this ends each one after its response.
        for (const response of this.open) {
          if (!response.headersSent) response.setHeader('connection', 'close');
        }
      });
    }

    this.phase = 'closed';
    logger.info({ ms: since(startedAt) }, 'drain_complete');
  }

  onApplicationShutdown(): void {
    clearInterval(this.window);
    this.histogram.disable();
  }

  private closeWindow(): void {
    this.lag = {
      p50Ms: lagMs(this.histogram.percentile(50)),
      p99Ms: lagMs(this.histogram.percentile(99)),
      maxMs: lagMs(this.histogram.max),
    };
    this.histogram.reset();
    if (EVENT_LOOP_LOG_MS > 0) {
      logger.info(
        { ...this.lag, phase: this.phase, inFlight: this.open.size },
        'event_loop',
      );
    }
  }
}
