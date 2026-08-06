import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Without this, onApplicationShutdown never fires on SIGTERM, so the pool and
  // the Redis client leak on `docker compose down`.
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3002);
}
bootstrap();
