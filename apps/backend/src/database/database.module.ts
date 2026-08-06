import {
  Global,
  Inject,
  Logger,
  Module,
  OnApplicationShutdown,
} from '@nestjs/common';
import Redis from 'ioredis';
import { Pool } from 'pg';
import { PG_POOL, REDIS_CLIENT } from './database.constants';

// Values come from the container environment, which docker compose populates
// from the root .env via `env_file`. The fallbacks exist so the module can be
// constructed with no environment at all — that is what lets Jest instantiate
// AppModule outside Docker.
const pgPoolFactory = (): Pool => {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER ?? 'postgres',
    password: process.env.POSTGRES_PASSWORD ?? 'postgres',
    database: process.env.POSTGRES_DB ?? 'postgres',
    max: 5,
    connectionTimeoutMillis: 2000,
  });

  // A pool emits 'error' for *idle* clients that die out from under it — which
  // is what happens the moment Postgres restarts. Node exits on an unhandled
  // 'error' event, so without this the process dies whenever the database
  // bounces, instead of reporting it as unhealthy.
  pool.on('error', (error: Error) => {
    new Logger('Postgres').warn(error.message);
  });

  return pool;
};

const redisClientFactory = (): Redis => {
  const client = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: 1,
    // Deliberately lazy: an eager client opens a socket at module init, which
    // fails and leaks a handle when the tests construct AppModule without Docker.
    // Note that enableOfflineQueue must stay on — with it off, ioredis rejects
    // commands whenever status isn't 'ready', and a lazy client starts in 'wait',
    // so the first ping() would reject without ever trying to connect.
    lazyConnect: true,
  });

  // Without this listener an unreachable Redis emits an unhandled error event
  // and takes the process down — the opposite of what a health endpoint is for.
  client.on('error', (error: Error) => {
    new Logger('Redis').warn(error.message);
  });

  return client;
};

@Global()
@Module({
  providers: [
    { provide: PG_POOL, useFactory: pgPoolFactory },
    { provide: REDIS_CLIENT, useFactory: redisClientFactory },
  ],
  exports: [PG_POOL, REDIS_CLIENT],
})
export class DatabaseModule implements OnApplicationShutdown {
  private readonly logger = new Logger(DatabaseModule.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    try {
      await this.pool.end();
    } catch (error) {
      this.logger.warn(`Closing the Postgres pool failed: ${String(error)}`);
    }

    try {
      // quit() throws on a client that never connected, which is the normal
      // case in tests — disconnect() is the safe teardown there.
      if (this.redis.status === 'ready') {
        await this.redis.quit();
      } else {
        this.redis.disconnect();
      }
    } catch (error) {
      this.logger.warn(`Closing the Redis client failed: ${String(error)}`);
    }
  }
}
