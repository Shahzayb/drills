import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import {
  ASSIGN,
  ConversationSummary,
} from '../src/conversations/conversations.service';
import { PostgresService } from '../src/postgres/postgres.service';
import { TenantDb } from '../src/tenancy/tenant-db.service';

/**
 * Card 14's server half: two agents claim the same ticket and exactly one of
 * them may be told yes.
 *
 * The bug this suite exists to catch does not throw and does not log. On
 * `ASSIGN=lww` every claimer gets a 200, the row belongs to whoever committed
 * last, and every other agent walks away believing they own a conversation they
 * do not. A sequential test passes on all three arms — which is why the
 * interesting block below fires them concurrently.
 *
 * One assertion is *expected to fail* on a non-default arm, and that red run is
 * the deliverable:
 *
 *   pnpm db:test:lww          ASSIGN=lww           the silent last write
 *   pnpm db:test:pessimistic  ASSIGN=pessimistic   green
 *
 * The card's literal fifty concurrent claimers live in `pnpm db:claim fire`,
 * which is the wrong shape for a suite that has to stay fast. A race is a race
 * at 20 claimers as at 50 — what changes is the odds, not the mechanism, and the
 * assertions below hold for any N.
 *
 * See plans/2026-09-08_drill-14-optimistic-locking.md.
 */
