import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

// No `imports` for Postgres: PostgresModule is @Global(), so PostgresService is
// injectable anywhere without re-importing it. That is the only reason a global
// module is justified here — it is a single infrastructure chokepoint, not a
// shortcut for skipping wiring.
//
// TenancyModule is imported explicitly, and deliberately is not global: this
// line is how you can tell from the module graph that this feature touches
// tenant data.
@Module({
  imports: [TenancyModule],
  controllers: [ConversationsController],
  providers: [ConversationsService],
})
export class ConversationsModule {}
