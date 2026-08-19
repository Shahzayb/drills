// First, and it has to stay first: the OTel instrumentations patch modules as
// they load, so anything required above this line is never traced. See
// ./tracing.ts.
import './tracing';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { errorMessage, logger } from './observability/logger';

async function bootstrap() {
  // bufferLogs holds Nest's own startup lines until useLogger runs, so route
  // mapping and lifecycle messages come out as JSON like everything else
  // instead of in Nest's pretty format.
  //
  // Note this does not apply under Jest: Test.createTestingModule never runs
  // this file, so Nest's *internal* lines stay pretty-printed in the e2e suite.
  // Our own lines are unaffected — they go through injected PinoLogger.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  // Without this, onApplicationShutdown never fires on SIGTERM, so the pool and
  // the Redis client leak on `docker compose down`.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3002);
}

// Not fire-and-forget: a startup failure (bad credentials, Postgres
// unreachable past retries) has to exit non-zero, or Docker's healthcheck is
// the only thing that ever notices the process came up dead. The module-level
// `logger` is used rather than Nest's injected one — bootstrap can fail before
// `app.useLogger` ever runs, and this is the one line in the process that must
// not depend on Nest DI having finished.
bootstrap().catch((error: unknown) => {
  logger.error({ err: errorMessage(error) }, 'bootstrap_failed');
  process.exit(1);
});
