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

/**
 * How API-key ingest is metered: algorithm × atomicity.
 *
 * - `fixed`       drill 19's window: INCR first, then compare. Atomic; admits 2× across a boundary.
 * - `fixed-rmw`   GET, compare, SET. The naive window: the boundary bug plus a race.
 * - `bucket-rmw`  a token bucket computed in Node between a GET and a SET. The race alone.
 * - `bucket`      the same bucket in one Lua script. Shipped.
 *
 * See plans/2026-10-06_drill-21-rate-limit-burst-boundary.md.
 */
export type RateLimitMode = 'fixed' | 'fixed-rmw' | 'bucket-rmw' | 'bucket';

const RATE_LIMIT_MODES: RateLimitMode[] = [
  'fixed',
  'fixed-rmw',
  'bucket-rmw',
  'bucket',
];

export const RATE_LIMIT: RateLimitMode = RATE_LIMIT_MODES.includes(
  process.env.RATE_LIMIT as RateLimitMode,
)
  ? (process.env.RATE_LIMIT as RateLimitMode)
  : 'bucket';

/** A fixed window's length, anchored at its first request. A bucket holds `L` and refills `L` per window. */
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

export interface Decision {
  limit: number;
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets, or until the bucket is full. */
  resetS: number;
  /** Seconds until a retry can be admitted. 0 when allowed. */
  retryAfterS: number;
}

/** `v1` versions the value's shape: a deploy that changes it reads a new key, never an old shape. */
export const entitlementKey = (orgId: string) => `ent:v1:org:${orgId}`;

/** Per arm, because each arm stores a different shape. */
export const rateLimitKey = (orgId: string, mode: RateLimitMode = RATE_LIMIT) =>
  `rl:v2:ingest:${mode}:org:${orgId}`;

const seconds = (ms: number) => Math.ceil(ms / 1000);

/** Per process. Prometheus sums replicas; a ratio is a rate() of these, not a stored number. */
const counters = {
  lookups: { hit: 0, miss: 0, db: 0, error: 0 } as Record<LookupSource, number>,
  invalidations: { api: 0, notify: 0 },
  invalidationErrors: 0,
  listenerConnects: 0,
  rateLimited: 0,
  rateLimitAllowed: 0,
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

  /** Null when the plan is unlimited or Redis failed (fail open). Otherwise this request's decision. */
  async consumeIngest(
    orgId: string,
    entitlements: Entitlements,
  ): Promise<Decision | null> {
    const limit = entitlements.ingestPerMinute;
    if (limit === null) return null;

    try {
      const decision = await this.decide(rateLimitKey(orgId), limit);
      if (decision.allowed) counters.rateLimitAllowed += 1;
      else counters.rateLimited += 1;
      return decision;
    } catch (error) {
      counters.rateLimitErrors += 1;
      logger.warn({ err: errorMessage(error) }, 'rate_limit_failed_open');
      return null;
    }
  }

  private async decide(key: string, limit: number): Promise<Decision> {
    if (RATE_LIMIT === 'fixed') {
      const { count, pttlMs } = await this.redis.incrWindow(
        key,
        INGEST_WINDOW_S,
      );
      const allowed = count <= limit;
      return {
        limit,
        allowed,
        remaining: Math.max(0, limit - count),
        resetS: seconds(pttlMs),
        retryAfterS: allowed ? 0 : seconds(pttlMs),
      };
    }

    if (RATE_LIMIT === 'bucket') {
      const { allowed, tokens, fullMs, retryMs } = await this.redis.takeToken(
        key,
        limit,
        limit / INGEST_WINDOW_S,
      );
      return {
        limit,
        allowed,
        remaining: tokens,
        resetS: seconds(fullMs),
        retryAfterS: seconds(retryMs),
      };
    }

    // The rmw arms: anything that runs between this GET and the SET below reads the same state.
    const now = Date.now();
    const raw = await this.redis.get(key);

    if (RATE_LIMIT === 'fixed-rmw') {
      const window = raw
        ? (JSON.parse(raw) as { count: number; resetAt: number })
        : { count: 0, resetAt: now + INGEST_WINDOW_S * 1000 };
      const resetMs = Math.max(1, window.resetAt - now);
      const allowed = window.count < limit;
      if (allowed) {
        window.count += 1;
        await this.redis.set(key, JSON.stringify(window), resetMs / 1000);
      }
      return {
        limit,
        allowed,
        remaining: Math.max(0, limit - window.count),
        resetS: seconds(resetMs),
        retryAfterS: allowed ? 0 : seconds(resetMs),
      };
    }

    const perMs = limit / INGEST_WINDOW_S / 1000;
    const state = raw
      ? (JSON.parse(raw) as { tokens: number; ts: number })
      : { tokens: limit, ts: now };
    let tokens = Math.min(
      limit,
      state.tokens + Math.max(0, now - state.ts) * perMs,
    );
    const allowed = tokens >= 1;
    if (allowed) tokens -= 1;
    const fullMs = Math.ceil((limit - tokens) / perMs);
    await this.redis.set(
      key,
      JSON.stringify({ tokens, ts: now }),
      Math.max(fullMs, 1) / 1000,
    );
    return {
      limit,
      allowed,
      remaining: Math.floor(tokens),
      resetS: seconds(fullMs),
      retryAfterS: allowed ? 0 : seconds((1 - tokens) / perMs),
    };
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
      '# HELP ingest_rate_limit_allowed_total Metered ingest requests the limiter admitted.',
      '# TYPE ingest_rate_limit_allowed_total counter',
      `ingest_rate_limit_allowed_total ${counters.rateLimitAllowed}`,
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
