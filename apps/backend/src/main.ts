// First, and it has to stay first: the OTel instrumentations patch modules as
// they load, so anything required above this line is never traced. See
// ./tracing.ts.
import './tracing';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import {
  HealthService,
  SHUTDOWN,
  SHUTDOWN_TIMEOUT_MS,
} from './health/health.service';
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
  // `exit` registers nothing, so SIGTERM kills the process mid-request. Card 23's control arm.
  if (SHUTDOWN !== 'exit') app.enableShutdownHooks();
  if (SHUTDOWN === 'graceful') armShutdownDeadline(app.get(HealthService));
  await app.listen(process.env.PORT ?? 3002);
}

/** The drain's hard stop. The orchestrator's grace period (stop_grace_period) MUST exceed it. */
function armShutdownDeadline(health: HealthService): void {
  const arm = (signal: NodeJS.Signals) => {
    // Not unref'd: a drain stuck on an empty event loop would otherwise exit 0 silently.
    setTimeout(() => {
      logger.error(
        { signal, timeoutMs: SHUTDOWN_TIMEOUT_MS, ...health.snapshot() },
        'shutdown_deadline_exceeded',
      );
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
  };
  process.once('SIGTERM', arm);
  process.once('SIGINT', arm);
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
