import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

// TenancyModule imported explicitly for the same reason ConversationsModule,
// SearchModule and IngestModule do it: it is deliberately not @Global(), and
// this line is how the module graph shows that the feature reads tenant data.
// PostgresModule is @Global(), so nothing here reaches for it.
@Module({
  imports: [TenancyModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
