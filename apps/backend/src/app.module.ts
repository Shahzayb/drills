import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthModule } from './health/health.module';
import { InfoModule } from './info/info.module';
import { PostgresModule } from './postgres/postgres.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [PostgresModule, RedisModule, HealthModule, InfoModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
