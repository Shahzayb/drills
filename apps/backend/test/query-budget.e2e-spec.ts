import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PostgresService } from '../src/postgres/postgres.service';
import { TenantDb } from '../src/tenancy/tenant-db.service';

/**
 * Card 08's proof that the budget bites, not just that it exists.
 *
 * Reads `x-query-count`, which only appears because `apps/backend/package.json`'s
 * `test:e2e` script sets `QUERY_COUNTER=header` for the whole suite — see
 * src/observability/query-counter.ts. Run with `pnpm db:test`, same
 * requirements as conversations.e2e-spec.ts: real HTTP, real Postgres,
 * nothing mocked.
 *
 * This spec alone is not the deliverable. `pnpm db:test:naive` runs it again
 * with `LIST_STRATEGY=naive` and is *expected* to fail the list assertion —
 * that red run, captured verbatim, is what proves the budget would have
 * caught this. A budget test that has never been seen to fail is decoration.
 * See plans/2026-08-17_drill-08-n-plus-one.md.
 */
describe('query budget (e2e)', () => {
  let app: INestApplication<App>;
  let db: PostgresService;
  let tenants: TenantDb;

  const tag = `query-budget-e2e-${Date.now()}`;
  const MEMBER_NAME = `${tag}-member`;
  const PAGE_SIZE = 12;

  let orgId: string;
  let userId: string;
  let membershipId: string;
  // The list fixture: PAGE_SIZE conversations, half assigned to the one
  // membership above, tagged with a mix of 0/1/2 of two fixed tags.
  let listConversationIds: string[] = [];
  // Standalone rows for the single-conversation routes, kept separate from
  // the list fixture so PATCH/DELETE cannot change what the list test counts.
  let getId: string;
  let messagesId: string;
  let patchId: string;
  let deleteId: string;

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

    const orgs = await db.query<{ id: string }>(
      `INSERT INTO organizations (name, plan) VALUES ($1, 'pro') RETURNING id`,
      [`${tag}-org`],
    );
    orgId = orgs.rows[0].id;

    // users carries no org_id and no policy — see migration 003 — so this is
    // a plain owner-side insert, same as organizations above.
    const users = await db.query<{ id: string }>(
      `INSERT INTO users (name) VALUES ($1) RETURNING id`,
      [MEMBER_NAME],
    );
    userId = users.rows[0].id;

    await tenants.withOrg(orgId, async (tx) => {
      const memberships = await tx.query<{ id: string }>(
        `INSERT INTO memberships (user_id, org_id, role)
         VALUES ($1::bigint, $2::bigint, 'admin') RETURNING id`,
        [userId, orgId],
      );
      membershipId = memberships.rows[0].id;

      const tags = await tx.query<{ id: string; name: string }>(
        `INSERT INTO tags (org_id, name)
         VALUES ($1::bigint, 'bug'), ($1::bigint, 'urgent')
         RETURNING id, name`,
        [orgId],
      );
      const tagId = new Map(tags.rows.map((row) => [row.name, row.id]));
      const bugId = tagId.get('bug')!;
      const urgentId = tagId.get('urgent')!;

      const listRows = await tx.query<{ id: string }>(
        `INSERT INTO conversations (org_id, status, assignee_id, created_at, updated_at)
         SELECT $1::bigint, 'open',
                CASE WHEN n % 2 = 0 THEN $2::bigint END,
                now() - make_interval(mins => n),
                now() - make_interval(mins => n)
           FROM generate_series(1, $3::int) AS n
         RETURNING id`,
        [orgId, membershipId, PAGE_SIZE],
      );
      listConversationIds = listRows.rows.map((row) => row.id);

      // A mix of 0, 1 and 2 tags per conversation, cycling through the list —
      // real variance, not every row identical.
      for (let i = 0; i < listConversationIds.length; i++) {
        const cycle = i % 3;
        if (cycle === 0) continue; // untagged
        await tx.query(
          `INSERT INTO conversation_tags (conversation_id, tag_id, org_id)
           VALUES ($1::uuid, $2::bigint, $3::bigint)`,
          [listConversationIds[i], bugId, orgId],
        );
        if (cycle === 2) {
          await tx.query(
            `INSERT INTO conversation_tags (conversation_id, tag_id, org_id)
             VALUES ($1::uuid, $2::bigint, $3::bigint)`,
            [listConversationIds[i], urgentId, orgId],
          );
        }
      }

      const scratch = await tx.query<{ id: string }>(
        `INSERT INTO conversations (org_id, status, assignee_id, created_at, updated_at)
         SELECT $1::bigint, 'open', $2::bigint, now(), now()
           FROM generate_series(1, 4)
         RETURNING id`,
        [orgId, membershipId],
      );
      [getId, messagesId, patchId, deleteId] = scratch.rows.map(
        (row) => row.id,
      );

      await tx.query(
        `INSERT INTO messages (conversation_id, org_id, message)
         VALUES ($1::uuid, $2::bigint, 'first message')`,
        [messagesId, orgId],
      );
    });
  });

  afterAll(async () => {
    if (orgId) {
      await tenants.withOrg(orgId, async (tx) => {
        await tx.query(`DELETE FROM messages WHERE org_id = $1::bigint`, [
          orgId,
        ]);
        await tx.query(
          `DELETE FROM conversation_tags WHERE org_id = $1::bigint`,
          [orgId],
        );
        await tx.query(`DELETE FROM conversations WHERE org_id = $1::bigint`, [
          orgId,
        ]);
        await tx.query(`DELETE FROM tags WHERE org_id = $1::bigint`, [orgId]);
        await tx.query(`DELETE FROM memberships WHERE org_id = $1::bigint`, [
          orgId,
        ]);
      });
      await db.query(`DELETE FROM users WHERE id = $1::bigint`, [userId]);
      await db.query(`DELETE FROM organizations WHERE id = $1::bigint`, [
        orgId,
      ]);
    }
    await app.close();
  });

  it('a full page of assigned, tagged conversations stays within budget', async () => {
    const response = await request(app.getHttpServer())
      .get('/conversations')
      .query({ pageSize: PAGE_SIZE })
      .set('x-org-id', orgId)
      .expect(200);

    // The card's number. LIST_STRATEGY=naive blows this — that is the point,
    // and pnpm db:test:naive is where that failure gets captured.
    expect(queryCount(response)).toBeLessThanOrEqual(3);

    const body = response.body as {
      items: {
        id: string;
        assigneeId: string | null;
        assigneeName: string | null;
        tags: { id: string; name: string }[];
      }[];
    };
    expect(body.items).toHaveLength(PAGE_SIZE);

    // A budget met by returning less is not a fix: every assigned row still
    // carries the member's name, not just its id.
    const assigned = body.items.filter((item) => item.assigneeId !== null);
    expect(assigned.length).toBeGreaterThan(0);
    for (const item of assigned) {
      expect(item.assigneeName).toBe(MEMBER_NAME);
    }

    // ...and every tagged row still carries its tags, in both the 1-tag and
    // 2-tag cases the fixture built.
    const tagged = body.items.filter((item) => item.tags.length > 0);
    expect(tagged.some((item) => item.tags.length === 1)).toBe(true);
    expect(tagged.some((item) => item.tags.length === 2)).toBe(true);
    for (const item of tagged) {
      expect(item.tags.every((t) => typeof t.name === 'string')).toBe(true);
    }
  });

  it('an empty page skips the tags query — 2 statements, not 3', async () => {
    const response = await request(app.getHttpServer())
      .get('/conversations')
      .query({ page: 999 })
      .set('x-org-id', orgId)
      .expect(200);

    expect((response.body as { items: unknown[] }).items).toEqual([]);
    expect(queryCount(response)).toBe(2);
  });

  it('GET /conversations/:id stays within the default budget', async () => {
    const response = await request(app.getHttpServer())
      .get(`/conversations/${getId}`)
      .set('x-org-id', orgId)
      .expect(200);

    expect(queryCount(response)).toBeLessThanOrEqual(5);
  });

  it('GET /conversations/:id/messages stays within the default budget', async () => {
    const response = await request(app.getHttpServer())
      .get(`/conversations/${messagesId}/messages`)
      .set('x-org-id', orgId)
      .expect(200);

    expect((response.body as unknown[]).length).toBe(1);
    expect(queryCount(response)).toBeLessThanOrEqual(5);
  });

  it('PATCH /conversations/:id stays within the default budget', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/conversations/${patchId}`)
      .set('x-org-id', orgId)
      .send({ status: 'closed' })
      .expect(200);

    expect(queryCount(response)).toBeLessThanOrEqual(5);
  });

  it('DELETE /conversations/:id stays within the default budget', async () => {
    const response = await request(app.getHttpServer())
      .delete(`/conversations/${deleteId}`)
      .set('x-org-id', orgId)
      .expect(204);

    expect(queryCount(response)).toBeLessThanOrEqual(5);
  });

  it('a route with no @QueryBudget is still counted', async () => {
    // /info carries no @QueryBudget at all, so DEFAULT_QUERY_BUDGET is what
    // applies to it — but note what this can and cannot prove. /info issues
    // exactly one statement, so a `<= 5` here would pass whatever the default
    // were, including no default at all; only a route that *exceeds* 5 could
    // pin the number. What it does prove is that an unannotated route is
    // counted at all, so the exact count is the assertion: `toBe(1)` fails if
    // the counter stops incrementing, where `<= 5` would pass at 0.
    const response = await request(app.getHttpServer())
      .get('/info')
      .expect(200);

    expect(queryCount(response)).toBe(1);
  });
});
