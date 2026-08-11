import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConversationsModule } from './conversations/conversations.module';
import { HealthModule } from './health/health.module';
import { InfoModule } from './info/info.module';
import { PostgresModule } from './postgres/postgres.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    PostgresModule,
    RedisModule,
    HealthModule,
    InfoModule,
    ConversationsModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      // Registered as a provider rather than with app.useGlobalPipes() in
      // main.ts, because main.ts never runs in tests — Test.createTestingModule
      // builds the app from this graph. A pipe installed in main.ts is absent
      // from every e2e test, so the tests would validate a different
      // application than the one that ships.
      provide: APP_PIPE,
      useFactory: () =>
        new ValidationPipe({
          // Query strings are strings. Without this the DTO is a plain object
          // and its @Type conversions never run.
          transform: true,
          // Drop properties with no decorator on the DTO...
          whitelist: true,
          // ...and 400 rather than dropping silently. A typo'd `?pageSze=10`
          // that quietly returns the default is worse than an error.
          forbidNonWhitelisted: true,
        }),
    },
  ],
})
export class AppModule {}
