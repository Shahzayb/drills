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

/** The database's shape: snake_case, and bigints arriving as strings. */
interface ConversationRow {
  id: string;
  status: string;
  assignee_id: string | null;
  created_at: Date;
  updated_at: Date;
  /**
   * The sort key rendered by *Postgres*, selected only on the keyset arm.
   *
   * It exists because `pg` hands back `timestamptz` as a JS `Date`, and a
   * `Date` holds milliseconds while Postgres stores **microseconds**. Building
   * a cursor from `updated_at.toISOString()` therefore names an instant a few
   * hundred microseconds *earlier* than the row it came from — and the next
   * page's `(updated_at, id) < ($k, $i)` then silently drops every row tied on
   * the untruncated value. Rows vanish, no error anywhere.
   *
   * Caught by the tie-block test and by nothing else: the seed's timestamps are
   * all whole seconds, so the truncation is a no-op against 2.5M rows and only
   * the fixtures, which use `now()`, ever have microseconds to lose. See
   * plans/2026-08-26_drill-10-keyset-pagination.md.
   */
  cursor_key?: string;
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

/**
 * What the keyset arm returns, and what it deliberately does not.
 *
 * No `total`, no `totalPages`, no `page`. That absence is the drill: a count is
 * the other half of what makes a deep page expensive, and paying for one here
 * would hand back exactly the cost the cursor was added to remove. A client
 * that needs "page 12 of 480" has to use `paging=offset` — which is the honest
 * answer, and the reason that arm still exists.
 *
 * `hasMore` costs nothing: the page query asks for `pageSize + 1` rows and
 * throws the extra away. See plans/2026-08-26_drill-10-keyset-pagination.md.
 */
export interface ConversationCursorPage {
  items: ConversationListItem[];
  pageSize: number;
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * What an opaque cursor carries, before base64url.
 *
 * `v` is the version. It is the whole point of making the cursor opaque: the
 * key columns can change in a later release and old cursors can be rejected
 * (or migrated) by version rather than by guessing at their shape.
 *
 * `f` is the query-shape fingerprint — sort column and every filter. A cursor
 * minted under `sort=updated_at` and replayed under `sort=created_at` names a
 * position in an ordering that no longer exists, and the rows that come back
 * are wrong in a way nothing downstream can detect. With `f` it is a 400.
 *
 * Not signed. base64url is an encoding, not encryption, and anyone can decode
 * this in one line — the plan file says so rather than implying otherwise.
 */
interface CursorPayload {
  v: 1;
  // The sort column's value on the last row of the previous page, exactly as
  // Postgres rendered it — microseconds included. Never via a JS Date; see
  // ConversationRow.cursor_key for what that costs.
  k: string;
  // That row's id — the tiebreaker, and the reason this is a *pair*.
  i: string;
  f: string;
}

const CURSOR_VERSION = 1;

/** The id in a cursor reaches Postgres as `::uuid`; a malformed one would be a
 *  500 (`22P02`) instead of the 400 it is. Same reasoning as ParseUUIDPipe on
 *  the `:id` routes. */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A WHERE clause and the bind values its placeholders refer to, in order. */
interface Filters {
  where: string;
  params: unknown[];
}

/** `Filters` after the paging arm has had its say — see `pagingFor`. A null
 *  `offset` is what "this is the keyset arm" means everywhere below. */
interface Paging extends Filters {
  limit: number;
  offset: number | null;
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

/**
 * Whether the keyset predicate carries the `id` tiebreaker.
 *
 * `off` drops it, leaving `sort_col < $k` — which skips every row still tied on
 * the value the cursor names. Read once at module load, same as LIST_STRATEGY
 * and for the same reason: an arm that requires a different checkout measures
 * the checkout, not the variable (drill 07).
 *
 * This exists so `pnpm db:test:notiebreak` can go red on purpose. A correctness
 * argument nobody has watched fail is a claim, not a proof.
 */
const KEYSET_TIEBREAK: 'on' | 'off' =
  process.env.KEYSET_TIEBREAK === 'off' ? 'off' : 'on';

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
   * This one keeps its explicit `WHERE c.org_id = $1` where the four below
   * have none. Two reasons: it is the query drill 05 baselined and card 09
   * compares against, and a belt-and-braces filter on the one hot path is a
   * defensible production choice even with policies underneath.
   *
   * Card 09 adds the optional status filter and `updated_at` range, and the
   * composite index in migration 005 that serves them. Both arms get the same
   * WHERE from `filtersFor` — see it for why that is built once.
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
  ): Promise<ConversationPage | ConversationCursorPage> {
    // Rejected here rather than in the DTO. `@ValidateIf` reads like a guard
    // and is the opposite of one — it *skips* the validators when its condition
    // is false, so `paging=offset&cursor=…` would have been accepted and then
    // quietly ignored. Two arms have to stay two arms.
    if (query.paging === 'offset' && query.cursor) {
      throw new BadRequestException(
        'cursor is only valid with paging=keyset; the offset arm uses page',
      );
    }

    // Safe to interpolate only because it came out of SORT_COLUMNS, never off
    // the request. org_id is still a bind parameter, as every *value* must be.
    const sortColumn = SORT_COLUMNS[query.sort];

    const paging = this.pagingFor(orgId, query, sortColumn);

    return this.tenants.withOrg(orgId, (tx) =>
      LIST_STRATEGY === 'naive'
        ? this.listNaive(tx, paging, query, sortColumn)
        : this.listBatched(tx, paging, query, sortColumn),
    );
  }

