import { Injectable } from '@nestjs/common';
import { TenantDb } from '../tenancy/tenant-db.service';
import { SearchMessagesQuery } from './dto/search-messages.query';

interface HitRow {
  id: string;
  conversation_id: string;
  message: string;
  created_at: Date;
}

/** The API's shape: camelCase, timestamps as ISO strings, ids as strings. Same
 *  reasoning as ConversationListItem — a column name in a JSON body makes
 *  renaming the column a breaking API change. */
export interface MessageHit {
  id: string;
  conversationId: string;
  message: string;
  createdAt: string;
}

export interface MessageSearchResult {
  items: MessageHit[];
  /** Echoed so a measurement can tell which arm answered without reading the
   *  container's environment. */
  strategy: SearchStrategy;
}

/**
 * Which arm answers. Read once at module load, same as LIST_STRATEGY and
 * KEYSET_TIEBREAK and for the same reason: an A/B whose arms are two different
 * checkouts measures the checkout.
 *
 * `like` is the four-minute version the card asks to ship first — a leading
 * wildcard that no index can serve. It stays on this commit permanently as the
 * "before" column, and as the red case for the stemming assertion in
 * test/search.e2e-spec.ts. See plans/2026-08-29_drill-11-full-text-search.md.
 */
export type SearchStrategy = 'like' | 'fts';

const SEARCH_STRATEGY: SearchStrategy =
  process.env.SEARCH_STRATEGY === 'like' ? 'like' : 'fts';

const toHit = (row: HitRow): MessageHit => ({
  id: row.id,
  conversationId: row.conversation_id,
  message: row.message,
  createdAt: row.created_at.toISOString(),
});

@Injectable()
export class SearchService {
  constructor(private readonly tenants: TenantDb) {}

  /**
   * One statement, one transaction, whichever arm is configured.
   *
   * Both arms carry an explicit `m.org_id = $1` on top of the RLS policy, for
   * the same two reasons `list()` does: it is the predicate drill 09 compares
   * against, and on the FTS arm it is the one that reaches the leading column
   * of `messages_org_tsv_idx`, which is a `gin (org_id, tsv)` and not a
   * `gin (tsv)` precisely so that a tail org does not pay the whale's costs.
   */
  async search(
    orgId: string,
    query: SearchMessagesQuery,
  ): Promise<MessageSearchResult> {
    const predicate =
      SEARCH_STRATEGY === 'like'
        ? `m.message ILIKE '%' || $2 || '%'`
        : `m.tsv @@ websearch_to_tsquery('english', $2)`;

    const items = await this.tenants.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<HitRow>(
        `SELECT m.id, m.conversation_id, m.message, m.created_at
           FROM messages m
          WHERE m.org_id = $1 AND ${predicate}
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT $3`,
        [orgId, query.q, query.limit],
      );
      return rows.map(toHit);
    });

    return { items, strategy: SEARCH_STRATEGY };
  }
}
