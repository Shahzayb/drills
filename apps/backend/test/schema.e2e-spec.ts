import { Test, TestingModule } from '@nestjs/testing';
import { PostgresModule } from '../src/postgres/postgres.module';
import { PostgresService } from '../src/postgres/postgres.service';
import { TenancyModule } from '../src/tenancy/tenancy.module';
import { TenantDb } from '../src/tenancy/tenant-db.service';

describe('core schema (e2e)', () => {
  let moduleRef: TestingModule;
  let db: PostgresService;
  let tenants: TenantDb;

  const tag = `schema-e2e-${Date.now()}`;

  const ids: {
    org?: string;
    user?: string;
    membership?: string;
    conversation?: string;
    message?: string;
  } = {};

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PostgresModule, TenancyModule],
    }).compile();

    db = moduleRef.get(PostgresService);
    tenants = moduleRef.get(TenantDb);
  });

  afterAll(async () => {
    if (ids.org) {
      await tenants.withOrg(ids.org, async (tx) => {
        if (ids.message) {
          await tx.query('DELETE FROM messages WHERE id = $1', [ids.message]);
        }
        if (ids.conversation) {
          await tx.query('DELETE FROM conversations WHERE id = $1', [
            ids.conversation,
          ]);
        }
        if (ids.membership) {
          await tx.query('DELETE FROM memberships WHERE id = $1', [
            ids.membership,
          ]);
        }
      });
    }
    if (ids.user) {
      await db.query('DELETE FROM users WHERE id = $1', [ids.user]);
    }
    if (ids.org) {
      await db.query('DELETE FROM organizations WHERE id = $1', [ids.org]);
    }

    await moduleRef.close();
  });

  it('inserts one row of each table and reads them back joined', async () => {
    const org = await db.query<{ id: string }>(
      `INSERT INTO organizations (name, plan) VALUES ($1, 'pro') RETURNING id`,
      [`${tag}-org`],
    );
    ids.org = org.rows[0].id;

    const user = await db.query<{ id: string }>(
      `INSERT INTO users (name) VALUES ($1) RETURNING id`,
      [`${tag}-user`],
    );
    ids.user = user.rows[0].id;

    await tenants.withOrg(ids.org, async (tx) => {
      const membership = await tx.query<{ id: string }>(
        `INSERT INTO memberships (user_id, org_id, role)
         VALUES ($1, $2, 'admin') RETURNING id`,
        [ids.user, ids.org],
      );
      ids.membership = membership.rows[0].id;

      const conversation = await tx.query<{ id: string }>(
        `INSERT INTO conversations (org_id, status, assignee_id)
         VALUES ($1, 'open', $2) RETURNING id`,
        [ids.org, ids.membership],
      );
      ids.conversation = conversation.rows[0].id;

      const message = await tx.query<{ id: string }>(
        `INSERT INTO messages (conversation_id, org_id, message)
         VALUES ($1, $2, $3) RETURNING id`,
        [ids.conversation, ids.org, 'first message'],
      );
      ids.message = message.rows[0].id;
    });

    const readBack = await tenants.withOrg(ids.org, (tx) =>
      tx.query<{
        org_name: string;
        user_name: string;
        role: string;
        status: string;
        message: string;
        message_org_id: string;
        created_at: Date;
      }>(
        `SELECT o.name   AS org_name,
                u.name   AS user_name,
                mem.role AS role,
                c.status AS status,
                m.message,
                m.org_id AS message_org_id,
                m.created_at
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           JOIN memberships mem ON mem.id = c.assignee_id
           JOIN users u         ON u.id = mem.user_id
           JOIN organizations o ON o.id = c.org_id
          WHERE m.id = $1`,
        [ids.message],
      ),
    );

    expect(readBack.rowCount).toBe(1);
    expect(readBack.rows[0]).toMatchObject({
      org_name: `${tag}-org`,
      user_name: `${tag}-user`,
      role: 'admin',
      status: 'open',
      message: 'first message',
    });

    expect(readBack.rows[0].message_org_id).toBe(ids.org);

    expect(readBack.rows[0].created_at).toBeInstanceOf(Date);
  });

  it('defaults the conversation id to a v7 uuid', () => {
    expect(ids.conversation).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('surfaces a CHECK violation as an identifiable pg error', async () => {
    expect.assertions(3);

    try {
      await db.query(
        `INSERT INTO organizations (name, plan) VALUES ($1, 'enterprise')`,
        [`${tag}-invalid`],
      );
    } catch (error) {
      const pgError = error as { code?: string; constraint?: string };

      expect(pgError.code).toBe('23514');
      expect(pgError.constraint).toBe('organizations_plan_check');
      expect(String(error)).toContain('organizations_plan_check');
    }
  });
});