  /**
   * Everything that differs between the two paging arms, resolved once, so the
   * two list bodies below stay two bodies rather than four.
   *
   * The keyset arm's whole mechanism is three lines of it:
   *
   *   - a row comparison `(sort_col, id) < ($k, $i)` instead of an OFFSET,
   *   - `LIMIT pageSize + 1` so `hasMore` needs no second query,
   *   - and no count query at all.
   *
   * **Why a row constructor and not `a < $k OR (a = $k AND b < $i)`.** They are
   * logically identical and are not planned identically: Postgres understands
   * `ROW(a,b) < ROW(x,y)` as one lexicographic comparison and can turn it into
   * a single multicolumn btree `Index Cond`, where the OR form typically
   * degenerates into a filter or a BitmapOr over two ranges. `pnpm db:explain
   * keyset` is what checks that claim rather than repeating it.
   *
   * The comparison direction is `<` because the ordering is `DESC, DESC` — the
   * next page is the rows that sort *after* the cursor, which under DESC means
   * smaller. Flip the ORDER BY and this has to flip with it; they are one
   * decision written in two places, which is exactly the kind of pair that
   * rots, hence this note.
   */
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
        // The broken arm, on purpose: "strictly older" excludes every row still
        // tied on the cursor's own timestamp, so the rest of a tie block is
        // skipped. `pnpm db:test:notiebreak` is the red run.
        //
        // `i` is deliberately not bound here. It is not just unused — Postgres
        // rejects a bind with more parameters than the statement references, so
        // pushing it would make this arm a 500 instead of the *silently wrong
        // answer* the drill is about. A crash would be the easy bug.
        clauses.push(`c.${sortColumn} < ${key}`);
      }
    }

    return {
      where: clauses.join(' AND '),
      params,
      // The +1 row is the whole cost of knowing whether there is a next page.
      // A count query would answer the same question and read every matching
      // row to do it.
      limit: query.pageSize + 1,
      offset: null,
    };
  }

  /**
   * The WHERE the page query and the count query both run, built once.
   *
   * Built once because the alternative is the bug this card is most likely to
   * ship: filter the page and forget the count, and `total`/`totalPages`
   * describe a different result set than `items` — a pager that promises 12
   * pages of a 3-page list, with no error anywhere.
   *
   * Every statement that uses this aliases `conversations` as `c`, including
   * the two count queries and the naive arm's page query, which had no alias
   * before. That is the entire reason the alias exists: one string has to be
   * valid in all three places.
   *
   * The date bounds are half-open — `>= from` and `< to`. A `<=` upper bound on
   * a timestamptz makes "up to the 25th" include the first instant of the 26th,
   * so two adjacent ranges both claim the boundary row.
   *
   * See plans/2026-08-25_drill-09-index-selectivity.md.
   */
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
    paging: Paging,
    query: ListConversationsQuery,
    sortColumn: string,
  ): Promise<ConversationPage | ConversationCursorPage> {
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
                ${this.cursorKeyColumn(paging, sortColumn)}
           FROM conversations c
           LEFT JOIN memberships m ON m.id = c.assignee_id
           LEFT JOIN users u       ON u.id = m.user_id
          WHERE ${paging.where}
          ORDER BY c.${sortColumn} DESC, c.id DESC
          ${this.limitClause(paging)}`,
        this.limitParams(paging),
      ),
      // Postgres cannot shortcut count(*): MVCC makes visibility per-row, so
      // this reads every matching row on every request. Free at 24 rows, the
      // whole cost of the page at 2.5M. Card 09's index makes it an index-only
      // scan rather than a heap scan — cheaper, still linear in matching rows.
      // Card 10's keyset arm is the one that finally drops it: `countFor`
      // returns null there and this is 2 statements, not 3.
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

  /**
   * The extra select-list column the keyset arm needs, and the offset arm does
   * not get — so the query drill 05 baselined stays the query drill 05
   * baselined.
   *
   * `to_char(... AT TIME ZONE 'UTC', ...)` rather than `::text` because the
   * plain cast renders through the session's `DateStyle`, and a cursor whose
   * format depends on a session setting is a cursor that breaks when someone
   * changes one. `.US` is six digits of fraction — the full precision the
   * column actually holds.
   */
  private cursorKeyColumn(paging: Paging, sortColumn: string): string {
    if (paging.offset !== null) return '';
    return `, to_char(c.${sortColumn} AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_key`;
  }

  /** `LIMIT $n` on the keyset arm, `LIMIT $n OFFSET $n+1` on the offset one. */
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

  /**
   * The count query, or nothing at all.
   *
   * Returning `null` rather than running a cheaper count is the point: the
   * keyset arm has no `total` to report, so there is no query to make cheap.
   * This is also why the endpoint drops from 3 statements to 2 on that arm.
   */
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

  /**
   * Trims the keyset arm's extra row off, and remembers that it was there.
   *
   * The offset arm asked for exactly `pageSize` and learns nothing from getting
   * it — `hasMore` there comes from `total`.
   */
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
        // Null on the last page, so "no more" is one check and not two. A
        // cursor pointing past the end would still be *correct* — it returns an
        // empty page — but it invites a client to keep asking.
        nextCursor:
          page.hasMore && last ? this.encodeCursor(last, query) : null,
      };
    }

    // One transaction, so the list and count queries share a snapshot and
    // `total` can no longer disagree with `items`. That consistency was not
    // the goal — it is a side effect of needing a transaction for
    // `set_config` — and worth naming so nobody later "optimises" the
    // transaction away and quietly reintroduces the skew.
    const total = Number(count.rows[0].total);
    return {
      items,
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  /**
   * The query shape a cursor belongs to: sort column and every filter.
   *
   * A cursor names a position in an ordering. Replay it against a different
   * ordering or a different filter set and the position is meaningless — the
   * rows that come back are wrong, and nothing downstream can tell. Carrying
   * the shape turns that silent wrongness into a 400.
   *
   * Plain text, not a hash: without a secret a hash hides nothing a base64
   * decode would not reveal, and the readable version makes the error message
   * useful.
   */
  private fingerprint(query: ListConversationsQuery): string {
    return [
      query.sort,
      query.status ?? '',
      query.updatedFrom ?? '',
      query.updatedTo ?? '',
    ].join('|');
  }

  /**
   * base64url over JSON. Opaque, not secret — see CursorPayload.
   *
   * What opacity buys: the key columns are not an API contract, so they can
   * change behind `v`; a client cannot hand-assemble a half-valid position; and
   * the fingerprint travels with it. What it does not buy is tamper-proofing —
   * anyone can decode and re-encode this. An HMAC is what that would take, and
   * it is a stated gap rather than a pretend one.
   */
  private encodeCursor(
    row: ConversationRow,
    query: ListConversationsQuery,
  ): string {
    const payload: CursorPayload = {
      v: CURSOR_VERSION,
      // `cursor_key`, never `row.updated_at.toISOString()`. The Date lost the
      // microseconds before this line ever ran.
      k: row.cursor_key!,
      i: row.id,
      f: this.fingerprint(query),
    };
    return Buffer.from(JSON.stringify(payload)).toString('base64url');
  }

  /**
   * One message per cause. A single "invalid cursor" would make the
   * fingerprint rule — the interesting one — impossible to learn from the API.
   */
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
    // Date.parse only as a *shape* check — it truncates to milliseconds, so its
    // result is deliberately thrown away and `k` is passed to Postgres verbatim.
    if (typeof payload.k !== 'string' || Number.isNaN(Date.parse(payload.k))) {
      throw new BadRequestException('cursor key is not a timestamp');
    }
    if (typeof payload.i !== 'string' || !UUID_PATTERN.test(payload.i)) {
      throw new BadRequestException('cursor id is not a uuid');
    }
    // The whole reason the fingerprint is in there. Changing `sort` or a filter
    // mid-walk is a new query, and the old position does not describe it.
    if (payload.f !== this.fingerprint(query)) {
      throw new BadRequestException(
        'cursor was issued for a different sort or filter; start again from the first page',
      );
    }

    return payload as CursorPayload;
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
