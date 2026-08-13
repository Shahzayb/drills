import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';

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
bootstrap();
