import { Module } from '@nestjs/common';
import { TenantDb } from './tenant-db.service';

@Module({
  providers: [TenantDb],
  exports: [TenantDb],
})
export class TenancyModule {}
