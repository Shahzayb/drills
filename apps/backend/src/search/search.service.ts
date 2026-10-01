import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { errorMessage, logger } from '../observability/logger';
import { RedisService } from '../redis/redis.service';
import { TenantDb } from '../tenancy/tenant-db.service';
import { SearchMessagesQuery } from './dto/search-messages.query';

interface HitRow {
  id: string;
  conversation_id: string;
  message: string;
  created_at: Date;
}

/** The API's shape: camelCase, timestamps as ISO strings, ids as strings. Same
 *  reasoning as ConversationListItem — a column name in a JSON body makes
 *  renaming the column a breaking API change. */
export interface MessageHit {
  id: string;
  conversationId: string;
  message: string;
  createdAt: string;
}

export interface MessageSearchResult {
  items: MessageHit[];
  /** Echoed so a measurement can tell which arm answered without reading the
   *  container's environment. */
  strategy: SearchStrategy;
}

/** The database's shape for the stats aggregate. Every count is a bigint and
 *  so arrives as a string; the two nullable ones are null on an empty org. */
interface StatsRow {
  messages: string;
  negative: string;
  positive: string;
  recent: string;
  avg_length: number | null;
  last_message_at: Date | null;
}

/**
 * Card 17's org-level widget. One aggregate over every message the org has.
 *
 * `method` is there so the number is never mistaken for sentiment analysis: it
 * is two word lists matched against the tsvector, and it says so in the body
 * rather than in a comment nobody sees.
 *
 * Counts are `Number()`d off bigint strings, the same 2^53 cap as the quota
 * meter and the import counters — recorded in memory-bank/progress.md, not
 * hidden here.
 */
export interface MessageStats {
  messages: number;
  negative: number;
  positive: number;
  /** Messages in the last 90 days. */
  recent: number;
  avgLength: number;
  lastMessageAt: string | null;
  method: 'lexicon';
}

/**
 * Which arm answers. Read once at module load, same as LIST_STRATEGY and
 * KEYSET_TIEBREAK and for the same reason: an A/B whose arms are two different
 * checkouts measures the checkout.
 *
 * `like` is the four-minute version the card asks to ship first — a leading
 * wildcard that no index can serve. It stays on this commit permanently as the
 * "before" column, and as the red case for the stemming assertion in
 * test/search.e2e-spec.ts. See plans/2026-08-29_drill-11-full-text-search.md.
 */
export type SearchStrategy = 'like' | 'fts';

export const SEARCH_STRATEGY: SearchStrategy =
  process.env.SEARCH_STRATEGY === 'like' ? 'like' : 'fts';

/**
 * `%`, `_` and `\` are the user's literal text, not pattern syntax. Unescaped,
 * `100%` matches every message in the org and `snake_case` silently matches
 * `snakeXcase` too — and only on the `like` arm, which would put a difference
 * into every A/B run that has nothing to do with the tsvector.
 */
const escapeLike = (term: string) => term.replace(/[\\%_]/g, '\\$&');

/**
 * Card 20: what a request does when the stats key has expired.
 *
 * - `off`    Postgres every request. Drill 17's slow widget.
 * - `naive`  cache-aside. Every request that finds the key expired recomputes. The stampede.
 * - `wait`   single-flight. One request holds a Redis lock and recomputes; the rest poll for its value.
 * - `stale`  single-flight. The lock winner recomputes in the background; everyone serves the old value.
 *
 * See plans/2026-09-29_drill-20-cache-stampede.md.
 */
export type StatsCacheMode = 'off' | 'naive' | 'wait' | 'stale';

const STATS_MODES: StatsCacheMode[] = ['off', 'naive', 'wait', 'stale'];

export const STATS_CACHE: StatsCacheMode = STATS_MODES.includes(
  process.env.STATS_CACHE as StatsCacheMode,
)
  ? (process.env.STATS_CACHE as StatsCacheMode)
  : 'stale';

