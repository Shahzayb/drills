import { MiddlewareConsumer, Module, ValidationPipe } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { ConversationsModule } from './conversations/conversations.module';
import { HealthModule } from './health/health.module';
import { InfoModule } from './info/info.module';
import { loggerOptions } from './observability/logger.options';
import { LoggingInterceptor } from './observability/logging.interceptor';
import { requestContextMiddleware } from './observability/request-context.middleware';
import { PostgresModule } from './postgres/postgres.module';
import { RedisModule } from './redis/redis.module';
import { SearchModule } from './search/search.module';

@Module({
  imports: [
    LoggerModule.forRoot(loggerOptions),
    PostgresModule,
    RedisModule,
    HealthModule,
    InfoModule,
    ConversationsModule,
    SearchModule,
  ],
  providers: [
    {
      provide: APP_INTERCEPTOR,
      useClass: LoggingInterceptor,
    },
    {
      provide: APP_PIPE,
      useFactory: () =>
        new ValidationPipe({
          transform: true,
          whitelist: true,
          forbidNonWhitelisted: true,
        }),
    },
  ],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(requestContextMiddleware).forRoutes('*');
  }
}
