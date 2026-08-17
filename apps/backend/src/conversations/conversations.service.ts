import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantDb, TenantQuery } from '../tenancy/tenant-db.service';
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

/** What the batched list query returns — the naive path's row plus the name a
 *  LEFT JOIN already carried, instead of a lookup per row. */
interface ConversationWithAssigneeRow extends ConversationRow {
  assignee_name: string | null;
}

interface MessageRow {
  id: string;
  message: string;
  created_at: Date;
}

interface TagRow {
  id: string;
  name: string;
}

/** Which conversation a batched tag row belongs to — TagRow plus the join key
 *  that groups it back onto its conversation in JS. */
interface ConversationTagRow extends TagRow {
  conversation_id: string;
}

/**
 * The API's shape: camelCase, timestamps as ISO strings.
 *
 * Kept separate from ConversationRow on purpose. The moment a column name
 * reaches a JSON body, renaming the column is a breaking API change.
 *
 * What `get()`, `updateStatus()` and `remove()` return — unchanged by card 08.
 * The plan is explicit that those three stay out of scope, and that has to
 * mean their *shape* too: filling assigneeName/tags in in TypeScript with
 * `null`/`[]` for a conversation that may genuinely have both would be a
 * silent lie, not a smaller response. See
 * plans/2026-08-17_drill-08-n-plus-one.md.
 */
