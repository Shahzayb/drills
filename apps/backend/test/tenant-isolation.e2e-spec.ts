import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PostgresService } from '../src/postgres/postgres.service';
import { TenantDb } from '../src/tenancy/tenant-db.service';

describe('tenant isolation (e2e)', () => {
  let app: INestApplication<App>;
  let db: PostgresService;
  let tenants: TenantDb;

  const tag = `tenant-isolation-e2e-${Date.now()}`;

  let victim: string;
  let attacker: string;

  const v: Record<string, string> = {};
  const a: Record<string, string> = {};

  const SECRET = `${tag}-do-not-disclose-9c1f`;

  const HOOK_TIMEOUT_MS = 60_000;

  const conversationFor = async (orgId: string): Promise<string> => {
    const result = await tenants.withOrg(orgId, (tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO conversations (org_id, status)
         VALUES ($1::bigint, 'open')
         RETURNING id`,
        [orgId],
      ),
    );
    return result.rows[0].id;
  };

  const messageFor = async (
    orgId: string,
    conversationId: string,
    body: string,
  ): Promise<void> => {
    await tenants.withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO messages (conversation_id, org_id, message)
         VALUES ($1::uuid, $2::bigint, $3)`,
        [conversationId, orgId, body],
      ),
    );
  };

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
      [`${tag}-victim`, `${tag}-attacker`],
    );
    const byName = new Map(orgs.rows.map((row) => [row.name, row.id]));
    victim = byName.get(`${tag}-victim`)!;
    attacker = byName.get(`${tag}-attacker`)!;

    for (const key of ['read', 'update', 'delete', 'messages']) {
      v[key] = await conversationFor(victim);
    }
    for (const key of ['own', 'move']) {
      a[key] = await conversationFor(attacker);
    }

    await messageFor(victim, v.messages, SECRET);
    await messageFor(victim, v.messages, `${SECRET}-second`);
    await messageFor(attacker, a.own, `${tag}-attacker-own-message`);
  }, HOOK_TIMEOUT_MS);

  afterAll(async () => {
    if (victim) {
      for (const orgId of [victim, attacker]) {
        await tenants.withOrg(orgId, async (tx) => {
          await tx.query(
            `DELETE FROM messages
              WHERE conversation_id IN (
                SELECT id FROM conversations WHERE org_id = $1::bigint
              )`,
            [orgId],
          );
          await tx.query(
            `DELETE FROM conversations WHERE org_id = $1::bigint`,
            [orgId],
          );
        });
      }
      await db.query(`DELETE FROM organizations WHERE id = ANY($1::bigint[])`, [
        [victim, attacker],
      ]);
    }
    await app.close();
  }, HOOK_TIMEOUT_MS);

  describe('1. cross-tenant read by id', () => {
    it('does not return another org’s conversation', async () => {
      await request(app.getHttpServer())
        .get(`/conversations/${v.read}`)
        .set('x-org-id', attacker)
        .expect(404);
    });

    it('control: the id is real, and its owner can read it', async () => {
      const response = await request(app.getHttpServer())
        .get(`/conversations/${v.read}`)
        .set('x-org-id', victim)
        .expect(200);

      expect((response.body as { id: string }).id).toBe(v.read);
    });

    it('answers 404, not 403 — no existence oracle', async () => {
      const unknown = '00000000-0000-7000-8000-000000000000';

      const missing = await request(app.getHttpServer())
        .get(`/conversations/${unknown}`)
        .set('x-org-id', attacker);

      const someoneElses = await request(app.getHttpServer())
        .get(`/conversations/${v.read}`)
        .set('x-org-id', attacker);

      expect(missing.status).toBe(404);
      expect(someoneElses.status).toBe(404);
    });
  });

  describe('2. cross-tenant list', () => {
    it('never includes another org’s rows', async () => {
      const response = await request(app.getHttpServer())
        .get('/conversations')
        .query({ pageSize: 100 })
        .set('x-org-id', attacker)
        .expect(200);

      const ids = (response.body as { items: { id: string }[] }).items.map(
        (item) => item.id,
      );

      expect(ids).toContain(a.own);
      for (const id of Object.values(v)) {
        expect(ids).not.toContain(id);
      }
    });
  });

  describe('3. cross-tenant update', () => {
    it('does not write to another org’s row', async () => {
      await request(app.getHttpServer())
        .patch(`/conversations/${v.update}`)
        .set('x-org-id', attacker)
        .send({ status: 'closed' })
        .expect(404);
    });

    it('and the row is genuinely unchanged when its owner looks', async () => {
      const response = await request(app.getHttpServer())
        .get(`/conversations/${v.update}`)
        .set('x-org-id', victim)
        .expect(200);

      expect((response.body as { status: string }).status).toBe('open');
    });
  });

  describe('4. cross-tenant delete', () => {
    it('does not delete another org’s row', async () => {
      await request(app.getHttpServer())
        .delete(`/conversations/${v.delete}`)
        .set('x-org-id', attacker)
        .expect(404);
    });

    it('and the row still exists for its owner', async () => {
      await request(app.getHttpServer())
        .get(`/conversations/${v.delete}`)
        .set('x-org-id', victim)
        .expect(200);
    });
  });

  describe('5. a join that reaches a tenant-owned row through an unscoped table', () => {
    it('does not return another org’s messages', async () => {
      await request(app.getHttpServer())
        .get(`/conversations/${v.messages}/messages`)
        .set('x-org-id', attacker)
        .expect(404);
    });

    it('and no fragment of them appears in the response body', async () => {
      const response = await request(app.getHttpServer())
        .get(`/conversations/${v.messages}/messages`)
        .set('x-org-id', attacker);

      expect(JSON.stringify(response.body)).not.toContain(SECRET);
    });

    it('control: the owner gets both of them', async () => {
      const response = await request(app.getHttpServer())
        .get(`/conversations/${v.messages}/messages`)
        .set('x-org-id', victim)
        .expect(200);

      expect(response.body).toHaveLength(2);
      expect(JSON.stringify(response.body)).toContain(SECRET);
    });
  });

  describe('6. writing a row out of your own tenant', () => {
    it('is rejected — USING alone would have allowed it', async () => {
      await expect(
        tenants.withOrg(attacker, (tx) =>
          tx.query(
            `UPDATE conversations SET org_id = $1::bigint WHERE id = $2::uuid`,
            [victim, a.move],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('7. bypassing the seam entirely', () => {
    it('a raw unscoped query returns nothing at all', async () => {
      const result = await db.query(
        `SELECT id FROM conversations WHERE id = $1::uuid`,
        [v.read],
      );

      expect(result.rowCount).toBe(0);
    });

    it('including an unscoped count over the whole table', async () => {
      const result = await db.query<{ total: string }>(
        `SELECT count(*) AS total FROM conversations`,
      );

      expect(Number(result.rows[0].total)).toBe(0);
    });
  });

  describe('8. inserting under someone else’s org id', () => {
    it('is rejected', async () => {
      await expect(
        tenants.withOrg(attacker, (tx) =>
          tx.query(
            `INSERT INTO conversations (org_id, status)
             VALUES ($1::bigint, 'open')`,
            [victim],
          ),
        ),
      ).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('9. the scope does not survive the connection going back to the pool', () => {
    it('leaves nothing behind for whoever gets that connection next', async () => {
      const scoped = await tenants.withOrg(victim, (tx) =>
        tx.query(`SELECT id FROM conversations WHERE id = $1::uuid`, [v.read]),
      );
      expect(scoped.rowCount).toBe(1);

      const afterwards = await db.query<{ org: string | null }>(
        `SELECT current_setting($1, true) AS org`,
        ['app.org_id'],
      );
      expect(afterwards.rows[0].org).not.toBe(victim);
      expect(afterwards.rows[0].org ?? '').toBe('');

      const unscoped = await db.query(
        `SELECT id FROM conversations WHERE id = $1::uuid`,
        [v.read],
      );
      expect(unscoped.rowCount).toBe(0);
    });
  });

  describe('the schema audit', () => {
    it('every table carrying org_id has RLS enabled and a policy with WITH CHECK', async () => {
      const result = await db.query<{
        table_name: string;
        rls_enabled: boolean;
        policies: string;
        with_check_policies: string;
      }>(
        `SELECT c.relname AS table_name,
                c.relrowsecurity AS rls_enabled,
                (SELECT count(*) FROM pg_policy p
                  WHERE p.polrelid = c.oid) AS policies,
                (SELECT count(*) FROM pg_policy p
                  WHERE p.polrelid = c.oid
                    AND p.polwithcheck IS NOT NULL) AS with_check_policies
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind = 'r'
            AND EXISTS (SELECT 1 FROM pg_attribute att
                         WHERE att.attrelid = c.oid
                           AND att.attname = 'org_id'
                           AND att.attnum > 0
                           AND NOT att.attisdropped)
          ORDER BY c.relname`,
      );

      expect(result.rows.length).toBeGreaterThan(0);

      const unprotected = result.rows.filter(
        (row) =>
          !row.rls_enabled ||
          Number(row.policies) === 0 ||
          Number(row.with_check_policies) === 0,
      );

      expect(unprotected.map((row) => row.table_name)).toEqual([]);
    });

    it('the role the app serves with cannot bypass those policies', async () => {
      const result = await db.query<{
        role: string;
        is_superuser: boolean;
        bypasses_rls: boolean;
        owns_tables: string;
      }>(
        `SELECT current_user AS role,
                r.rolsuper AS is_superuser,
                r.rolbypassrls AS bypasses_rls,
                (SELECT count(*) FROM pg_class c
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = 'public'
                    AND c.relkind = 'r'
                    AND c.relrowsecurity
                    AND c.relowner = r.oid) AS owns_tables
           FROM pg_roles r
          WHERE r.rolname = current_user`,
      );

      expect(result.rows[0]).toMatchObject({
        is_superuser: false,
        bypasses_rls: false,
        owns_tables: '0',
      });
    });
  });
});
