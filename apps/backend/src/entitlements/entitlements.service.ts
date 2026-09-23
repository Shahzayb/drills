import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { errorMessage, logger } from '../observability/logger';
import { PostgresService } from '../postgres/postgres.service';
import { RedisService } from '../redis/redis.service';

/**
 * Where an org's entitlements come from on each request.
 *
 * - `off`         Postgres, every request. The before arm.
 * - `ttl`         Redis cache-aside with a TTL and nothing else. A plan change waits out the TTL.
 * - `invalidate`  `ttl` plus a DEL after the plan-change commit.
 * - `notify`      `invalidate` plus a Postgres trigger that reaches writes made outside the API. Shipped.
 *
 * See plans/2026-09-23_drill-19-entitlement-cache.md.
 */
export type EntitlementCacheMode = 'off' | 'ttl' | 'invalidate' | 'notify';

const MODES: EntitlementCacheMode[] = ['off', 'ttl', 'invalidate', 'notify'];

export const ENTITLEMENT_CACHE: EntitlementCacheMode = MODES.includes(
  process.env.ENTITLEMENT_CACHE as EntitlementCacheMode,
)
  ? (process.env.ENTITLEMENT_CACHE as EntitlementCacheMode)
  : 'notify';

/** The worst-case staleness for a write the cache is never told about. */
export const ENTITLEMENT_TTL_S = Number(process.env.ENTITLEMENT_TTL_S || '30');

export const PLANS = ['free', 'basic', 'pro'] as const;
export type Plan = (typeof PLANS)[number];

/** The rate-limit window. Fixed, anchored at the first request in it. */
export const INGEST_WINDOW_S = 60;

export const ENTITLEMENT_HEADER = 'x-entitlement';

export const NOTIFY_CHANNEL = 'entitlements';

/** Where the interceptor parks the resolved entitlements for the controller. */
export const ENTITLEMENTS = Symbol('entitlements');

export interface Entitlements {
  /** Null when no such org exists. Cached too, so a bogus id costs one read per TTL. */
  plan: Plan | null;
  /** Null means unlimited. */
  ingestPerMinute: number | null;
  /** When Postgres answered, epoch ms. A hit's age is `now - loadedAt`. */
  loadedAt: number;
}

export type LookupSource = 'hit' | 'miss' | 'db' | 'error';

export interface Resolved {
  entitlements: Entitlements;
  source: LookupSource;
}

export interface WindowUse {
  limit: number;
  count: number;
  resetMs: number;
}

/** `v1` versions the value's shape: a deploy that changes it reads a new key, never an old shape. */
export const entitlementKey = (orgId: string) => `ent:v1:org:${orgId}`;

const ingestWindowKey = (orgId: string) => `rl:v1:ingest:org:${orgId}`;

/** Per process. Prometheus sums replicas; a ratio is a rate() of these, not a stored number. */
const counters = {
  lookups: { hit: 0, miss: 0, db: 0, error: 0 } as Record<LookupSource, number>,
  invalidations: { api: 0, notify: 0 },
  invalidationErrors: 0,
  listenerConnects: 0,
  rateLimited: 0,
  rateLimitErrors: 0,
};

@Injectable()
export class EntitlementsService implements OnModuleInit {
  constructor(
    private readonly postgres: PostgresService,
    private readonly redis: RedisService,
  ) {}

  /** `notify` only: migration 1790121900000's trigger names the org, this DELs its key. */
  onModuleInit(): void {
    if (ENTITLEMENT_CACHE !== 'notify') return;
    this.postgres.listen(
      NOTIFY_CHANNEL,
      (orgId) => void this.invalidate(orgId, 'notify'),
      () => (counters.listenerConnects += 1),
    );
  }

  async resolve(orgId: string): Promise<Resolved> {
    if (ENTITLEMENT_CACHE === 'off') {
      return this.counted('db', await this.load(orgId));
    }

    const key = entitlementKey(orgId);
    let cached: string | null;
    try {
      cached = await this.redis.get(key);
    } catch (error) {
      // A cache that is down degrades to the source of truth, never to a 500.
      logger.warn({ err: errorMessage(error) }, 'entitlement_cache_error');
      return this.counted('error', await this.load(orgId));
    }

    if (cached) return this.counted('hit', JSON.parse(cached) as Entitlements);

    const fresh = await this.load(orgId);
    await this.redis
      .set(key, JSON.stringify(fresh), ENTITLEMENT_TTL_S)
      .catch(() => undefined);
    return this.counted('miss', fresh);
  }