export interface ConversationSummary {
  id: string;
  status: string;
  // bigint. `pg` returns int8 as a string because a bigint can exceed
  // Number.MAX_SAFE_INTEGER, and a JS number would round it without saying so.
  // It stays a string all the way out.
  assigneeId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The list's richer shape — everything ConversationSummary has, plus what
 *  card 08 added. Only `list()` returns this. */
export interface ConversationListItem extends ConversationSummary {
  // null both when unassigned and when the membership backing assignee_id was
  // itself removed — the FK stays valid either way, this just has nothing to
  // show. Kept alongside assigneeId rather than replacing it: the id is a
  // stable key a client can use, the name is display-only.
  assigneeName: string | null;
  tags: TagItem[];
}

export interface TagItem {
  id: string;
  name: string;
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

const toSummary = (row: ConversationRow): ConversationSummary => ({
  id: row.id,
  status: row.status,
  assigneeId: row.assignee_id,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const toItem = (
  row: ConversationRow,
  assigneeName: string | null,
  tags: TagItem[],
): ConversationListItem => ({
  ...toSummary(row),
  assigneeName,
  tags,
});

const toMessage = (row: MessageRow): MessageListItem => ({
  id: row.id,
  message: row.message,
  createdAt: row.created_at.toISOString(),
});

/**
 * Which `list()` body runs. Read once at module load, same reasoning as
 * TRACING_ENABLED — a deployment-time switch, not a per-request one.
 *
 * Both arms are the same commit: drill 07's rule is that an A/B's arms must
 * differ only in the variable, not in whether the process restarted, and
 * `naive` is also the query-budget test's required red case — a budget test
 * that has never been seen to fail is decoration. See
 * plans/2026-08-17_drill-08-n-plus-one.md.
 */
type ListStrategy = 'naive' | 'batched';
const LIST_STRATEGY: ListStrategy =
  process.env.LIST_STRATEGY === 'naive' ? 'naive' : 'batched';

@Injectable()
export class ConversationsService {
  constructor(private readonly tenants: TenantDb) {}

  /**
   * LIMIT/OFFSET paging, no cursor, no cache — still naive by cards 09 and
   * 10's reckoning; see plans/2026-08-09_drill-03-conversation-list.md before
   * "improving" either.
   *
   * Card 08 is the part of this endpoint that is no longer naive: dispatches
   * to `listBatched` (one LEFT JOIN for the assignee, one batched query for
   * tags) or, behind `LIST_STRATEGY=naive`, to `listNaive` (a lookup per row,
   * written the way the feature request reads). See
   * plans/2026-08-17_drill-08-n-plus-one.md.
   *
   * This one keeps its explicit `WHERE org_id = $1` where the four below have
   * none. Two reasons: it is the query drill 05 baselined and card 09
   * compares against, and a belt-and-braces filter on the one hot path is a
   * defensible production choice even with policies underneath.
   *
   * `@QueryBudget(3)` lives on the *controller's* handler, not here — see
   * conversations.controller.ts. LoggingInterceptor reads metadata off
   * `ExecutionContext.getHandler()`, which is the route handler Nest actually
   * invoked; a decorator on this service method would sit on a different
   * function object and Reflector would silently fall through to the default.
   * Found by testing the naive arm, not by reading the code.
   */
  async list(
    orgId: string,
    query: ListConversationsQuery,
  ): Promise<ConversationPage> {
    // Safe to interpolate only because it came out of SORT_COLUMNS, never off
    // the request. org_id is still a bind parameter, as every *value* must be.
    const sortColumn = SORT_COLUMNS[query.sort];

    return this.tenants.withOrg(orgId, (tx) =>
      LIST_STRATEGY === 'naive'
        ? this.listNaive(tx, orgId, query, sortColumn)
        : this.listBatched(tx, orgId, query, sortColumn),
    );
  }

  /**
   * The feature written the way it is easy to write: fetch the page, then for
   * every row, a lookup for its assignee's name and a lookup for its tags.
   * Sequential `await`s in a loop, not `Promise.all` — the naive version is
   * naive, and on the one pinned connection `withOrg` hands out, `pg` would
   * queue concurrent calls anyway. At pageSize=50 with the seed's ~80%
   * assignment rate this is ~1 + 1 + ~40 + 50 ≈ 92 statements; at the k6
   * baseline's pageSize=20 it is ~38. Do not "fix" this in place —
   * `LIST_STRATEGY=batched` is the fix, and this stays so the A/B and the
   * budget test's red case keep working.
   */
  private async listNaive(
    tx: TenantQuery,
    orgId: string,
    query: ListConversationsQuery,
    sortColumn: string,
  ): Promise<ConversationPage> {
    const { page, pageSize } = query;
    const offset = (page - 1) * pageSize;

    const [rows, count] = await Promise.all([
      tx.query<ConversationRow>(
        `SELECT id, status, assignee_id, created_at, updated_at
           FROM conversations
          WHERE org_id = $1
          ORDER BY ${sortColumn} DESC, id DESC
          LIMIT $2 OFFSET $3`,
        [orgId, pageSize, offset],
      ),
      tx.query<{ total: string }>(
        `SELECT count(*) AS total FROM conversations WHERE org_id = $1`,
        [orgId],
      ),
    ]);

    const items: ConversationListItem[] = [];
    for (const row of rows.rows) {
      let assigneeName: string | null = null;
      if (row.assignee_id) {
        const assignee = await tx.query<{ name: string }>(
          `SELECT u.name
             FROM memberships m
             JOIN users u ON u.id = m.user_id
            WHERE m.id = $1`,
          [row.assignee_id],
        );
        assigneeName = assignee.rows[0]?.name ?? null;
      }

      const tags = await tx.query<TagRow>(
        `SELECT t.id, t.name
           FROM conversation_tags ct
           JOIN tags t ON t.id = ct.tag_id
          WHERE ct.conversation_id = $1
          ORDER BY t.name`,
        [row.id],
      );

      items.push(toItem(row, assigneeName, tags.rows));
    }

    return this.toPage(items, count, page, pageSize);
  }

  /**
   * The fix: 3 statements regardless of page size, not 1 + N.
   *
   * The assignee is a LEFT JOIN, not INNER — the seed leaves ~20% of
   * conversations unassigned, and an inner join would silently drop them from
   * the page rather than show them with no assignee, which is how this
   * "optimisation" ships as a data-loss bug. Every joined column is qualified
   * for the same reason `users` has its own `created_at`/`updated_at`: an
   * unqualified `ORDER BY updated_at` would be ambiguous the moment a second
   * table in the join has a column by that name.
   *
   * Tags are one query for the whole page, keyed by every id already on it —
   * skipped entirely when the page is empty, so an empty page is 2 statements
   * and not 3: `= ANY($1)` over an empty array is legal SQL but still a round
   * trip nobody needed to make.
   */
  private async listBatched(
    tx: TenantQuery,
    orgId: string,
    query: ListConversationsQuery,
    sortColumn: string,
  ): Promise<ConversationPage> {
    const { page, pageSize } = query;
    const offset = (page - 1) * pageSize;

    // Still Promise.all, and it no longer buys concurrency: both statements
    // run on the one client the scope pinned, so `pg` queues them. That is a
    // real cost against drill 05's baseline and it is measured in
    // plans/2026-08-15_drill-07-tenant-isolation.md rather than assumed away.
    // It also halves this endpoint's connection demand, which drill 05 found
    // oversubscribed 2:1 — the two effects pull in opposite directions.
    const [rows, count] = await Promise.all([
      tx.query<ConversationWithAssigneeRow>(
        `SELECT c.id, c.status, c.assignee_id, u.name AS assignee_name,
                c.created_at, c.updated_at
           FROM conversations c
           LEFT JOIN memberships m ON m.id = c.assignee_id
           LEFT JOIN users u       ON u.id = m.user_id
          WHERE c.org_id = $1
          ORDER BY c.${sortColumn} DESC, c.id DESC
          LIMIT $2 OFFSET $3`,
        [orgId, pageSize, offset],
      ),
      // The first thing expected to fall over. Postgres cannot shortcut
      // count(*): MVCC makes visibility per-row, so this reads every matching
      // row on every request. Free at 24 rows, the whole cost of the page at
      // 2.5M. Not this card's problem — card 09 is where this changes.
      tx.query<{ total: string }>(
        `SELECT count(*) AS total FROM conversations WHERE org_id = $1`,
        [orgId],
      ),
    ]);

    const ids = rows.rows.map((row) => row.id);
    const tagsByConversation = new Map<string, TagItem[]>();
    if (ids.length > 0) {
      const tagRows = await tx.query<ConversationTagRow>(
        `SELECT ct.conversation_id, t.id, t.name
           FROM conversation_tags ct
           JOIN tags t ON t.id = ct.tag_id
          WHERE ct.conversation_id = ANY($1::uuid[])
          ORDER BY ct.conversation_id, t.name`,
        [ids],
      );
      for (const tagRow of tagRows.rows) {
        const list = tagsByConversation.get(tagRow.conversation_id) ?? [];
        list.push({ id: tagRow.id, name: tagRow.name });
        tagsByConversation.set(tagRow.conversation_id, list);
      }
    }

    const items = rows.rows.map((row) =>
      toItem(row, row.assignee_name, tagsByConversation.get(row.id) ?? []),
    );

    return this.toPage(items, count, page, pageSize);
  }

  private toPage(
    items: ConversationListItem[],
    count: { rows: { total: string }[] },
    page: number,
    pageSize: number,
  ): ConversationPage {
    // One transaction, so the list and count queries share a snapshot and
    // `total` can no longer disagree with `items`. That consistency was not
    // the goal — it is a side effect of needing a transaction for
    // `set_config` — and worth naming so nobody later "optimises" the
    // transaction away and quietly reintroduces the skew.
    const total = Number(count.rows[0].total);
    return {
      items,
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
  async get(orgId: string, id: string): Promise<ConversationSummary> {
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

    return toSummary(row);
  }

  /** "You can only reach it from the list, and the list is scoped." */
  async updateStatus(
    orgId: string,
    id: string,
    status: 'open' | 'closed',
  ): Promise<ConversationSummary> {
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

    return toSummary(row);
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
