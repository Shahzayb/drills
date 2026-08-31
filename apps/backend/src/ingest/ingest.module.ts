import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';

// TenancyModule imported explicitly for the same reason ConversationsModule and
// SearchModule do it: this line is how the module graph shows that the feature
// reads tenant data. RedisModule and PostgresModule are @Global(), so the guard
// and the service reach them without an import here.
@Module({
  imports: [TenancyModule],
  controllers: [IngestController],
  providers: [IngestService],
})
export class IngestModule {}
