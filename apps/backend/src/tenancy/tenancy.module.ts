import { Module } from '@nestjs/common';
import { TenantDb } from './tenant-db.service';

/**
 * Not `@Global()`, unlike PostgresModule. There is one consumer today, and a
 * global module is justified by being an infrastructure chokepoint — which
 * PostgresService is and this is not. Importing it explicitly also means
 * `grep -l TenancyModule` answers "which modules can reach tenant data".
 */
@Module({
  providers: [TenantDb],
  exports: [TenantDb],
})
export class TenancyModule {}
