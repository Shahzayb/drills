import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

// TenancyModule imported explicitly for the same reason ConversationsModule
// does it: this line is how the module graph shows that the feature reads
// tenant data.
@Module({
  imports: [TenancyModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
