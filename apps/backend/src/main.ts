import './tracing';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { errorMessage, logger } from './observability/logger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3002);
}

bootstrap().catch((error: unknown) => {
  logger.error({ err: errorMessage(error) }, 'bootstrap_failed');
  process.exit(1);
});
