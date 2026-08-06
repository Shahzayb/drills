import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';

// Matches the Postgres side deliberately: a dependency gets 2s to answer before
// we call it down, whichever dependency it is.
const COMMAND_TIMEOUT_MS = 2000;
const CONNECT_TIMEOUT_MS = 2000;
// ioredis defaults to 20. One retry means a dead Redis is reported in about a
// second instead of being retried into a timeout.
const MAX_RETRIES_PER_REQUEST = 1;

/**
 * Owns the Redis client. The client stays private on purpose — when a drill
 * needs a new command, it gets a method here rather than a handle to the raw
 * client. That is what makes this a chokepoint instead of a container.
 */
@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor() {
    this.client = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD,
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
      this.logger.warn(error.message);
    });
  }

  async ping(): Promise<string> {
    return this.client.ping();
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
      this.logger.warn(`Closing the client failed: ${String(error)}`);
    }
  }
}
