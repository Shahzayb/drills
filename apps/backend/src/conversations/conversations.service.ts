import { Injectable } from '@nestjs/common';
import { PostgresService } from '../postgres/postgres.service';
import {
  ListConversationsQuery,
  SORT_COLUMNS,
} from './dto/list-conversations.query';

/** The database's shape: snake_case, and bigints arriving as strings. */
interface ConversationRow {
  id: string;
  status: string;
  assignee_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * The API's shape: camelCase, timestamps as ISO strings.
 *
 * Kept separate from ConversationRow on purpose. The moment a column name
 * reaches a JSON body, renaming the column is a breaking API change.
 */
export interface ConversationListItem {
  id: string;
  status: string;
  // bigint. `pg` returns int8 as a string because a bigint can exceed
  // Number.MAX_SAFE_INTEGER, and a JS number would round it without saying so.
  // It stays a string all the way out.
  assigneeId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationPage {
  items: ConversationListItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

const toItem = (row: ConversationRow): ConversationListItem => ({
  id: row.id,
  status: row.status,
  assigneeId: row.assignee_id,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

@Injectable()
export class ConversationsService {
  constructor(private readonly postgres: PostgresService) {}

  /**
   * Naive on purpose — LIMIT/OFFSET, no joins, no cursor, no cache. Cards 08,
   * 09 and 10 each break one specific thing here; see
   * plans/2026-08-09_drill-03-conversation-list.md before "improving" it.
   */
  async list(
    orgId: string,
    query: ListConversationsQuery,
  ): Promise<ConversationPage> {
    const { page, pageSize } = query;
    const offset = (page - 1) * pageSize;

    // Safe to interpolate only because it came out of SORT_COLUMNS, never off
    // the request. org_id is still a bind parameter, as every *value* must be.
    const sortColumn = SORT_COLUMNS[query.sort];

    const [rows, count] = await Promise.all([
      this.postgres.query<ConversationRow>(
        `SELECT id, status, assignee_id, created_at, updated_at
           FROM conversations
          WHERE org_id = $1
          ORDER BY ${sortColumn} DESC, id DESC
          LIMIT $2 OFFSET $3`,
        [orgId, pageSize, offset],
      ),
      // The first thing expected to fall over. Postgres cannot shortcut
      // count(*): MVCC makes visibility per-row, so this reads every matching
      // row on every request. Free at 24 rows, the whole cost of the page at
      // 2.5M. It stays until card 08 makes removing it mean something.
      this.postgres.query<{ total: string }>(
        `SELECT count(*) AS total FROM conversations WHERE org_id = $1`,
        [orgId],
      ),
    ]);

    // Two separate statements means two snapshots: a row inserted between them
    // can make `total` disagree with `items`. Acceptable for a list, and not
    // fixable by ordering the queries differently — only by one transaction.
    const total = Number(count.rows[0].total);

    return {
      items: rows.rows.map(toItem),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }
}
