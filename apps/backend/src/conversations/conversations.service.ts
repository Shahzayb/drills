import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantDb } from '../tenancy/tenant-db.service';
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

interface MessageRow {
  id: string;
  message: string;
  created_at: Date;
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

export interface MessageListItem {
  // bigserial. A string all the way out, same reasoning as assigneeId above.
  id: string;
  message: string;
  createdAt: string;
}

const toItem = (row: ConversationRow): ConversationListItem => ({
  id: row.id,
  status: row.status,
  assigneeId: row.assignee_id,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const toMessage = (row: MessageRow): MessageListItem => ({
  id: row.id,
  message: row.message,
  createdAt: row.created_at.toISOString(),
});

@Injectable()
export class ConversationsService {
  constructor(private readonly tenants: TenantDb) {}

  /**
   * Naive on purpose — LIMIT/OFFSET, no joins, no cursor, no cache. Cards 08,
   * 09 and 10 each break one specific thing here; see
   * plans/2026-08-09_drill-03-conversation-list.md before "improving" it.
   *
   * This one keeps its explicit `WHERE org_id = $1` where the four below have
   * none. Two reasons: it is the query drill 05 baselined and cards 08/09/10
   * compare against, and a belt-and-braces filter on the one hot path is a
   * defensible production choice even with policies underneath.
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

    const [rows, count] = await this.tenants.withOrg(orgId, (tx) =>
      // Still Promise.all, and it no longer buys concurrency: both statements
      // now run on the one client the scope pinned, so `pg` queues them. That
      // is a real cost against drill 05's baseline and it is measured in
      // plans/2026-08-15_drill-07-tenant-isolation.md rather than assumed away.
      // It also halves this endpoint's connection demand, which drill 05 found
      // oversubscribed 2:1 — the two effects pull in opposite directions.
      Promise.all([
        tx.query<ConversationRow>(
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
        tx.query<{ total: string }>(
          `SELECT count(*) AS total FROM conversations WHERE org_id = $1`,
          [orgId],
        ),
      ]),
    );

    // One transaction now, so the two statements share a snapshot and `total`
    // can no longer disagree with `items`. That consistency was not the goal —
    // it is a side effect of needing a transaction for `set_config`, and worth
    // naming so nobody later "optimises" the transaction away and quietly
    // reintroduces the skew.
    const total = Number(count.rows[0].total);

    return {
      items: rows.rows.map(toItem),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  // ---------------------------------------------------------------------------
  // The four below pass `orgId` to withOrg and put no org filter in their SQL.
  //
  // That is deliberate and it is the point of the drill. Every one of these was
  // written with an excuse somebody has actually made in review, and each would
  // have leaked one customer's inbox to another. What makes them safe is the
  // row-level security policy in migration 003 — not the author's memory.
  //
  // **Do not add `AND org_id = $n` here.** These four are scoped by the
  // mechanism and by nothing else, which is what makes "remove the policies and
  // watch the suite go red" a proof rather than a claim. The run where exactly
  // that was done is recorded in
  // plans/2026-08-15_drill-07-tenant-isolation.md.
  // ---------------------------------------------------------------------------

  /** "The id is a uuid, you cannot guess it." You do not have to guess a uuid
   *  you were shown — by a shared link, a support ticket, or a leaky list. */
  async get(orgId: string, id: string): Promise<ConversationListItem> {
    const result = await this.tenants.withOrg(orgId, (tx) =>
      tx.query<ConversationRow>(
        `SELECT id, status, assignee_id, created_at, updated_at
           FROM conversations
          WHERE id = $1`,
        [id],
      ),
    );

    const row = result.rows[0];
    // 404, not 403. A 403 confirms the row exists, which turns this endpoint
    // into an oracle: a competitor can size your inbox by probing ids. The
    // caller gets the same answer for "no such row" and "not yours".
    if (!row) throw new NotFoundException('conversation not found');

    return toItem(row);
  }

  /** "You can only reach it from the list, and the list is scoped." */
  async updateStatus(
    orgId: string,
    id: string,
    status: 'open' | 'closed',
  ): Promise<ConversationListItem> {
    const result = await this.tenants.withOrg(orgId, (tx) =>
      tx.query<ConversationRow>(
        `UPDATE conversations
            SET status = $2, updated_at = now()
          WHERE id = $1
      RETURNING id, status, assignee_id, created_at, updated_at`,
        [id, status],
      ),
    );

    const row = result.rows[0];
    if (!row) throw new NotFoundException('conversation not found');

    return toItem(row);
  }

  /** Same excuse as the update, and the worse blast radius. */
  async remove(orgId: string, id: string): Promise<void> {
    const result = await this.tenants.withOrg(orgId, (tx) =>
      tx.query(`DELETE FROM conversations WHERE id = $1`, [id]),
    );

    if (result.rowCount === 0) {
      throw new NotFoundException('conversation not found');
    }
  }

  /**
   * "The parent lookup already scoped it."
   *
   * It did not. The join reaches `messages` — a tenant-owned table with its own
   * `org_id` — through `conversations`, and neither side is filtered. This is
   * the one whose SQL looks *correct* to a reviewer: there is a join to the
   * scoped table right there in the query, so the eye reads it as scoping.
   */
  async listMessages(orgId: string, id: string): Promise<MessageListItem[]> {
    return this.tenants.withOrg(orgId, async (tx) => {
      const exists = await tx.query<{ id: string }>(
        `SELECT id FROM conversations WHERE id = $1`,
        [id],
      );

      if (exists.rowCount === 0) {
        throw new NotFoundException('conversation not found');
      }

      const result = await tx.query<MessageRow>(
        `SELECT m.id, m.message, m.created_at
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
          WHERE m.conversation_id = $1
          ORDER BY m.created_at ASC, m.id ASC
          LIMIT 50`,
        [id],
      );

      return result.rows.map(toMessage);
    });
  }
}
