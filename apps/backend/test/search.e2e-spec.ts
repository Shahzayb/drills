import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PostgresService } from '../src/postgres/postgres.service';
import { TenantDb } from '../src/tenancy/tenant-db.service';

describe('GET /messages/search (e2e)', () => {
  let app: INestApplication<App>;
  let db: PostgresService;
  let tenants: TenantDb;

  const tag = `search-e2e-${Date.now()}`;

  let orgId: string;
  let otherOrgId: string;

  const BODIES = [
    'The zqmarmalade export refunded twice last Tuesday.',
    'Nobody can sign in from zqmarmalade after the update.',
    'Unrelated body with none of the words this spec looks for.',
  ];
  const OTHER_BODY = 'The zqmarmalade export refunded in another tenant.';

  const messageIds = (body: { items: { id: string }[] }) =>
    body.items.map((item) => item.id);

  const queryCount = (response: request.Response): number =>
    Number(response.headers['x-query-count']);

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    db = app.get(PostgresService);
    tenants = app.get(TenantDb);

    const orgs = await db.query<{ id: string; name: string }>(
      `INSERT INTO organizations (name, plan)
       VALUES ($1, 'pro'), ($2, 'free')
       RETURNING id, name`,
      [`${tag}-org`, `${tag}-other-org`],
    );
    const byName = new Map(orgs.rows.map((row) => [row.name, row.id]));
    orgId = byName.get(`${tag}-org`)!;
    otherOrgId = byName.get(`${tag}-other-org`)!;

    for (const [id, bodies] of [
      [orgId, BODIES],
      [otherOrgId, [OTHER_BODY]],
    ] as const) {
      await tenants.withOrg(id, async (tx) => {
        const conversation = await tx.query<{ id: string }>(
          `INSERT INTO conversations (org_id, status) VALUES ($1::bigint, 'open')
           RETURNING id`,
          [id],
        );
        await tx.query(
          `INSERT INTO messages (conversation_id, org_id, message, created_at, updated_at)
           SELECT $1::uuid, $2::bigint, body,
                  now() - make_interval(mins => 10 - ord::int),
                  now()
             FROM unnest($3::text[]) WITH ORDINALITY AS t(body, ord)`,
          [conversation.rows[0].id, id, bodies],
        );
      });
    }
  });

  afterAll(async () => {
    if (orgId) {
      for (const id of [orgId, otherOrgId]) {
        await tenants.withOrg(id, async (tx) => {
          await tx.query(`DELETE FROM messages WHERE org_id = $1::bigint`, [
            id,
          ]);
          await tx.query(
            `DELETE FROM conversations WHERE org_id = $1::bigint`,
            [id],
          );
        });
      }
      await db.query(`DELETE FROM organizations WHERE id = ANY($1::bigint[])`, [
        [orgId, otherOrgId],
      ]);
    }
    await app.close();
  });

  describe('the happy path', () => {
    it('returns the org’s matching messages, newest first', async () => {
      const response = await request(app.getHttpServer())
        .get('/messages/search')
        .query({ q: 'zqmarmalade' })
        .set('x-org-id', orgId)
        .expect(200);

      const body = response.body as {
        items: { id: string; message: string; createdAt: string }[];
        strategy: string;
      };

      expect(body.items).toHaveLength(2);
      expect(body.items.map((item) => item.message)).toEqual([
        BODIES[1],
        BODIES[0],
      ]);
      expect(['like', 'fts']).toContain(body.strategy);
    });

    it('honours limit', async () => {
      const response = await request(app.getHttpServer())
        .get('/messages/search')
        .query({ q: 'zqmarmalade', limit: 1 })
        .set('x-org-id', orgId)
        .expect(200);

      expect((response.body as { items: unknown[] }).items).toHaveLength(1);
    });

    it('costs exactly one statement', async () => {
      const response = await request(app.getHttpServer())
        .get('/messages/search')
        .query({ q: 'zqmarmalade' })
        .set('x-org-id', orgId)
        .expect(200);

      expect(queryCount(response)).toBe(1);
    });
  });

  describe('the arm switch', () => {
    it('finds "refunded" when searching "refunds" (FTS arm only)', async () => {
      const response = await request(app.getHttpServer())
        .get('/messages/search')
        .query({ q: 'refunds' })
        .set('x-org-id', orgId)
        .expect(200);

      const body = response.body as { items: { message: string }[] };
      expect(body.items.map((item) => item.message)).toEqual([BODIES[0]]);
    });
  });

  describe('tenant isolation', () => {
    it('never returns another org’s messages for the same term', async () => {
      const mine = await request(app.getHttpServer())
        .get('/messages/search')
        .query({ q: 'zqmarmalade' })
        .set('x-org-id', orgId)
        .expect(200);

      const theirs = await request(app.getHttpServer())
        .get('/messages/search')
        .query({ q: 'zqmarmalade' })
        .set('x-org-id', otherOrgId)
        .expect(200);

      const mineIds = messageIds(mine.body as { items: { id: string }[] });
      const theirIds = messageIds(theirs.body as { items: { id: string }[] });

      expect(theirIds).toHaveLength(1);
      expect(mineIds).toHaveLength(2);
      expect(mineIds.filter((id) => theirIds.includes(id))).toEqual([]);
    });
  });

  describe('validation', () => {
    it('400s when q is missing', async () => {
      await request(app.getHttpServer())
        .get('/messages/search')
        .set('x-org-id', orgId)
        .expect(400);
    });

    it('400s on an empty or one-character q', async () => {
      for (const q of ['', 'a']) {
        await request(app.getHttpServer())
          .get('/messages/search')
          .query({ q })
          .set('x-org-id', orgId)
          .expect(400);
      }
    });

    it('400s past the limit ceiling', async () => {
      await request(app.getHttpServer())
        .get('/messages/search')
        .query({ q: 'zqmarmalade', limit: 101 })
        .set('x-org-id', orgId)
        .expect(400);
    });

    it('400s on an unknown parameter', async () => {
      await request(app.getHttpServer())
        .get('/messages/search')
        .query({ q: 'zqmarmalade', pageSize: 10 })
        .set('x-org-id', orgId)
        .expect(400);
    });

    it('400s without an org header', async () => {
      await request(app.getHttpServer())
        .get('/messages/search')
        .query({ q: 'zqmarmalade' })
        .expect(400);
    });
  });
});
