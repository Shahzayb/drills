import { Module } from '@nestjs/common';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';

// No `imports` for Postgres: PostgresModule is @Global(), so PostgresService is
// injectable anywhere without re-importing it. That is the only reason a global
// module is justified here — it is a single infrastructure chokepoint, not a
// shortcut for skipping wiring.
@Module({
  controllers: [ConversationsController],
  providers: [ConversationsService],
})
export class ConversationsModule {}
