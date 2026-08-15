import { Test, TestingModule } from '@nestjs/testing';
import { PostgresModule } from '../src/postgres/postgres.module';
import { PostgresService } from '../src/postgres/postgres.service';
import { TenancyModule } from '../src/tenancy/tenancy.module';
import { TenantDb } from '../src/tenancy/tenant-db.service';

/**
 * Proves the migrated schema holds a real tenant end to end: an org, a user, a
 * membership, a conversation and a message go in, and come back out joined.
 *
 * Boots PostgresModule alone rather than AppModule — this is about the schema,
 * not the HTTP surface — but still goes through PostgresService.query(), which
 * is the one chokepoint drill 01 exists to protect.
 *
 * Drill 07 changed the shape of this file, and the change is the mechanism
 * working: every write to a table carrying `org_id` now has to say which tenant
 * it is writing as, because the row-level security policies reject a write that
 * does not. `organizations` and `users` carry no `org_id` and stay unscoped.
 * That is not test scaffolding — it is the same thing the application had to do.
 *
 * Needs a migrated database, so it runs inside the container where env_file has
 * already supplied the credentials: `pnpm db:test` from the repo root.
 */
describe('core schema (e2e)', () => {
  let moduleRef: TestingModule;
  let db: PostgresService;
  let tenants: TenantDb;

  // Tagged so a failed run leaves rows that are obviously test debris, and so
  // nothing collides with the development seed.
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

  // Reverse FK order, because every FK here is NO ACTION — if the order is
  // wrong, this fails loudly instead of silently leaving orphans. The three
  // tenant-owned tables are deleted inside a scope; without one the policies
  // match no rows and these deletes would quietly remove nothing.
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

    // From here on the rows carry org_id, so they are written inside a scope.
    // The same three inserts without one are rejected 42501 — which is case 8
    // of test/tenant-isolation.e2e-spec.ts.
    await tenants.withOrg(ids.org, async (tx) => {
      const membership = await tx.query<{ id: string }>(
        `INSERT INTO memberships (user_id, org_id, role)
         VALUES ($1, $2, 'admin') RETURNING id`,
        [ids.user, ids.org],
      );
      ids.membership = membership.rows[0].id;

      // No subject column — the second migration dropped it.
      const conversation = await tx.query<{ id: string }>(
        `INSERT INTO conversations (org_id, status, assignee_id)
         VALUES ($1, 'open', $2) RETURNING id`,
        [ids.org, ids.membership],
      );
      ids.conversation = conversation.rows[0].id;

      // org_id is written directly, not reached through the conversation. That
      // is the rule the whole schema is built around — and, since drill 07, the
      // rule the policies are built on too.
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

    // The denormalized copy agrees with the joined-to owner. Nothing in the
    // schema enforces that yet — see the deferred composite FK in
    // plans/2026-08-07_drill-02-schema-and-migrations.md.
    expect(readBack.rows[0].message_org_id).toBe(ids.org);

    // timestamptz round-trips as a Date, not a string.
    expect(readBack.rows[0].created_at).toBeInstanceOf(Date);
  });

  it('defaults the conversation id to a v7 uuid', () => {
    // 8-4-4-4-12, with the version nibble at the start of the third group.
    expect(ids.conversation).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('surfaces a CHECK violation as an identifiable pg error', async () => {
    // The STRETCH. A naive insert of a plan that is not in the CHECK list has to
    // come back as something an API layer can act on — not a 500 with a string.
    expect.assertions(3);

    try {
      await db.query(
        `INSERT INTO organizations (name, plan) VALUES ($1, 'enterprise')`,
        [`${tag}-invalid`],
      );
    } catch (error) {
      const pgError = error as { code?: string; constraint?: string };

      // 23514 = check_violation. The class (23) is integrity constraint
      // violation; PostgresService already treats the whole 23 class as fatal
      // and refuses to retry it, which is right — a retry would fail identically.
      expect(pgError.code).toBe('23514');
      // Named in the migration precisely so this is possible. An unnamed
      // constraint would still give a name, just a generated one that changes
      // if the column is ever recreated.
      expect(pgError.constraint).toBe('organizations_plan_check');
      // The message is for logs, not for callers — it names the table and the
      // constraint, nothing about which value was wrong.
      expect(String(error)).toContain('organizations_plan_check');
    }
  });
});
