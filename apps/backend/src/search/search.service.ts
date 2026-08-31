import { Injectable } from '@nestjs/common';
import { TenantDb } from '../tenancy/tenant-db.service';
import { SearchMessagesQuery } from './dto/search-messages.query';

interface HitRow {
  id: string;
  conversation_id: string;
  message: string;
  created_at: Date;
}

export interface MessageHit {
  id: string;
  conversationId: string;
  message: string;
  createdAt: string;
}

export interface MessageSearchResult {
  items: MessageHit[];
  strategy: SearchStrategy;
}

export type SearchStrategy = 'like' | 'fts';

export const SEARCH_STRATEGY: SearchStrategy =
  process.env.SEARCH_STRATEGY === 'like' ? 'like' : 'fts';

const escapeLike = (term: string) => term.replace(/[\\%_]/g, '\\$&');

const toHit = (row: HitRow): MessageHit => ({
  id: row.id,
  conversationId: row.conversation_id,
  message: row.message,
  createdAt: row.created_at.toISOString(),
});

@Injectable()
export class SearchService {
  constructor(private readonly tenants: TenantDb) {}

  async search(
    orgId: string,
    query: SearchMessagesQuery,
  ): Promise<MessageSearchResult> {
    const like = SEARCH_STRATEGY === 'like';
    const predicate = like
      ? `m.message ILIKE '%' || $2 || '%' ESCAPE '\\'`
      : `m.tsv @@ websearch_to_tsquery('english', $2)`;
    const term = like ? escapeLike(query.q) : query.q;

    const items = await this.tenants.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<HitRow>(
        `SELECT m.id, m.conversation_id, m.message, m.created_at
           FROM messages m
          WHERE m.org_id = $1 AND ${predicate}
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $3`,
        [orgId, term, query.limit],
      );
      return rows.map(toHit);
    });

    return { items, strategy: SEARCH_STRATEGY };
  }
}