  /** Uncounted: `@QueryBudget` is a per-route contract and this read is on every route. */
  async load(orgId: string): Promise<Entitlements> {
    const { rows } = await this.postgres.query<{
      plan: Plan;
      ingest_per_minute: number | null;
    }>(
      `SELECT o.plan, l.ingest_per_minute
         FROM organizations o JOIN plan_limits l USING (plan)
        WHERE o.id = $1::bigint`,
      [orgId],
      { counted: false },
    );

    return {
      plan: rows[0]?.plan ?? null,
      ingestPerMinute: rows[0]?.ingest_per_minute ?? null,
      loadedAt: Date.now(),
    };
  }

  /** Commit first, then DEL. A DEL before the commit lets a concurrent reader refill the old plan. */
  async setPlan(orgId: string, plan: Plan): Promise<Entitlements> {
    const { rowCount } = await this.postgres.query(
      `UPDATE organizations SET plan = $2, updated_at = now() WHERE id = $1::bigint`,
      [orgId, plan],
    );
    if (!rowCount) throw new NotFoundException(`org ${orgId} not found`);

    if (ENTITLEMENT_CACHE === 'invalidate' || ENTITLEMENT_CACHE === 'notify') {
      await this.invalidate(orgId, 'api');
    }

    return this.load(orgId);
  }

  /** A failed DEL leaves the old plan in place for up to the TTL. Logged, not thrown: the write landed. */
  async invalidate(orgId: string, source: 'api' | 'notify'): Promise<void> {
    try {
      await this.redis.del(entitlementKey(orgId));
      counters.invalidations[source] += 1;
    } catch (error) {
      counters.invalidationErrors += 1;
      logger.error(
        { orgId, source, err: errorMessage(error) },
        'entitlement_invalidate_failed',
      );
    }
  }

  /** Null when the plan is unlimited or Redis failed (fail open). Otherwise the window after this hit. */
  async consumeIngest(
    orgId: string,
    entitlements: Entitlements,
  ): Promise<WindowUse | null> {
    const limit = entitlements.ingestPerMinute;
    if (limit === null) return null;

    try {
      const { count, pttlMs } = await this.redis.incrWindow(
        ingestWindowKey(orgId),
        INGEST_WINDOW_S,
      );
      if (count > limit) counters.rateLimited += 1;
      return { limit, count, resetMs: pttlMs };
    } catch (error) {
      counters.rateLimitErrors += 1;
      logger.warn({ err: errorMessage(error) }, 'rate_limit_failed_open');
      return null;
    }
  }

  metrics(): string {
    const { lookups, invalidations } = counters;
    return [
      '# HELP entitlement_cache_info The running arm and TTL.',
      '# TYPE entitlement_cache_info gauge',
      `entitlement_cache_info{mode="${ENTITLEMENT_CACHE}",ttl_seconds="${ENTITLEMENT_TTL_S}"} 1`,
      '# HELP entitlement_lookups_total Entitlement lookups by where the answer came from.',
      '# TYPE entitlement_lookups_total counter',
      ...Object.entries(lookups).map(
        ([result, n]) => `entitlement_lookups_total{result="${result}"} ${n}`,
      ),
      '# HELP entitlement_invalidations_total Cache keys deleted, by what triggered the delete.',
      '# TYPE entitlement_invalidations_total counter',
      ...Object.entries(invalidations).map(
        ([source, n]) =>
          `entitlement_invalidations_total{source="${source}"} ${n}`,
      ),
      '# HELP entitlement_invalidation_errors_total Deletes that failed after the write committed.',
      '# TYPE entitlement_invalidation_errors_total counter',
      `entitlement_invalidation_errors_total ${counters.invalidationErrors}`,
      '# HELP entitlement_listener_connects_total LISTEN connections opened. More than one is a reconnect.',
      '# TYPE entitlement_listener_connects_total counter',
      `entitlement_listener_connects_total ${counters.listenerConnects}`,
      '# HELP ingest_rate_limited_total Ingest requests answered 429.',
      '# TYPE ingest_rate_limited_total counter',
      `ingest_rate_limited_total ${counters.rateLimited}`,
      '# HELP ingest_rate_limit_errors_total Limiter checks that failed open because Redis errored.',
      '# TYPE ingest_rate_limit_errors_total counter',
      `ingest_rate_limit_errors_total ${counters.rateLimitErrors}`,
      '',
    ].join('\n');
  }

  private counted(source: LookupSource, entitlements: Entitlements): Resolved {
    counters.lookups[source] += 1;
    return { entitlements, source };
  }
}
