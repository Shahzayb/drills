import { MiddlewareConsumer, Module, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ConversationsModule } from './conversations/conversations.module';
import { HealthModule } from './health/health.module';
import { InfoModule } from './info/info.module';
import { IngestModule } from './ingest/ingest.module';
import { loggerOptions } from './observability/logger.options';
import { LoggingInterceptor } from './observability/logging.interceptor';
import { requestContextMiddleware } from './observability/request-context.middleware';
import { PostgresModule } from './postgres/postgres.module';
import { RedisModule } from './redis/redis.module';
import { SearchModule } from './search/search.module';

@Module({
  imports: [
    // Registered here and nowhere else — LoggerModule is @Global(), and
    // re-importing it into a feature module to reach PinoLogger registers its
    // middleware a second time, which logs every request twice.
    LoggerModule.forRoot(loggerOptions),
    PostgresModule,
    RedisModule,
    HealthModule,
    InfoModule,
    ConversationsModule,
    SearchModule,
    IngestModule,
  ],
  providers: [
    {
      // Same reasoning as the pipe below: an interceptor installed in main.ts
      // would be missing from every e2e test.
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
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
export class AppModule {
  configure(consumer: MiddlewareConsumer): void {
    // '*' is correct on Nest 11 despite Express 5's path-to-regexp rejecting
    // unnamed wildcards: LegacyRouteConverter rewrites it to '{*path}' and
    // suppresses the deprecation warning for the all-routes case specifically.
    consumer.apply(requestContextMiddleware).forRoutes('*');
  }
}
