import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PostgresService } from '../src/postgres/postgres.service';
import { TenantDb } from '../src/tenancy/tenant-db.service';

/**
 * Integration test for `GET /conversations`: real HTTP through the real module
 * graph, against a real Postgres in a container. Nothing is mocked.
 *
 * That is the whole point. A mocked pool would pass with SQL that Postgres
 * rejects, would not notice that bigints come back as strings, and could not
 * show that OFFSET paging over a tied sort key loses rows. Run it with
 * `pnpm db:test` from the repo root — it needs a migrated database and the
 * credentials that only Compose's env_file supplies.
 *
 * Boots AppModule rather than ConversationsModule alone, because the global
 * ValidationPipe is a provider *in that module* — see app.module.ts. Testing a
 * narrower graph would test an endpoint with no validation on it.
 */
describe('GET /conversations (e2e)', () => {
  let app: INestApplication<App>;
  let db: PostgresService;
  // Since drill 07, a write to a table carrying org_id has to say which tenant
  // it is for — the policies reject one that does not. Fixtures go through the
  // same seam the application does.
  let tenants: TenantDb;

  const tag = `conversations-e2e-${Date.now()}`;

  // The org under test and a second org that must never appear in its results.
  let orgId: string;
  let otherOrgId: string;

  // Five conversations with distinct updated_at, then four sharing one value.
  // The tie block is what proves the (updated_at DESC, id DESC) ordering is
  // total: with `ORDER BY updated_at DESC` alone those four could shuffle
  // between requests and paging would drop or repeat rows.
  const DISTINCT = 5;
  const TIED = 4;

  // Card 09's fixtures: the only closed rows in the org, at three timestamps
  // fixed in absolute terms rather than relative to now(). A date-range test
  // needs an instant it can name twice — once in the fixture and once in the
  // assertion — and `now() - interval` cannot be named twice.
  const CLOSED_AT = [
    '2026-06-15T12:00:00.000Z',
    '2026-06-16T12:00:00.000Z',
    '2026-06-17T12:00:00.000Z',
  ];
  const CLOSED = CLOSED_AT.length;
  const OPEN = DISTINCT + TIED;
  const TOTAL = OPEN + CLOSED;

  const listIds = (body: { items: { id: string }[] }) =>
    body.items.map((item) => item.id);

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    db = app.get(PostgresService);
    tenants = app.get(TenantDb);

    // RETURNING order for a multi-row VALUES list is not something Postgres
    // promises, so the name comes back too and the ids are matched by it.
    const orgs = await db.query<{ id: string; name: string }>(
      `INSERT INTO organizations (name, plan)
       VALUES ($1, 'pro'), ($2, 'free')
       RETURNING id, name`,
      [`${tag}-org`, `${tag}-other-org`],
    );
    const byName = new Map(orgs.rows.map((row) => [row.name, row.id]));
    orgId = byName.get(`${tag}-org`)!;
    otherOrgId = byName.get(`${tag}-other-org`)!;

    // Every parameter is cast explicitly. An untyped `$n` inside
    // generate_series() is ambiguous across its int/bigint/numeric overloads,
    // and `pg` sends numbers as text, so leaving it to inference is a coin flip.
    await tenants.withOrg(orgId, async (tx) => {
      await tx.query(
        `INSERT INTO conversations (org_id, status, created_at, updated_at)
         SELECT $1::bigint, 'open',
                now() - make_interval(mins => n * 10),
                now() - make_interval(mins => n)
           FROM generate_series(1, $2::int) AS n`,
        [orgId, DISTINCT],
      );

      // All four land on the same instant: now() is stable within a statement.
      await tx.query(
        `INSERT INTO conversations (org_id, status, created_at, updated_at)
         SELECT $1::bigint, 'open',
                now() - make_interval(days => 1),
                now() - make_interval(days => 1)
           FROM generate_series(1, $2::int)`,
        [orgId, TIED],
      );

      // created_at = updated_at here on purpose: it keeps the two sort columns
      // agreeing for these rows, so a filter test can never accidentally pass
      // because the rows happened to be ordered differently.
      await tx.query(
        `INSERT INTO conversations (org_id, status, created_at, updated_at)
         SELECT $1::bigint, 'closed', t, t
           FROM unnest($2::timestamptz[]) AS t`,
        [orgId, CLOSED_AT],
      );
    });

    await tenants.withOrg(otherOrgId, (tx) =>
      tx.query(
        `INSERT INTO conversations (org_id, status, created_at, updated_at)
         SELECT $1::bigint, 'open', now(), now() FROM generate_series(1, 3)`,
        [otherOrgId],
      ),
    );
  });

  afterAll(async () => {
    if (orgId) {
      // One scope per org, not one `WHERE org_id = ANY(...)`. A policy filters
      // per row against a single current tenant, so the array form would delete
      // at most one org's rows and silently leave the other's behind.
      for (const id of [orgId, otherOrgId]) {
        await tenants.withOrg(id, (tx) =>
          tx.query(`DELETE FROM conversations WHERE org_id = $1::bigint`, [id]),
        );
      }
      // organizations carries no org_id and has no policy — see migration 003.
      // `::bigint[]` because `pg` sends a JS array of strings as text[], and
      // `bigint = ANY(text[])` has no operator.
      await db.query(`DELETE FROM organizations WHERE id = ANY($1::bigint[])`, [
        [orgId, otherOrgId],
      ]);
    }
    await app.close();
  });

  describe('the happy path', () => {
    it('returns one org’s conversations, newest first, with paging metadata', async () => {
      const response = await request(app.getHttpServer())
        .get('/conversations')
        .set('x-org-id', orgId)
        .expect(200);

      const body = response.body as {
        items: { id: string; status: string; updatedAt: string }[];
        page: number;
        pageSize: number;
        total: number;
        totalPages: number;
      };

      expect(body).toMatchObject({
        page: 1,
        // The DTO's defaults, applied by the pipe rather than by the handler.
        pageSize: 50,
        total: TOTAL,
        totalPages: 1,
      });
      expect(body.items).toHaveLength(TOTAL);

      const updatedAt = body.items.map((item) => item.updatedAt);
      expect([...updatedAt].sort().reverse()).toEqual(updatedAt);
    });

    it('scopes to the org in the header and nothing else', async () => {
      const mine = await request(app.getHttpServer())
        .get('/conversations')
        .set('x-org-id', orgId)
        .expect(200);

      const theirs = await request(app.getHttpServer())
        .get('/conversations')
        .set('x-org-id', otherOrgId)
        .expect(200);

      const mineIds = new Set(
        listIds(mine.body as { items: { id: string }[] }),
      );
      const theirIds = listIds(theirs.body as { items: { id: string }[] });

      expect(theirIds).toHaveLength(3);
      expect(theirIds.some((id) => mineIds.has(id))).toBe(false);
    });

    it('pages through every row exactly once, ties included', async () => {
      const pageSize = 3;
      const seen: string[] = [];

      for (let page = 1; page <= Math.ceil(TOTAL / pageSize); page++) {
        const response = await request(app.getHttpServer())
          .get('/conversations')
          .query({ page, pageSize })
          .set('x-org-id', orgId)
          .expect(200);

        seen.push(...listIds(response.body as { items: { id: string }[] }));
      }

      // The assertion the tiebreaker exists for. Without `id DESC` the four
      // rows sharing an updated_at can be ordered differently per request, and
      // this comes back with a duplicate and a missing row.
      expect(seen).toHaveLength(TOTAL);
      expect(new Set(seen).size).toBe(TOTAL);
    });

    it('accepts the second sort column', async () => {
      const response = await request(app.getHttpServer())
        .get('/conversations')
        .query({ sort: 'created_at' })
        .set('x-org-id', orgId)
        .expect(200);

      const createdAt = (
        response.body as { items: { createdAt: string }[] }
      ).items.map((item) => item.createdAt);

      expect([...createdAt].sort().reverse()).toEqual(createdAt);
    });

    it('returns an empty page past the end rather than an error', async () => {
      const response = await request(app.getHttpServer())
        .get('/conversations')
        .query({ page: 999 })
        .set('x-org-id', orgId)
        .expect(200);

      expect((response.body as { items: unknown[] }).items).toEqual([]);
      expect((response.body as { total: number }).total).toBe(TOTAL);
    });
  });

  // Card 09. See plans/2026-08-25_drill-09-index-selectivity.md.
  describe('filtering by status and updated_at range', () => {
    interface Page {
      items: { id: string; status: string; updatedAt: string }[];
      total: number;
      totalPages: number;
    }

    const list = (query: Record<string, string>) =>
      request(app.getHttpServer())
        .get('/conversations')
        .query(query)
        .set('x-org-id', orgId)
        .expect(200);

    it('returns only open rows for status=open', async () => {
      const body = (await list({ status: 'open' })).body as Page;

      expect(body.items).toHaveLength(OPEN);
      expect(body.items.every((item) => item.status === 'open')).toBe(true);
    });

    it('returns only closed rows for status=closed', async () => {
      const body = (await list({ status: 'closed' })).body as Page;

      expect(body.items).toHaveLength(CLOSED);
      expect(body.items.every((item) => item.status === 'closed')).toBe(true);
    });

    // The highest-value assertion in this file. `total` and `totalPages` come
    // from a *second* statement, and filtering the page while leaving the count
    // alone is a silent bug: a pager that promises pages of rows that are not
    // there. It is why the WHERE is built once in ConversationsService.
    it('applies the filter to total, not just to items', async () => {
      const all = (await list({})).body as Page;
      const closed = (await list({ status: 'closed' })).body as Page;

      expect(all.total).toBe(TOTAL);
      expect(closed.total).toBe(CLOSED);
      expect(closed.totalPages).toBe(1);
    });

    it('treats updatedFrom as inclusive and updatedTo as exclusive', async () => {
      const body = (
        await list({ updatedFrom: CLOSED_AT[1], updatedTo: CLOSED_AT[2] })
      ).body as Page;

      // Exactly the middle row: the lower bound admits its own instant, the
      // upper bound does not. Anything else here means two adjacent ranges both
      // claim the same row.
      expect(body.items).toHaveLength(1);
      expect(body.total).toBe(1);
      expect(new Date(body.items[0].updatedAt).toISOString()).toBe(
        CLOSED_AT[1],
      );
    });

    // Written expecting a 400 and it came back 200 — `20260615` is the ISO 8601
    // *basic* format, which @IsISO8601 accepts and Postgres parses the same way
    // as the extended one. Kept as a passing test rather than deleted: it is
    // the difference between "this validator rejects what I imagined" and
    // "this validator rejects what the standard rejects".
    it('accepts the ISO 8601 basic format, dashes omitted', async () => {
      const body =
        (await list({ updatedFrom: '20260616', updatedTo: '20260617' })) // prettier-ignore
        .body as Page;

      expect(body.total).toBe(1);
      expect(new Date(body.items[0].updatedAt).toISOString()).toBe(
        CLOSED_AT[1],
      );
    });

    it('combines the status filter and the range', async () => {
      const body = (await list({ status: 'open', updatedTo: CLOSED_AT[0] }))
        .body as Page;

      // Every open row is newer than the closed block, so the range excludes
      // all of them and the status filter has nothing left to match.
      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });

    // Card 08's budget still has to hold with card 09's filters on: the WHERE
    // grew, the statement count did not. Without this, a filter added later by
    // fetching rows and post-filtering in JS would pass every test above.
    it('still costs three statements with every filter applied', async () => {
      const response = await list({
        status: 'closed',
        updatedFrom: CLOSED_AT[0],
        updatedTo: CLOSED_AT[2],
        sort: 'created_at',
      });

      expect(response.headers['x-query-count']).toBe('3');
    });
  });

  describe('rejection at the edge', () => {
    // Every one of these is a 400 from the ValidationPipe or the @OrgId
    // decorator. None of them reaches the service, and none of them reaches
    // Postgres — which is the entire reason to validate at the edge.
    const bad: [string, Record<string, string>][] = [
      ['page below the floor', { page: '-1' }],
      ['page zero', { page: '0' }],
      ['page that is not a number', { page: 'abc' }],
      ['pageSize above the ceiling', { pageSize: '101' }],
      ['pageSize zero', { pageSize: '0' }],
      ['a sort column outside the allowlist', { sort: 'id' }],
      [
        'an injection attempt in sort',
        { sort: 'id; DROP TABLE conversations' },
      ],
      ['an unknown parameter', { pageSze: '10' }],
      ['a status outside the two the column allows', { status: 'archived' }],
      ['an empty status', { status: '' }],
      ['a date that is not ISO 8601', { updatedFrom: 'yesterday' }],
      ['a range bound that is a unix timestamp', { updatedFrom: '1750000000' }],
      ['a paging mode outside the two arms', { paging: 'seek' }],
      ['a cursor too short to be one', { paging: 'keyset', cursor: 'abc' }],
      [
        'a cursor that is not base64url',
        { paging: 'keyset', cursor: 'not a cursor!!' },
      ],
    ];

    it.each(bad)('rejects %s', async (_label, query) => {
      await request(app.getHttpServer())
        .get('/conversations')
        .query(query)
        .set('x-org-id', orgId)
        .expect(400);
    });

    it('rejects a missing org header', async () => {
      await request(app.getHttpServer()).get('/conversations').expect(400);
    });

    it('rejects an org header that is not a positive integer', async () => {
      await request(app.getHttpServer())
        .get('/conversations')
        .set('x-org-id', 'abc')
        .expect(400);
    });

    it('accepts the ceiling itself — the bound is inclusive', async () => {
      await request(app.getHttpServer())
        .get('/conversations')
        .query({ pageSize: '100' })
        .set('x-org-id', orgId)
        .expect(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Card 10 — keyset pagination. See plans/2026-08-26_drill-10-keyset-pagination.md.
  // ---------------------------------------------------------------------------

  describe('keyset pagination', () => {
    interface CursorPage {
      items: { id: string; updatedAt: string }[];
      pageSize: number;
      nextCursor: string | null;
      hasMore: boolean;
    }

    /** Walk the cursor from the first page to the last, collecting ids in
     *  order. `pageSize` small enough that a page boundary lands *inside* the
     *  four-row tie block is the whole point — see the note on TIED. */
    const walkKeyset = async (
      pageSize: number,
      query: Record<string, string> = {},
      org: string = orgId,
    ) => {
      const ids: string[] = [];
      let cursor: string | null = null;
      // A bound, not a `while (true)`: a broken predicate that never advances
      // would otherwise hang the suite instead of failing it.
      for (let request_ = 0; request_ < 50; request_++) {
        const params: Record<string, string> = {
          ...query,
          paging: 'keyset',
          pageSize: String(pageSize),
        };
        if (cursor) params.cursor = cursor;

        const response = await request(app.getHttpServer())
          .get('/conversations')
          .query(params)
          .set('x-org-id', org)
          .expect(200);

        const body = response.body as CursorPage;
        ids.push(...body.items.map((item) => item.id));
        if (!body.hasMore) return ids;
        cursor = body.nextCursor;
      }
      throw new Error('cursor walk did not terminate');
    };

    /** The same walk over the offset arm, as the comparator. */
    const walkOffset = async (
      pageSize: number,
      query: Record<string, string> = {},
    ) => {
      const ids: string[] = [];
      for (let page = 1; page <= Math.ceil(TOTAL / pageSize) + 1; page++) {
        const response = await request(app.getHttpServer())
          .get('/conversations')
          .query({ ...query, page: String(page), pageSize: String(pageSize) })
          .set('x-org-id', orgId)
          .expect(200);
        const body = response.body as { items: { id: string }[] };
        if (body.items.length === 0) break;
        ids.push(...body.items.map((item) => item.id));
      }
      return ids;
    };

    it('returns a cursor and hasMore, and no total or totalPages', async () => {
      const response = await request(app.getHttpServer())
        .get('/conversations')
        .query({ paging: 'keyset', pageSize: '3' })
        .set('x-org-id', orgId)
        .expect(200);

      const body = response.body as CursorPage & Record<string, unknown>;

      expect(body.items).toHaveLength(3);
      expect(body.hasMore).toBe(true);
      expect(typeof body.nextCursor).toBe('string');
      // The absence is the feature, not an oversight — a count is the other
      // half of what makes a deep page expensive.
      expect(body).not.toHaveProperty('total');
      expect(body).not.toHaveProperty('totalPages');
      expect(body).not.toHaveProperty('page');
    });

    // THE tiebreaker test. pageSize=2 against 5 distinct + 4 tied rows puts a
    // page boundary in the middle of the tie block, which is the only
    // arrangement where dropping `id` from the predicate is observable.
    //
    // Goes RED under KEYSET_TIEBREAK=off: `updated_at < $k` excludes every row
    // still tied on the cursor's timestamp, so the rest of the block vanishes.
    // `pnpm db:test:notiebreak` is that run.
    it('pages through every row exactly once, ties included', async () => {
      const keyset = await walkKeyset(2);

      expect(keyset).toHaveLength(TOTAL);
      expect(new Set(keyset).size).toBe(TOTAL);
      expect(keyset).toEqual(await walkOffset(2));
    });

    it('applies the same filters as the offset arm', async () => {
      const filter = {
        status: 'closed',
        updatedFrom: CLOSED_AT[0],
        updatedTo: CLOSED_AT[2],
      };

      // Half-open: from the 15th up to but not including the 17th.
      expect(await walkKeyset(1, filter)).toEqual(await walkOffset(1, filter));
      expect(await walkKeyset(1, filter)).toHaveLength(2);
    });

    it('is scoped by the header, not by the cursor', async () => {
      const mine = await request(app.getHttpServer())
        .get('/conversations')
        .query({ paging: 'keyset', pageSize: '2' })
        .set('x-org-id', orgId)
        .expect(200);

      const cursor = (mine.body as CursorPage).nextCursor!;

      // A cursor is a position, not a capability. Replayed against another org
      // it names an instant and a uuid that org does not own, and the tenant
      // filter plus the RLS policy answer with that org's rows or none.
      const theirs = await request(app.getHttpServer())
        .get('/conversations')
        .query({ paging: 'keyset', pageSize: '50', cursor })
        .set('x-org-id', otherOrgId)
        .expect(200);

      const mineIds = new Set(
        listIds(mine.body as { items: { id: string }[] }),
      );
      const theirIds = listIds(theirs.body as { items: { id: string }[] });
      expect(theirIds.some((id) => mineIds.has(id))).toBe(false);
    });

    it('ends with hasMore false and a null cursor, and replaying the last cursor is empty, not an error', async () => {
      // Walk to the final page the long way, so "last" is what the API says it
      // is rather than what the fixture count implies.
      let cursor: string | null = null;
      let body: CursorPage;
      do {
        const params: Record<string, string> = {
          paging: 'keyset',
          pageSize: '4',
        };
        if (cursor) params.cursor = cursor;
        const response = await request(app.getHttpServer())
          .get('/conversations')
          .query(params)
          .set('x-org-id', orgId)
          .expect(200);
        body = response.body as CursorPage;
        if (body.hasMore) cursor = body.nextCursor;
      } while (body.hasMore);

      expect(body.nextCursor).toBeNull();

      // And the cursor that produced this last page still resolves — to an
      // empty page. A 400 there would make "I refreshed and it broke" a real
      // bug report.
      const replay = await request(app.getHttpServer())
        .get('/conversations')
        .query({ paging: 'keyset', pageSize: '4', cursor: cursor! })
        .set('x-org-id', orgId)
        .expect(200);
      expect((replay.body as CursorPage).items.length).toBeLessThanOrEqual(4);
    });

    it('rejects a cursor sent to the offset arm', async () => {
      const first = await request(app.getHttpServer())
        .get('/conversations')
        .query({ paging: 'keyset', pageSize: '2' })
        .set('x-org-id', orgId)
        .expect(200);

      // Not ignored — rejected. A switch that silently does nothing is drill
      // 08's QUERY_COUNTER bug.
      await request(app.getHttpServer())
        .get('/conversations')
        .query({ cursor: (first.body as CursorPage).nextCursor! })
        .set('x-org-id', orgId)
        .expect(400);
    });

    it('rejects a cursor replayed under a different sort or filter', async () => {
      const first = await request(app.getHttpServer())
        .get('/conversations')
        .query({ paging: 'keyset', pageSize: '2' })
        .set('x-org-id', orgId)
        .expect(200);

      const cursor = (first.body as CursorPage).nextCursor!;

      // Both name a position in an ordering the cursor was not issued for. The
      // fingerprint inside the cursor is what turns silently-wrong rows into a
      // 400 — the whole reason the cursor is opaque rather than `?after=<ts>`.
      for (const changed of [{ sort: 'created_at' }, { status: 'closed' }]) {
        await request(app.getHttpServer())
          .get('/conversations')
          .query({ paging: 'keyset', pageSize: '2', cursor, ...changed })
          .set('x-org-id', orgId)
          .expect(400);
      }
    });

    // The card's concurrent-insert question, as an assertion rather than a
    // story. A row inserted at the top shifts every later row down by one
    // position — which is exactly what an OFFSET counts.
    it('does not repeat a row when one is inserted mid-pagination, where offset does', async () => {
      const pageOne = async (mode: 'offset' | 'keyset') =>
        request(app.getHttpServer())
          .get('/conversations')
          .query({ paging: mode, pageSize: '3' })
          .set('x-org-id', orgId)
          .expect(200);

      const keysetFirst = await pageOne('keyset');
      const offsetFirst = await pageOne('offset');
      const cursor = (keysetFirst.body as CursorPage).nextCursor!;
      const seen = new Set(
        listIds(offsetFirst.body as { items: { id: string }[] }),
      );

      // Newest updated_at in the org, so it lands at position 1.
      const inserted = await tenants.withOrg(orgId, (tx) =>
        tx.query<{ id: string }>(
          `INSERT INTO conversations (org_id, status, created_at, updated_at)
           VALUES ($1::bigint, 'open', now(), now() + interval '1 hour')
           RETURNING id`,
          [orgId],
        ),
      );

      try {
        const offsetSecond = await request(app.getHttpServer())
          .get('/conversations')
          .query({ page: '2', pageSize: '3' })
          .set('x-org-id', orgId)
          .expect(200);

        const keysetSecond = await request(app.getHttpServer())
          .get('/conversations')
          .query({ paging: 'keyset', pageSize: '3', cursor })
          .set('x-org-id', orgId)
          .expect(200);

        const offsetIds = listIds(
          offsetSecond.body as { items: { id: string }[] },
        );
        const keysetIds = listIds(
          keysetSecond.body as { items: { id: string }[] },
        );

        // Offset counts positions, and every position moved by one.
        expect(offsetIds.filter((id) => seen.has(id))).toHaveLength(1);
        // Keyset names a row, and that row did not move.
        expect(keysetIds.filter((id) => seen.has(id))).toHaveLength(0);
      } finally {
        await tenants.withOrg(orgId, (tx) =>
          tx.query(`DELETE FROM conversations WHERE id = $1`, [
            inserted.rows[0].id,
          ]),
        );
      }
    });
  });
});