/** Seconds a stats value stays fresh. Jitter only shortens it, so this stays the bound on a fresh value's age. */
export const STATS_TTL_S = Number(process.env.STATS_TTL_S || '30');

/** The share of the TTL removed at random from each fill, so keys filled together do not expire together. */
export const STATS_TTL_JITTER = Number(process.env.STATS_TTL_JITTER || '0.2');

export const STATS_CACHE_HEADER = 'x-stats-cache';

/** `refresh` served an expired value and started the recompute. `db` is the `off` arm. */
export type StatsSource =
  'hit' | 'miss' | 'wait' | 'stale' | 'refresh' | 'db' | 'bypass';

export interface StatsAnswer {
  stats: MessageStats;
  source: StatsSource;
  /** When Postgres answered, epoch ms. */
  computedAt: number;
}

/** Freshness lives in the value, so db/stampede.mts can expire a key on every arm by rewriting it. */
interface Envelope {
  stats: MessageStats;
  computedAt: number;
  freshUntil: number;
}

export const statsKey = (orgId: string) => `stats:v1:org:${orgId}`;

const statsLockKey = (orgId: string) => `lock:stats:v1:org:${orgId}`;

/** Longer than any recompute measured (whale 3.2s). A lock outliving its holder costs one duplicate, never a wrong answer. */
const LOCK_TTL_S = 10;
/** A waiter gives up with a 503 here, before a dead holder's lock expires. */
const WAIT_MS = 5_000;
const POLL_MS = 25;
/** The stale arm keeps an expired value this many TTLs, so a quiet org still has something to serve. */
const STALE_TTLS = 10;

const isFresh = (envelope: Envelope | null): envelope is Envelope =>
  envelope !== null && Date.now() < envelope.freshUntil;

/** Per process, like the entitlement counters. `recomputes` counts completed aggregates, as pg_stat_statements does. */
const statsCounters = {
  lookups: {
    hit: 0,
    miss: 0,
    wait: 0,
    stale: 0,
    refresh: 0,
    db: 0,
    bypass: 0,
    timeout: 0,
    error: 0,
  } as Record<StatsSource | 'timeout' | 'error', number>,
  recomputes: 0,
};

export function statsCacheMetrics(): string {
  return [
    '# HELP stats_cache_info The running arm, TTL and jitter.',
    '# TYPE stats_cache_info gauge',
    `stats_cache_info{mode="${STATS_CACHE}",ttl_seconds="${STATS_TTL_S}",jitter="${STATS_TTL_JITTER}"} 1`,
    '# HELP stats_cache_lookups_total Stats requests by how they were answered.',
    '# TYPE stats_cache_lookups_total counter',
    ...Object.entries(statsCounters.lookups).map(
      ([result, n]) => `stats_cache_lookups_total{result="${result}"} ${n}`,
    ),
    '# HELP stats_recomputes_total Stats aggregates Postgres completed.',
    '# TYPE stats_recomputes_total counter',
    `stats_recomputes_total ${statsCounters.recomputes}`,
    '',
  ].join('\n');
}

/**
 * Stems, not words, because that is what the tsvector holds. `failing`,
 * `failed` and `fails` are all the lexeme `fail`, so one entry matches every
 * form — and the words come from the seed corpus, so the split describes the
 * inbox rather than an English dictionary. Two lists, `|`-joined for
 * to_tsquery. See plans/2026-09-17_drill-17-streaming-inbox-suspense.md.
 */
const NEGATIVE_LEXICON =
  'fail | error | charge | duplicate | block | stop | drop | chase | wrong';
const POSITIVE_LEXICON =
  'thank | fix | resolve | refund | credit | deploy | confirm | appreciate';

const toHit = (row: HitRow): MessageHit => ({
  id: row.id,
  conversationId: row.conversation_id,
  message: row.message,
  createdAt: row.created_at.toISOString(),
});

@Injectable()
export class SearchService {
  constructor(
    private readonly tenants: TenantDb,
    private readonly redis: RedisService,
  ) {}

