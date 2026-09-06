import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { API_KEY_PREFIX, hashApiKey } from '../src/ingest/api-key.guard';
import {
  IngestResult,
  PERIOD_SQL,
  QUOTA,
  QUOTA_METRIC,
} from '../src/ingest/ingest.service';
import { PostgresService } from '../src/postgres/postgres.service';
import { TenantDb } from '../src/tenancy/tenant-db.service';

/**
 * Card 13's step one, and the card is right that it is the hard half.
 *
 * The bug is a lost update: two deliveries read the counter, both add one to
 * the same number, and one increment disappears. Every request returns 201.
 * Nothing errors. A sequential test passes on every arm, which is exactly why
 * this suite fires them concurrently and compares the counter against a ledger
 * that cannot be wrong.
 *
 * `usage_events` is that ledger. An INSERT has no read-modify-write, so it
 * cannot lose a row — `counter == ledger` is therefore an assertion about the
 * counter alone, and it needs nothing from this process to be true.
 *
 * One assertion is *expected to fail* on a non-default arm, and that red run is
 * the deliverable:
 *
 *   pnpm db:test:rmw           QUOTA=rmw            the lost update
 *   pnpm db:test:locking       QUOTA=locking        green
 *   pnpm db:test:serializable  QUOTA=serializable   green
 *
 * The card's literal 100 concurrent lives in `pnpm db:quota fire`, which is the
 * wrong shape for a suite that has to stay fast. The mechanism is
 * scale-independent — a race is a race at 40 requests as at 100 — and the
 * reliability of the red run at this size was verified rather than assumed; see
 * the plan file.
 *
 * See plans/2026-09-07_drill-13-lost-update.md.
 */
describe('quota counter (e2e)', () => {
  let app: INestApplication<App>;
  let db: PostgresService;
  let tenants: TenantDb;

  const tag = `quota-e2e-${Date.now()}`;
  const key = `${API_KEY_PREFIX}${tag}`;

  let orgId: string;

  // Enough to collide reliably through a pool of ten, small enough to run in
  // about a second. Every event id is DISTINCT — the opposite of drill 12's
  // storm, where the interesting request was the duplicate. Here every delivery
  // is billable, so all of them contend on one counter row.
  const CONCURRENT = 40;

  const post = (body: unknown) =>
    request(app.getHttpServer())
      .post('/ingest')
      .set('Authorization', `Bearer ${key}`)
      .send(body as object);

  const ingested = (response: request.Response) =>
    response.body as IngestResult;

  /** The meter and its oracle. `used` is a cache of `ledger`; a gap between
   *  them is the lost updates, in whole billable events. */
  const meter = () =>
    tenants.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query<{ used: string; ledger: string }>(
        `SELECT coalesce(c.used, 0)::text AS used,
                (SELECT count(*) FROM usage_events e
                  WHERE e.org_id = $1::bigint AND e.period = ${PERIOD_SQL}
                    AND e.metric = $2)::text AS ledger
           FROM (SELECT 1) one
           LEFT JOIN usage_counters c
             ON c.org_id = $1::bigint AND c.period = ${PERIOD_SQL}
                AND c.metric = $2`,
        [orgId, QUOTA_METRIC],
      );
      return {
        used: Number(rows[0].used),
        ledger: Number(rows[0].ledger),
      };
    });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();

    // listen(0), not init(). supertest starts an ephemeral server per request
    // for an app that is not already listening, and forty of those at once fail
    // in the CLIENT with nothing wrong server-side — which reads exactly like
    // the endpoint breaking under concurrency. Drill 12 paid for this once.
    await app.listen(0);

    db = app.get(PostgresService);
    tenants = app.get(TenantDb);

    orgId = (
      await db.query<{ id: string }>(
        `INSERT INTO organizations (name, plan) VALUES ($1, 'pro') RETURNING id`,
        [`${tag}-org`],
      )
    ).rows[0].id;

    // No RETURNING: app_user has no SELECT on api_keys and Postgres requires
    // SELECT on any column a RETURNING clause reads. See migration
    // 1788134400000.
    await tenants.withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO api_keys (org_id, name, key_hash)
         VALUES ($1::bigint, 'quota', $2)`,
        [orgId, hashApiKey(key)],
      ),
    );
  });

  afterAll(async () => {
    if (orgId) {
      await tenants.withOrg(orgId, async (tx) => {
        await tx.query(`DELETE FROM usage_events WHERE org_id = $1::bigint`, [
          orgId,
        ]);
        await tx.query(`DELETE FROM usage_counters WHERE org_id = $1::bigint`, [
          orgId,
        ]);
        await tx.query(`DELETE FROM messages WHERE org_id = $1::bigint`, [
          orgId,
        ]);
        await tx.query(`DELETE FROM conversations WHERE org_id = $1::bigint`, [
          orgId,
        ]);
        // Filterless on purpose: app_user has no SELECT on api_keys, so a WHERE
        // clause is `permission denied`. The policy's USING is applied by the
        // system and scopes this to one org.
        await tx.query(`DELETE FROM api_keys`);
      });
      await db.query(`DELETE FROM organizations WHERE id = $1::bigint`, [
        orgId,
      ]);
    }
    await app?.close();
  });

  describe('one delivery at a time', () => {
    it('bills a created delivery and does not bill its duplicate', async () => {
      const before = await meter();

      const created = await post({
        eventId: `${tag}-single`,
        message: 'first delivery',
      });
      expect(created.status).toBe(201);
      expect(ingested(created).quotaUsed).toBe(before.used + 1);

      const duplicate = await post({
        eventId: `${tag}-single`,
        message: 'second delivery of the same event',
      });
      expect(duplicate.status).toBe(200);
      // null, not `before.used + 1`: a duplicate must not move the meter, and
      // saying "we did not bill" is different from reporting the total.
      expect(ingested(duplicate).quotaUsed).toBeNull();

      const after = await meter();
      expect(after.used).toBe(before.used + 1);
      expect(after.ledger).toBe(before.ledger + 1);
    });

    it('reports which arm answered, so a measurement never has to guess', async () => {
      const response = await post({
        eventId: `${tag}-arm`,
        message: 'which arm',
      });
      expect(response.status).toBe(201);
      expect(ingested(response).quota).toBe(QUOTA);
    });
  });

  describe(`${CONCURRENT} concurrent deliveries`, () => {
    // Every id distinct, so every one of them is billable and all of them
    // contend on the same counter row.
    const ids = Array.from(
      { length: CONCURRENT },
      (_, i) => `${tag}-burst-${String(i).padStart(4, '0')}`,
    );

    let responses: request.Response[];
    let before: { used: number; ledger: number };
    let after: { used: number; ledger: number };

    beforeAll(async () => {
      before = await meter();
      responses = await Promise.all(
        ids.map((eventId) => post({ eventId, message: `burst ${eventId}` })),
      );
      after = await meter();
    });

    it('creates one conversation per event', () => {
      expect(responses.filter((r) => r.status === 201)).toHaveLength(
        CONCURRENT,
      );
    });

    it('writes one ledger row per created delivery', () => {
      expect(after.ledger - before.ledger).toBe(CONCURRENT);
    });

    // THE CARD'S TEST. Red on QUOTA=rmw and green on the three fixes, and it is
    // the whole drill in four lines.
    it('leaves the counter equal to the number of increments', () => {
      expect(after.used - before.used).toBe(CONCURRENT);
    });

    // The same claim without trusting this process's own arithmetic. The ledger
    // is append-only, so where these two disagree the counter is what is wrong.
    it('leaves the counter equal to the ledger', () => {
      expect(after.used).toBe(after.ledger);
    });
  });
});
