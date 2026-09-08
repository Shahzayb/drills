import { Module } from '@nestjs/common';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

/** TenantDb comes from the @Global() TenancyModule, so nothing is imported
 *  here — the same shape as ConversationsModule and IngestModule. */
@Module({
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