describe('conversation assignment (e2e)', () => {
  let app: INestApplication<App>;
  let db: PostgresService;
  let tenants: TenantDb;

  const tag = `assign-e2e-${Date.now()}`;

  let orgId: string;
  let otherOrgId: string;
  /** Membership ids in `orgId`. Distinct per claimer on purpose — the claim rule
   *  is "unassigned, or already yours", so two claimers sharing an id would both
   *  legally succeed and the test would be measuring its own fixture. */
  let agents: string[];
  let otherOrgConversationId: string;

  const CONCURRENT = 20;

  const claim = (id: string, body: unknown, org = orgId) =>
    request(app.getHttpServer())
      .post(`/conversations/${id}/assign`)
      .set('X-Org-Id', org)
      .send(body as object);

  /**
   * A fresh unassigned conversation for one test to fight over.
   *
   * Through `withOrg`, not `db.query`. The app connects as `app_user`, which
   * drill 07 deliberately left without BYPASSRLS, so an INSERT with no
   * `app.org_id` set fails the policy's WITH CHECK: "new row violates row-level
   * security policy". A fixture is not exempt from the mechanism, and that is
   * the mechanism working.
   */
  const freshRow = (org = orgId) =>
    tenants
      .withOrg(org, (tx) =>
        tx.query<{ id: string; version: number }>(
          `INSERT INTO conversations (org_id, status) VALUES ($1::bigint, 'open')
           RETURNING id, version`,
          [org],
        ),
      )
      .then((r) => r.rows[0]);

  /** The row as the database has it, read outside the endpoint — so an
   *  assertion about what was written cannot be satisfied by what was
   *  returned. */
  const readRow = (id: string, org = orgId) =>
    tenants
      .withOrg(org, (tx) =>
        tx.query<{ assignee_id: string | null; version: number }>(
          `SELECT assignee_id, version FROM conversations WHERE id = $1`,
          [id],
        ),
      )
      .then((r) => r.rows[0]);

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();

    // listen(0), not init(). supertest starts an ephemeral server per request
    // for an app that is not already listening, and twenty of those at once fail
    // in the CLIENT with nothing wrong server-side — which reads exactly like
    // the endpoint breaking under concurrency. Drill 12 paid for this once.
    await app.listen(0);

    db = app.get(PostgresService);
    tenants = app.get(TenantDb);

    const org = (name: string) =>
      db
        .query<{ id: string }>(
          `INSERT INTO organizations (name, plan) VALUES ($1, 'pro') RETURNING id`,
          [name],
        )
        .then((r) => r.rows[0].id);

    orgId = await org(`${tag}-org`);
    otherOrgId = await org(`${tag}-other`);

    // `users` has no org_id and no policy (a person can belong to several
    // orgs); `memberships` does, so the whole statement runs inside withOrg.
    agents = (
      await tenants.withOrg(orgId, (tx) =>
        tx.query<{ id: string }>(
          `WITH people AS (
             INSERT INTO users (name)
             SELECT $2 || ' agent ' || g FROM generate_series(1, $3::int) g
             RETURNING id
           )
           INSERT INTO memberships (user_id, org_id, role)
           SELECT id, $1::bigint, 'editor' FROM people
           RETURNING id`,
          [orgId, tag, CONCURRENT],
        ),
      )
    ).rows.map((r) => r.id);

    otherOrgConversationId = (await freshRow(otherOrgId)).id;
  });

  afterAll(async () => {
    for (const org of [orgId, otherOrgId].filter(Boolean)) {
      await tenants.withOrg(org, (tx) =>
        tx.query(`DELETE FROM conversations WHERE org_id = $1::bigint`, [org]),
      );
    }
    if (agents?.length) {
      const { rows } = await tenants.withOrg(orgId, (tx) =>
        tx.query<{ user_id: string }>(
          `DELETE FROM memberships WHERE id = ANY($1::bigint[])
           RETURNING user_id`,
          [agents],
        ),
      );
      // Two statements, not one CTE: `users` is outside every policy, so
      // deleting it does not belong inside a tenant scope.
      await db.query(`DELETE FROM users WHERE id = ANY($1::bigint[])`, [
        rows.map((r) => r.user_id),
      ]);
    }
    for (const org of [orgId, otherOrgId].filter(Boolean)) {
      await db.query(`DELETE FROM organizations WHERE id = $1::bigint`, [org]);
    }
    await app?.close();
  });

  describe('one claim at a time', () => {
    it('claims an unassigned conversation and moves the version by one', async () => {
      const row = await freshRow();

      const response = await claim(row.id, {
        assigneeId: agents[0],
        version: row.version,
      });

      expect(response.status).toBe(200);
      const body = response.body as ConversationSummary;
      expect(body.assigneeId).toBe(agents[0]);
      expect(body.version).toBe(row.version + 1);
    });

    it('refuses a stale version and says who holds it now', async () => {
      const row = await freshRow();
      await claim(row.id, { assigneeId: agents[0], version: row.version });

      // The second agent read the row before the first one wrote, so it is
      // still holding the version the row no longer has. This is the whole card
      // in three lines.
      const response = await claim(row.id, {
        assigneeId: agents[1],
        version: row.version,
      });

      if (ASSIGN === 'lww') {
        // The bug, asserted rather than described: no refusal, and the row now
        // belongs to an agent nobody told the first one about.
        expect(response.status).toBe(200);
        return;
      }

      expect(response.status).toBe(409);
      const body = response.body as {
        error: string;
        message: string;
        current: { assigneeId: string | null; version: number };
      };
      expect(body.error).toBe('conflict');
      // The truth, in the same response that refuses the write. Without it the
      // losing client has to make another round trip before it can say anything
      // true, and until then it is showing a lie it already told.
      expect(body.current.assigneeId).toBe(agents[0]);
      expect(body.current.version).toBe(row.version + 1);
      expect(body.message).toContain('already assigned');
    });

    it('lets the holder release what it is holding', async () => {
      const row = await freshRow();
      const claimed = await claim(row.id, {
        assigneeId: agents[0],
        version: row.version,
      });

      const released = await claim(row.id, {
        assigneeId: null,
        version: (claimed.body as ConversationSummary).version,
      });

      expect(released.status).toBe(200);
      expect((released.body as ConversationSummary).assigneeId).toBeNull();
    });

    it('rejects a claim with no version, rather than writing without a check', async () => {
      const row = await freshRow();
      const response = await claim(row.id, { assigneeId: agents[0] });

      // The other two arms do not use the version, and demanding one there would
      // make the two clients differ — which is the thing the stretch compares.
      if (ASSIGN !== 'optimistic') {
        expect(response.status).toBe(200);
        return;
      }

      // 400, never a silent success. A write that skips its own concurrency
      // check because a field was absent would return 200 every time and be
      // invisible in every log.
      expect(response.status).toBe(400);
      expect(await readRow(row.id)).toMatchObject({ assignee_id: null });
    });

    it('rejects an assigneeId that is not an id', async () => {
      const row = await freshRow();
      const response = await claim(row.id, {
        assigneeId: 'me',
        version: row.version,
      });

      expect(response.status).toBe(400);
    });

    it('answers 404 for another org’s conversation, not 403', async () => {
      // 403 would confirm the row exists, which turns this endpoint into an
      // oracle: a competitor could size your inbox by probing ids. Same rule
      // `get()` already follows.
      const response = await claim(otherOrgConversationId, {
        assigneeId: agents[0],
        version: 1,
      });

      expect(response.status).toBe(404);
      expect(await readRow(otherOrgConversationId, otherOrgId)).toMatchObject({
        assignee_id: null,
      });
    });
  });

  describe(`${CONCURRENT} agents claiming the same ticket`, () => {
    let row: { id: string; version: number };
    let responses: request.Response[];

    beforeAll(async () => {
      row = await freshRow();

      // Every claimer sends the SAME version, because every agent had the inbox
      // open at the same moment. That is the scenario, not a simplification.
      responses = await Promise.all(
        agents.map((agent) =>
          claim(row.id, { assigneeId: agent, version: row.version }),
        ),
      );
    });

    const withStatus = (status: number) =>
      responses.filter((r) => r.status === status);

    it('tells exactly one agent it won', () => {
      expect(withStatus(200)).toHaveLength(1);
    });

    it('tells every other agent it lost, with a 409 and not a 500', () => {
      expect(withStatus(409)).toHaveLength(CONCURRENT - 1);
      expect(responses.filter((r) => r.status >= 500)).toHaveLength(0);
    });

    it('writes once — the version moves by one, not by twenty', async () => {
      expect((await readRow(row.id)).version).toBe(row.version + 1);
    });

    it('gives the row to the agent that was told it won', async () => {
      const winner = withStatus(200)[0];
      expect((await readRow(row.id)).assignee_id).toBe(
        (winner?.body as ConversationSummary | undefined)?.assigneeId,
      );
    });
  });

  describe('the agent list the claim needs', () => {
    it('returns this org’s memberships and nobody else’s', async () => {
      const response = await request(app.getHttpServer())
        .get('/conversations/agents')
        .set('X-Org-Id', orgId);

      expect(response.status).toBe(200);
      const body = response.body as { id: string; name: string }[];
      expect(body).toHaveLength(CONCURRENT);
      expect(body.map((a) => a.id).sort()).toEqual([...agents].sort());
    });

    it('is a route and not a conversation id', async () => {
      // Declared before `@Get(':id')`. Below it, `agents` binds as the id
      // parameter and ParseUUIDPipe answers 400 for a path that exists.
      const response = await request(app.getHttpServer())
        .get('/conversations/agents')
        .set('X-Org-Id', otherOrgId);

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
    });
  });
});
