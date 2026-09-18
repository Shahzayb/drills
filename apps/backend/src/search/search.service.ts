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

/** The database's shape for the stats aggregate. Every count is a bigint and
 *  so arrives as a string; the two nullable ones are null on an empty org. */
interface StatsRow {
  messages: string;
  negative: string;
  positive: string;
  recent: string;
  avg_length: number | null;
  last_message_at: Date | null;
}

/**
 * Card 17's org-level widget. One aggregate over every message the org has.
 *
 * `method` is there so the number is never mistaken for sentiment analysis: it
 * is two word lists matched against the tsvector, and it says so in the body
 * rather than in a comment nobody sees.
 *
 * Counts are `Number()`d off bigint strings, the same 2^53 cap as the quota
 * meter and the import counters — recorded in memory-bank/progress.md, not
 * hidden here.
 */
export interface MessageStats {
  messages: number;
  negative: number;
  positive: number;
  /** Messages in the last 90 days. */
  recent: number;
  avgLength: number;
  lastMessageAt: string | null;
  method: 'lexicon';
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

export const SEARCH_STRATEGY: SearchStrategy =
  process.env.SEARCH_STRATEGY === 'like' ? 'like' : 'fts';

/**
 * `%`, `_` and `\` are the user's literal text, not pattern syntax. Unescaped,
 * `100%` matches every message in the org and `snake_case` silently matches
 * `snakeXcase` too — and only on the `like` arm, which would put a difference
 * into every A/B run that has nothing to do with the tsvector.
 */
const escapeLike = (term: string) => term.replace(/[\\%_]/g, '\\$&');

/**
 * Stems, not words, because that is what the tsvector holds. `failing`,
 * `failed` and `fails` are all the lexeme `fail`, so one entry matches every
 * form — and the words come from the seed corpus, so the split describes the
 * inbox rather than an English dictionary. Two lists, `|`-joined for
 * to_tsquery. See plans/2026-09-17_drill-17-streaming-inbox-suspense.md.
 */
const NEGATIVE_LEXICON =
  'fail | error | charge | duplicate | block | stop | drop | chase | wrong';
const POSITIVE_LEXICON =
  'thank | fix | resolve | refund | credit | deploy | confirm | appreciate';

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

  /**
   * The inbox widget's aggregate. Card 17.
   *
   * One statement, and it is expensive on purpose — the card asks for a widget
   * that is genuinely slow rather than one with a sleep in it. `messages.org_id`
   * has a foreign key and no index (drill 02 left it out for exactly this), so
   * for the whale this is a sequential scan of the whole `messages` heap, every
   * request, with nothing cached in front of it. Caching is a later card; this
   * one measures what the page does while the query runs.
   *
   * Every aggregate rides the same scan: the FILTER clauses evaluate `@@`
   * against the stored tsvector per row rather than through the GIN index,
   * because the WHERE is only `org_id` and the index cannot help a query that
   * wants 40% of the table. `pnpm db:search aggregate` records the plan.
   */
  async stats(orgId: string): Promise<MessageStats> {
    const { rows } = await this.tenants.withOrg(orgId, (tx) =>
      tx.query<StatsRow>(
        `SELECT count(*)                                                   AS messages,
                count(*) FILTER (WHERE m.tsv @@ to_tsquery('english', $2)) AS negative,
                count(*) FILTER (WHERE m.tsv @@ to_tsquery('english', $3)) AS positive,
                count(*) FILTER (WHERE m.created_at >= now() - interval '90 days')
                                                                           AS recent,
                avg(length(m.message))::float8                             AS avg_length,
                max(m.created_at)                                          AS last_message_at
           FROM messages m
          WHERE m.org_id = $1`,
        [orgId, NEGATIVE_LEXICON, POSITIVE_LEXICON],
      ),
    );

    const row = rows[0];
    return {
      messages: Number(row.messages),
      negative: Number(row.negative),
      positive: Number(row.positive),
      recent: Number(row.recent),
      avgLength: row.avg_length ?? 0,
      lastMessageAt: row.last_message_at?.toISOString() ?? null,
      method: 'lexicon',
    };
  }
}
