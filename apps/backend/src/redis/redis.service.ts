import { Injectable, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { errorMessage, logger, since } from '../observability/logger';
import { getRequestId } from '../observability/request-context';

const COMMAND_TIMEOUT_MS = 2000;
const CONNECT_TIMEOUT_MS = 2000;
const MAX_RETRIES_PER_REQUEST = 1;

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly client: Redis;
  private readonly logger = logger;

  constructor() {
    this.client = new Redis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD,
      commandTimeout: COMMAND_TIMEOUT_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
      maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
      lazyConnect: true,
    });

    this.client.on('error', (error: Error) => {
      this.logger.warn({ err: error.message }, 'redis_client_error');
    });
  }

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

  async onApplicationShutdown(): Promise<void> {
    try {
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