  /**
   * One statement, one transaction, whichever arm is configured.
   *
   * Both arms carry an explicit `m.org_id = $1` on top of the RLS policy, for
   * the same two reasons `list()` does: it is the predicate drill 09 compares
   * against, and on the FTS arm it is the one that reaches the leading column
   * of `messages_org_tsv_idx`, which is a `gin (org_id, tsv)` and not a
   * `gin (tsv)` precisely so that a tail org does not pay the whale's costs.
   */
  async search(
    orgId: string,
    query: SearchMessagesQuery,
  ): Promise<MessageSearchResult> {
    const like = SEARCH_STRATEGY === 'like';
    const predicate = like
      ? `m.message ILIKE '%' || $2 || '%' ESCAPE '\\'`
      : `m.tsv @@ websearch_to_tsquery('english', $2)`;
    const term = like ? escapeLike(query.q) : query.q;

    const items = await this.tenants.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<HitRow>(
        `SELECT m.id, m.conversation_id, m.message, m.created_at
           FROM messages m
          WHERE m.org_id = $1 AND ${predicate}
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $3`,
        [orgId, term, query.limit],
      );
      return rows.map(toHit);
    });

    return { items, strategy: SEARCH_STRATEGY };
  }

  /**
   * The widget's aggregate through card 20's cache. `bypass` is a request's
   * `Cache-Control: no-cache`: the frontend's `?cache=nostore` arm sends it.
   */
  async stats(orgId: string, bypass = false): Promise<StatsAnswer> {
    if (STATS_CACHE === 'off' || bypass) {
      const stats = await this.computeStats(orgId);
      return this.answer(bypass ? 'bypass' : 'db', {
        stats,
        computedAt: Date.now(),
      });
    }

    const cached = await this.readStats(orgId);
    if (isFresh(cached)) return this.answer('hit', cached);
    if (STATS_CACHE === 'naive') {
      return this.answer('miss', await this.recompute(orgId));
    }

    const token = randomUUID();
    if (cached && STATS_CACHE === 'stale') {
      const claim = await this.claim(orgId, token);
      if (claim.fresh) return this.answer('hit', claim.fresh);
      if (!claim.won) return this.answer('stale', cached);
      void this.recomputeAndRelease(orgId, token).catch((error) =>
        logger.error(
          { orgId, err: errorMessage(error) },
          'stats_refresh_failed',
        ),
      );
      return this.answer('refresh', cached);
    }

    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const claim = await this.claim(orgId, token);
      if (claim.fresh) return this.answer('hit', claim.fresh);
      if (claim.won) {
        return this.answer(
          'miss',
          await this.recomputeAndRelease(orgId, token),
        );
      }
      if (Date.now() >= deadline) {
        statsCounters.lookups.timeout += 1;
        throw new ServiceUnavailableException({
          error: 'stats_timeout',
          message: `no stats for org ${orgId} after ${WAIT_MS}ms`,
        });
      }
      await sleep(POLL_MS);
      const current = await this.readStats(orgId);
      if (isFresh(current)) return this.answer('wait', current);
    }
  }

  /**
   * Takes the lock, then re-reads: the last holder may have filled the key between our read and
   * our lock. Without the second read that request recomputes a fresh value (double-checked locking).
   */
  private async claim(
    orgId: string,
    token: string,
  ): Promise<{ won: boolean; fresh: Envelope | null }> {
    let won: boolean;
    try {
      won = await this.redis.setIfAbsent(
        statsLockKey(orgId),
        token,
        LOCK_TTL_S,
      );
    } catch (error) {
      throw this.cacheDown(error);
    }
    if (!won) return { won: false, fresh: null };

    const current = await this.readStats(orgId);
    if (!isFresh(current)) return { won: true, fresh: null };
    await this.release(orgId, token);
    return { won: false, fresh: current };
  }

  private async recomputeAndRelease(
    orgId: string,
    token: string,
  ): Promise<Envelope> {
    try {
      return await this.recompute(orgId);
    } finally {
      await this.release(orgId, token);
    }
  }

  /** A failed release leaves the lock to its TTL: waiters stall up to 10s, nobody gets a wrong answer. */
  private async release(orgId: string, token: string): Promise<void> {
    await this.redis
      .delIfEquals(statsLockKey(orgId), token)
      .catch(() => undefined);
  }

  private async recompute(orgId: string): Promise<Envelope> {
    const stats = await this.computeStats(orgId);
    const computedAt = Date.now();
    const ttlS = STATS_TTL_S * (1 - STATS_TTL_JITTER * Math.random());
    const envelope = {
      stats,
      computedAt,
      freshUntil: computedAt + ttlS * 1000,
    };
    const keepS = STATS_CACHE === 'stale' ? ttlS * STALE_TTLS : ttlS;
    // A failed SET costs the next request a recompute. The answer is already correct.
    await this.redis
      .set(statsKey(orgId), JSON.stringify(envelope), keepS)
      .catch(() => undefined);
    return envelope;
  }

  /** Fails closed. Falling back to Postgres when Redis is down makes every request a recompute. */
  private async readStats(orgId: string): Promise<Envelope | null> {
    try {
      const raw = await this.redis.get(statsKey(orgId));
      return raw ? (JSON.parse(raw) as Envelope) : null;
    } catch (error) {
      throw this.cacheDown(error);
    }
  }

  private cacheDown(error: unknown): ServiceUnavailableException {
    statsCounters.lookups.error += 1;
    logger.warn({ err: errorMessage(error) }, 'stats_cache_error');
    return new ServiceUnavailableException({
      error: 'stats_unavailable',
      message: 'the stats cache is unreachable',
    });
  }

  private answer(
    source: StatsSource,
    { stats, computedAt }: Pick<Envelope, 'stats' | 'computedAt'>,
  ): StatsAnswer {
    statsCounters.lookups[source] += 1;
    return { stats, source, computedAt };
  }

  /**
   * The inbox widget's aggregate. Card 17.
   *
   * One statement, and it is expensive on purpose — the card asks for a widget
   * that is genuinely slow rather than one with a sleep in it. `messages.org_id`
   * has a foreign key and no index (drill 02 left it out for exactly this), so
   * for the whale this is a sequential scan of the whole `messages` heap.
   * Card 20 puts a cache in front of it: `stats()` above.
   *
   * Every aggregate rides the same scan: the FILTER clauses evaluate `@@`
   * against the stored tsvector per row rather than through the GIN index,
   * because the WHERE is only `org_id` and the index cannot help a query that
   * wants 40% of the table. `pnpm db:search aggregate` records the plan.
   */
  private async computeStats(orgId: string): Promise<MessageStats> {
    const { rows } = await this.tenants.withOrg(orgId, (tx) =>
      tx.query<StatsRow>(
        `SELECT count(*)                                                   AS messages,
                count(*) FILTER (WHERE m.tsv @@ to_tsquery('english', $2)) AS negative,
                count(*) FILTER (WHERE m.tsv @@ to_tsquery('english', $3)) AS positive,
                count(*) FILTER (WHERE m.created_at >= now() - interval '90 days')
                                                                           AS recent,
                avg(length(m.message))::float8                             AS avg_length,
                max(m.created_at)                                          AS last_message_at
           FROM messages m
          WHERE m.org_id = $1`,
        [orgId, NEGATIVE_LEXICON, POSITIVE_LEXICON],
      ),
    );

    statsCounters.recomputes += 1;
    const row = rows[0];
    return {
      messages: Number(row.messages),
      negative: Number(row.negative),
      positive: Number(row.positive),
      recent: Number(row.recent),
      avgLength: row.avg_length ?? 0,
      lastMessageAt: row.last_message_at?.toISOString() ?? null,
      method: 'lexicon',
    };
  }
}
