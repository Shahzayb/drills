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
  const TOTAL = DISTINCT + TIED;

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
});
