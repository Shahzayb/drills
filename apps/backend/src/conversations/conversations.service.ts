import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantDb, TenantQuery } from '../tenancy/tenant-db.service';
import {
  ListConversationsQuery,
  SORT_COLUMNS,
} from './dto/list-conversations.query';

interface ConversationRow {
  id: string;
  status: string;
  assignee_id: string | null;
  created_at: Date;
  updated_at: Date;
  cursor_key?: string;
}

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

interface ConversationTagRow extends TagRow {
  conversation_id: string;
}

export interface ConversationSummary {
  id: string;
  status: string;
  assigneeId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationListItem extends ConversationSummary {
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

export interface ConversationCursorPage {
  items: ConversationListItem[];
  pageSize: number;
  nextCursor: string | null;
  hasMore: boolean;
}

interface CursorPayload {
  v: 1;
  k: string;
  i: string;
  f: string;
}

const CURSOR_VERSION = 1;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Filters {
  where: string;
  params: unknown[];
}

interface Paging extends Filters {
  limit: number;
  offset: number | null;
}

export interface MessageListItem {
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

type ListStrategy = 'naive' | 'batched';
export const LIST_STRATEGY: ListStrategy =
  process.env.LIST_STRATEGY === 'naive' ? 'naive' : 'batched';

export const KEYSET_TIEBREAK: 'on' | 'off' =
  process.env.KEYSET_TIEBREAK === 'off' ? 'off' : 'on';

@Injectable()
export class ConversationsService {
  constructor(private readonly tenants: TenantDb) {}

  async list(
    orgId: string,
    query: ListConversationsQuery,
  ): Promise<ConversationPage | ConversationCursorPage> {
    if (query.paging === 'offset' && query.cursor) {
      throw new BadRequestException(
        'cursor is only valid with paging=keyset; the offset arm uses page',
      );
    }

    const sortColumn = SORT_COLUMNS[query.sort];

    const paging = this.pagingFor(orgId, query, sortColumn);

    return this.tenants.withOrg(orgId, (tx) =>
      LIST_STRATEGY === 'naive'
        ? this.listNaive(tx, paging, query, sortColumn)
        : this.listBatched(tx, paging, query, sortColumn),
    );
  }

  private pagingFor(
    orgId: string,
    query: ListConversationsQuery,
    sortColumn: string,
  ): Paging {
    const filters = this.filtersFor(orgId, query);

    if (query.paging === 'offset') {
      return {
        where: filters.where,
        params: filters.params,
        limit: query.pageSize,
        offset: (query.page - 1) * query.pageSize,
      };
    }

    const params = [...filters.params];
    const clauses = [filters.where];

    if (query.cursor) {
      const { k, i } = this.decodeCursor(query.cursor, query);
      params.push(k);
      const key = `$${params.length}::timestamptz`;

      if (KEYSET_TIEBREAK === 'on') {
        params.push(i);
        clauses.push(
          `(c.${sortColumn}, c.id) < (${key}, $${params.length}::uuid)`,
        );
      } else {
        clauses.push(`c.${sortColumn} < ${key}`);
      }
    }

    return {
      where: clauses.join(' AND '),
      params,
      limit: query.pageSize + 1,
      offset: null,
    };
  }

  private filtersFor(orgId: string, query: ListConversationsQuery): Filters {
    const params: unknown[] = [orgId];
    const clauses = ['c.org_id = $1'];

    if (query.status) {
      params.push(query.status);
      clauses.push(`c.status = $${params.length}`);
    }
    if (query.updatedFrom) {
      params.push(query.updatedFrom);
      clauses.push(`c.updated_at >= $${params.length}::timestamptz`);
    }
    if (query.updatedTo) {
      params.push(query.updatedTo);
      clauses.push(`c.updated_at < $${params.length}::timestamptz`);
    }

    return { where: clauses.join(' AND '), params };
  }

  private async listNaive(
    tx: TenantQuery,
    paging: Paging,
    query: ListConversationsQuery,
    sortColumn: string,
  ): Promise<ConversationPage | ConversationCursorPage> {
    const [rows, count] = await Promise.all([
      tx.query<ConversationRow>(
        `SELECT c.id, c.status, c.assignee_id, c.created_at, c.updated_at
                ${this.cursorKeyColumn(paging, sortColumn)}
           FROM conversations c
          WHERE ${paging.where}
          ORDER BY c.${sortColumn} DESC, c.id DESC
          ${this.limitClause(paging)}`,
        this.limitParams(paging),
      ),
      this.countFor(tx, paging),
    ]);

    const page = this.slice(rows.rows, query);

    const items: ConversationListItem[] = [];
    for (const row of page.rows) {
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

    return this.toResult(items, page, count, query);
  }

  private async listBatched(
    tx: TenantQuery,
    paging: Paging,
    query: ListConversationsQuery,
    sortColumn: string,
  ): Promise<ConversationPage | ConversationCursorPage> {
    const [rows, count] = await Promise.all([
      tx.query<ConversationWithAssigneeRow>(
        `SELECT c.id, c.status, c.assignee_id, u.name AS assignee_name,
                c.created_at, c.updated_at
                ${this.cursorKeyColumn(paging, sortColumn)}
           FROM conversations c
           LEFT JOIN memberships m ON m.id = c.assignee_id
           LEFT JOIN users u       ON u.id = m.user_id
          WHERE ${paging.where}
          ORDER BY c.${sortColumn} DESC, c.id DESC
          ${this.limitClause(paging)}`,
        this.limitParams(paging),
      ),
      this.countFor(tx, paging),
    ]);

    const page = this.slice(rows.rows, query);
    const ids = page.rows.map((row) => row.id);
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

    const items = page.rows.map((row) =>
      toItem(row, row.assignee_name, tagsByConversation.get(row.id) ?? []),
    );

    return this.toResult(items, page, count, query);
  }

  private cursorKeyColumn(paging: Paging, sortColumn: string): string {
    if (paging.offset !== null) return '';
    return `, to_char(c.${sortColumn} AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_key`;
  }

  private limitClause(paging: Paging): string {
    const limit = `LIMIT $${paging.params.length + 1}`;
    return paging.offset === null
      ? limit
      : `${limit} OFFSET $${paging.params.length + 2}`;
  }

  private limitParams(paging: Paging): unknown[] {
    return paging.offset === null
      ? [...paging.params, paging.limit]
      : [...paging.params, paging.limit, paging.offset];
  }

  private countFor(
    tx: TenantQuery,
    paging: Paging,
  ): Promise<{ rows: { total: string }[] } | null> {
    if (paging.offset === null) return Promise.resolve(null);
    return tx.query<{ total: string }>(
      `SELECT count(*) AS total FROM conversations c WHERE ${paging.where}`,
      paging.params,
    );
  }

  private slice<T>(
    rows: T[],
    query: ListConversationsQuery,
  ): { rows: T[]; hasMore: boolean } {
    if (query.paging === 'offset') return { rows, hasMore: false };
    const hasMore = rows.length > query.pageSize;
    return { rows: hasMore ? rows.slice(0, query.pageSize) : rows, hasMore };
  }

  private toResult(
    items: ConversationListItem[],
    page: { rows: ConversationRow[]; hasMore: boolean },
    count: { rows: { total: string }[] } | null,
    query: ListConversationsQuery,
  ): ConversationPage | ConversationCursorPage {
    if (count === null) {
      const last = page.rows[page.rows.length - 1];
      return {
        items,
        pageSize: query.pageSize,
        hasMore: page.hasMore,
        nextCursor:
          page.hasMore && last ? this.encodeCursor(last, query) : null,
      };
    }

    const total = Number(count.rows[0].total);
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  private fingerprint(query: ListConversationsQuery): string {
    return [
      query.sort,
      query.status ?? '',
      query.updatedFrom ?? '',
      query.updatedTo ?? '',
    ].join('|');
  }

  private encodeCursor(
    row: ConversationRow,
    query: ListConversationsQuery,
  ): string {
    const payload: CursorPayload = {
      v: CURSOR_VERSION,
      k: row.cursor_key!,
      i: row.id,
      f: this.fingerprint(query),
    };
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  private decodeCursor(
    cursor: string,
    query: ListConversationsQuery,
  ): CursorPayload {
    let payload: Partial<CursorPayload>;
    try {
      payload = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      ) as Partial<CursorPayload>;
    } catch {
      throw new BadRequestException('cursor is not decodable');
    }

    if (payload?.v !== CURSOR_VERSION) {
      throw new BadRequestException(
        `cursor version ${String(payload?.v)} is not supported`,
      );
    }
    if (typeof payload.k !== 'string' || Number.isNaN(Date.parse(payload.k))) {
      throw new BadRequestException('cursor key is not a timestamp');
    }
    if (typeof payload.i !== 'string' || !UUID_PATTERN.test(payload.i)) {
      throw new BadRequestException('cursor id is not a uuid');
    }
    if (payload.f !== this.fingerprint(query)) {
      throw new BadRequestException(
        'cursor was issued for a different sort or filter; start again from the first page',
      );
    }

    return payload as CursorPayload;
  }

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
    if (!row) throw new NotFoundException('conversation not found');

    return toSummary(row);
  }

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

  async remove(orgId: string, id: string): Promise<void> {
    const result = await this.tenants.withOrg(orgId, (tx) =>
      tx.query(`DELETE FROM conversations WHERE id = $1`, [id]),
    );

    if (result.rowCount === 0) {
      throw new NotFoundException('conversation not found');
    }
  }

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
