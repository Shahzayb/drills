import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { errorMessage, logger, since } from '../observability/logger';
import { getRequestId } from '../observability/request-context';

// Matches the Postgres side deliberately: a dependency gets 2s to answer before
// we call it down, whichever dependency it is.
const COMMAND_TIMEOUT_MS = 2000;
const CONNECT_TIMEOUT_MS = 2000;
// ioredis defaults to 20. One retry means a dead Redis is reported in about a
// second instead of being retried into a timeout.
const MAX_RETRIES_PER_REQUEST = 1;

// KEYS[1] the bucket, ARGV capacity and tokens per ms. Returns allowed, whole tokens left, ms to full, ms to a token.
const TAKE_TOKEN = `
local capacity = tonumber(ARGV[1])
local perMs = tonumber(ARGV[2])
local clock = redis.call('TIME')
local now = clock[1] * 1000 + math.floor(clock[2] / 1000)
local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or capacity
local ts = tonumber(state[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - ts) * perMs)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
local fullMs = math.ceil((capacity - tokens) / perMs)
redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.max(fullMs, 1))
local retryMs = 0
if allowed == 0 then retryMs = math.ceil((1 - tokens) / perMs) end
return { allowed, math.floor(tokens), fullMs, retryMs }
`;

/**
 * Owns the Redis client. The client stays private on purpose — when a drill
 * needs a new command, it gets a method here rather than a handle to the raw
 * client. That is what makes this a chokepoint instead of a container.
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly client: Redis;
  // Imported, not injected — see observability/logger.ts.
  private readonly logger = logger;

  constructor() {
    this.client = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD,
      // The e2e suite uses DB 1, so the dev server's NOTIFY listener cannot delete its keys. Drill 19.
      db: Number(process.env.REDIS_DB || 0),
      commandTimeout: COMMAND_TIMEOUT_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
      maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
      // Deliberately lazy: an eager client opens a socket at module init, which
      // fails and leaks a handle when the tests construct AppModule without
      // Docker. Note that enableOfflineQueue must stay at its default — with it
      // off, ioredis rejects commands whenever status isn't 'ready', and a lazy
      // client starts in 'wait', so the first command would reject without ever
      // trying to connect.
      lazyConnect: true,
    });

    // Without this listener an unreachable Redis emits an unhandled error event
    // and takes the process down — the opposite of what a health check is for.
    this.client.on('error', (error: Error) => {
      this.logger.warn({ err: error.message }, 'redis_client_error');
    });
  }

  /**
   * The id travels as a log field only. Redis's equivalent of the SQL comment
   * would be CLIENT SETNAME, which names the *connection*, and this client is
   * one shared socket — naming it per request would mean a connection per
   * request.
   */
  async ping(): Promise<string> {
    const rid = getRequestId();
    const startedAt = performance.now();
    try {
      return await this.client.ping();
    } finally {
      if (this.logger.isLevelEnabled('debug')) {
        this.logger.debug(
          { rid, cmd: 'PING', durMs: since(startedAt) },
          'redis_command',
        );
      }
    }
  }

  /**
   * `SET key value NX EX ttl` — the whole of drill 12's Redis guard.
   *
   * Returns true when this caller is the one that created the key. ioredis
   * resolves to 'OK' when NX succeeded and to null when the key already
   * existed, and that null is the entire mechanism: it is one round trip that
   * both asks and claims, so two concurrent callers cannot both be told they
   * won. A GET followed by a SET would let them.
   *
   * The TTL is not optional here. A guard with no expiry is a memory leak whose
   * unit is "every event you have ever received".
   */
  async setIfAbsent(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const rid = getRequestId();
    const startedAt = performance.now();
    try {
      const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } finally {
      if (this.logger.isLevelEnabled('debug')) {
        this.logger.debug(
          { rid, cmd: 'SET NX', key, durMs: since(startedAt) },
          'redis_command',
        );
      }
    }
  }

  /** Reads a guard back. Null both when it never existed and when it expired —
   *  Redis does not distinguish those, and neither can any caller. */
  async get(key: string): Promise<string | null> {
    const rid = getRequestId();
    const startedAt = performance.now();
    try {
      return await this.client.get(key);
    } finally {
      if (this.logger.isLevelEnabled('debug')) {
        this.logger.debug(
          { rid, cmd: 'GET', key, durMs: since(startedAt) },
          'redis_command',
        );
      }
    }
  }

  /** Overwrites a guard, keeping a TTL. Used to replace the placeholder with
   *  the committed conversation id, so a later duplicate can be answered
   *  without touching Postgres at all. `PX` so a jittered TTL keeps its
   *  milliseconds (drill 20); callers still pass seconds. */
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    const rid = getRequestId();
    const startedAt = performance.now();
    try {
      await this.client.set(key, value, 'PX', Math.round(ttlSeconds * 1000));
    } finally {
      if (this.logger.isLevelEnabled('debug')) {
        this.logger.debug(
          { rid, cmd: 'SET', key, durMs: since(startedAt) },
          'redis_command',
        );
      }
    }
  }

  /**
   * Releases a guard whose write failed, so the event stays retryable.
   *
   * This narrows the window and does not close it: a process that dies between
   * the SETNX and this call leaves the guard held with nothing behind it, and
   * the event is lost until the TTL expires. That gap is the failure mode the
   * unique constraint does not have, and it cannot be closed from here — the
   * guard and the commit are in two different systems. See
   * plans/2026-08-31_drill-12-idempotent-ingest.md.
   */
  async del(key: string): Promise<void> {
    const rid = getRequestId();
    const startedAt = performance.now();
    try {
      await this.client.del(key);
    } finally {
      if (this.logger.isLevelEnabled('debug')) {
        this.logger.debug(
          { rid, cmd: 'DEL', key, durMs: since(startedAt) },
          'redis_command',
        );
      }
    }
  }

  /**
   * Releases a lock only if this caller still holds it: GET and DEL in one Lua script, so nothing
   * runs between them. A holder whose lock expired must not delete the next holder's. Drill 20.
   */
  async delIfEquals(key: string, value: string): Promise<boolean> {
    const rid = getRequestId();
    const startedAt = performance.now();
    try {
      const deleted = await this.client.eval(
        `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
        1,
        key,
        value,
      );
      return deleted === 1;
    } finally {
      if (this.logger.isLevelEnabled('debug')) {
        this.logger.debug(
          { rid, cmd: 'EVAL DEL-IF-EQ', key, durMs: since(startedAt) },
          'redis_command',
        );
      }
    }
  }

  /**
   * A fixed window that starts at the first hit: INCR, EXPIRE NX, PTTL in one MULTI.
   * NX keeps later hits from sliding the window. See plans/2026-09-23_drill-19-entitlement-cache.md.
   */
  async incrWindow(
    key: string,
    ttlSeconds: number,
  ): Promise<{ count: number; pttlMs: number }> {
    const rid = getRequestId();
    const startedAt = performance.now();
    try {
      const replies = await this.client
        .multi()
        .incr(key)
        .expire(key, ttlSeconds, 'NX')
        .pttl(key)
        .exec();
      const failed = replies?.find(([error]) => error)?.[0];
      if (!replies || failed) throw failed ?? new Error('MULTI aborted');
      return { count: Number(replies[0][1]), pttlMs: Number(replies[2][1]) };
    } finally {
      if (this.logger.isLevelEnabled('debug')) {
        this.logger.debug(
          { rid, cmd: 'MULTI INCR/EXPIRE/PTTL', key, durMs: since(startedAt) },
          'redis_command',
        );
      }
    }
  }

  /**
   * One token from a bucket of `capacity` refilling at `perSecond`. Read, refill, take and write run as
   * one Lua script, so no other command lands between the read and the write. The clock is Redis's
   * `TIME`, one clock for every app replica. See plans/2026-10-06_drill-21-rate-limit-burst-boundary.md.
   */
  async takeToken(
    key: string,
    capacity: number,
    perSecond: number,
  ): Promise<{
    allowed: boolean;
    tokens: number;
    fullMs: number;
    retryMs: number;
  }> {
    const rid = getRequestId();
    const startedAt = performance.now();
    try {
      const [allowed, tokens, fullMs, retryMs] = (await this.client.eval(
        TAKE_TOKEN,
        1,
        key,
        capacity,
        perSecond / 1000,
      )) as number[];
      return { allowed: allowed === 1, tokens, fullMs, retryMs };
    } finally {
      if (this.logger.isLevelEnabled('debug')) {
        this.logger.debug(
          { rid, cmd: 'EVAL TAKE-TOKEN', key, durMs: since(startedAt) },
          'redis_command',
        );
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    try {
      // quit() throws on a client that never connected, which is the normal
      // case in tests — disconnect() is the safe teardown there.
      if (this.client.status === 'ready') {
        await this.client.quit();
      } else {
        this.client.disconnect();
      }
    } catch (error) {
      this.logger.warn({ err: errorMessage(error) }, 'redis_close_failed');
    }
  }
}
