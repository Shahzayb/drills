import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { API_KEY_PREFIX, hashApiKey } from '../src/ingest/api-key.guard';
import { IDEMPOTENCY, IngestResult } from '../src/ingest/ingest.service';
import { PostgresService } from '../src/postgres/postgres.service';
import { RedisService } from '../src/redis/redis.service';
import { TenantDb } from '../src/tenancy/tenant-db.service';

/**
 * Card 12's proof for `POST /ingest`: real HTTP through the real module graph,
 * against a real Postgres and a real Redis. Nothing is mocked, because the two
 * things this spec exists to demonstrate — a unique index arbitrating between
 * concurrent transactions, and a SETNX that only one caller can win — are both
 * properties of the running store rather than of any code here.
 *
 * Three assertions are *expected to fail* on non-default arms, and those red
 * runs are the deliverable rather than an accident:
 *
 *   pnpm db:test:noidem      IDEMPOTENCY=none      the storm case, 2 failures
 *   pnpm db:test:redis       IDEMPOTENCY=redis     1 failure: the 202
 *   pnpm db:test:donothing   ON_CONFLICT=nothing   1 failure: the same 202,
 *                                                  reached a different way
 *
 * `db:test:redis` failing is not the Redis arm being broken. It is the card's
 * question — "the failure mode of the Redis version that the constraint version
 * doesn't have" — expressed as a test rather than as prose: the guard can tell a
 * duplicate that it is a duplicate, and cannot tell it which conversation it
 * duplicates, because the winner has not committed and Redis cannot wait.
 *
 * See plans/2026-08-31_drill-12-idempotent-ingest.md.
 */
describe('POST /ingest (e2e)', () => {
  let app: INestApplication<App>;
  let db: PostgresService;
  let tenants: TenantDb;
  let redis: RedisService;

  const tag = `ingest-e2e-${Date.now()}`;

  let orgId: string;
  let otherOrgId: string;

  // Plaintext, held only here. The database has the sha256 and nothing else.
  const key = `${API_KEY_PREFIX}${tag}-primary`;
  const otherKey = `${API_KEY_PREFIX}${tag}-other`;
  const revokedKey = `${API_KEY_PREFIX}${tag}-revoked`;

  // The storm, scaled to run in a second. The mechanism is scale-independent —
  // a race is a race at 60 requests as at 10,000 — and the card's literal
  // 10,000 lives in `pnpm db:storm fire`, which is the wrong shape for a suite
  // that has to stay fast. Copies of one event are dispatched adjacently, which
  // is what makes them collide; see the storm instrument on why a shuffled
  // storm proves nothing.
  const STORM_UNIQUE = 20;
  const STORM_COPIES = 3;

  const post = (body: unknown, bearer: string | null = key) => {
    const req = request(app.getHttpServer()).post('/ingest');
    if (bearer) req.set('Authorization', `Bearer ${bearer}`);
    return req.send(body as object);
  };

  /** supertest types `body` as `any`. Reading it through one typed helper keeps
   *  that `any` in a single place instead of at every assertion. */
  const ingested = (response: request.Response) =>
    response.body as IngestResult;

  const event = (id: string, message = 'a customer wrote in') => ({
    eventId: `${tag}-${id}`,
    message,
  });

  /** How many conversations and messages this org actually holds for an event. */
  const rowsFor = async (org: string, eventId: string) =>
    tenants.withOrg(org, async (tx) => {
      const conversations = await tx.query<{ id: string }>(
        `SELECT id FROM conversations
          WHERE org_id = $1::bigint AND provider_event_id = $2`,
        [org, eventId],
      );
      const messages = await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM messages
          WHERE conversation_id = ANY($1::uuid[])`,
        [conversations.rows.map((r) => r.id)],
      );
      return {
        conversations: conversations.rows.length,
        messages: Number(messages.rows[0].n),
        id: conversations.rows[0]?.id,
      };
    });

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();

    // listen(0), not init(). supertest starts its own ephemeral server for any
    // app that is not already listening — one per request — and sixty of those
    // at once is what the storm below produces. The requests then fail in the
    // client with no server-side error anywhere, which reads exactly like the
    // endpoint breaking under concurrency. It is not; it is the harness.
    // A listening app is reused by every `request()` call instead.
    await app.listen(0);

    db = app.get(PostgresService);
    tenants = app.get(TenantDb);
    redis = app.get(RedisService);

    const orgs = await db.query<{ id: string; name: string }>(
      `INSERT INTO organizations (name, plan)
       VALUES ($1, 'pro'), ($2, 'free')
       RETURNING id, name`,
      [`${tag}-org`, `${tag}-other-org`],
    );
    const byName = new Map(orgs.rows.map((row) => [row.name, row.id]));
    orgId = byName.get(`${tag}-org`)!;
    otherOrgId = byName.get(`${tag}-other-org`)!;

    // One scope per org, not one statement across both: an RLS policy filters
    // per row against a single current tenant, so a two-org INSERT fails its
    // WITH CHECK on whichever half is not the current one.
    //
    // And no RETURNING, deliberately. app_user has no SELECT on api_keys (see
    // migration 1788134400000) and Postgres requires SELECT on any column a
    // RETURNING clause reads — so `RETURNING id` here is `permission denied`.
    // Only the hash is ever stored; the plaintext lives in this file and nowhere
    // else, which is what the revoked case below relies on.
    await tenants.withOrg(orgId, (tx) =>
      tx.query(
        `INSERT INTO api_keys (org_id, name, key_hash, revoked_at)
         VALUES ($1::bigint, 'primary', $2, NULL),
                ($1::bigint, 'revoked', $3, now())`,
        [orgId, hashApiKey(key), hashApiKey(revokedKey)],
      ),
    );
    await tenants.withOrg(otherOrgId, (tx) =>
      tx.query(
        `INSERT INTO api_keys (org_id, name, key_hash)
         VALUES ($1::bigint, 'other', $2)`,
        [otherOrgId, hashApiKey(otherKey)],
      ),
    );
  });

  afterAll(async () => {
    if (orgId) {
      // One scope per org: a policy filters per row against a single current
      // tenant, so a combined `WHERE org_id = ANY(...)` would clean up one org
      // and silently leave the other's rows behind.
      for (const id of [orgId, otherOrgId]) {
        await tenants.withOrg(id, async (tx) => {
          await tx.query(`DELETE FROM messages WHERE org_id = $1::bigint`, [
            id,
          ]);
          await tx.query(
            `DELETE FROM conversations WHERE org_id = $1::bigint`,
            [id],
          );
          // Filterless on purpose, and it has to be: app_user has no SELECT on
          // api_keys, and a WHERE clause reads a column. The policy's USING is
          // applied by the system and needs no privilege, so this removes
          // exactly this org's keys. Same shape as drill 07's endpoints.
          await tx.query(`DELETE FROM api_keys`);
        });
      }
      await db.query(`DELETE FROM organizations WHERE id = ANY($1::bigint[])`, [
        [orgId, otherOrgId],
      ]);
    }
    await app.close();
  });

  // -------------------------------------------------------------------- auth

  describe('authentication', () => {
    it('rejects a request with no Authorization header', async () => {
      await post(event('noauth'), null).expect(401);
    });

    it('rejects a malformed Authorization header', async () => {
      await request(app.getHttpServer())
        .post('/ingest')
        .set('Authorization', key)
        .send(event('malformed'))
        .expect(401);
    });

    it('rejects an unknown key', async () => {
      await post(event('unknown'), `${API_KEY_PREFIX}nope`).expect(401);
    });

    /** revoked_at is checked inside app_org_for_api_key(), not in the guard —
     *  so a key cannot be un-revoked by a code path that forgot the column. */
    it('rejects a revoked key', async () => {
      await post(event('revoked'), revokedKey).expect(401);
    });

    /**
     * The reason this route ignores X-Org-Id rather than falling back to it.
     * A fallback would make the authentication stub a bypass on the one route
     * that has real credentials.
     */
    it('ignores X-Org-Id and uses the key’s org', async () => {
      const body = event('header-ignored');
      await request(app.getHttpServer())
        .post('/ingest')
        .set('Authorization', `Bearer ${key}`)
        .set('X-Org-Id', otherOrgId)
        .send(body)
        .expect(201);

      const mine = await rowsFor(orgId, body.eventId);
      const theirs = await rowsFor(otherOrgId, body.eventId);
      expect(mine.conversations).toBe(1);
      expect(theirs.conversations).toBe(0);
    });
  });

  // -------------------------------------------------------------- validation

  describe('validation', () => {
    it('rejects an eventId shorter than the floor', async () => {
      await post({ eventId: 'short', message: 'hi' }).expect(400);
    });

    /** The charset matters because the id becomes a Redis key, where a space is
     *  legal and silently produces a different key than the next delivery
     *  computes — a guard that stops guarding with no error anywhere. */
    it('rejects an eventId outside the allowed charset', async () => {
      await post({ eventId: 'has spaces here', message: 'hi' }).expect(400);
    });

    it('rejects an unknown property rather than dropping it', async () => {
      await post({ ...event('extra'), orgId: '1' }).expect(400);
    });
  });

  // ------------------------------------------------------------- the happy path

  describe('the happy path', () => {
    it('creates a conversation and its first message', async () => {
      const body = event('create');
      const response = await post(body).expect(201);

      expect(ingested(response).duplicate).toBe(false);
      expect(ingested(response).conversationId).toEqual(expect.any(String));

      const rows = await rowsFor(orgId, body.eventId);
      expect(rows.conversations).toBe(1);
      expect(rows.messages).toBe(1);
      expect(rows.id).toBe(ingested(response).conversationId);
    });

    /**
     * The `xmax = 0` discriminator, asserted directly.
     *
     * It is an implementation detail rather than documented API, and the whole
     * created/duplicate contract of this endpoint rests on it. Drill 08's rule:
     * a mechanism nobody would notice breaking needs a test that fails when it
     * breaks. This is that test.
     */
    it('reports a sequential redelivery as a duplicate, with the same id', async () => {
      const body = event('sequential');

      const first = await post(body).expect(201);
      const second = await post(body).expect(200);

      expect(ingested(first).duplicate).toBe(false);
      expect(ingested(second).duplicate).toBe(true);
      expect(ingested(second).conversationId).toBe(
        ingested(first).conversationId,
      );

      const rows = await rowsFor(orgId, body.eventId);
      expect(rows.conversations).toBe(1);
      // The one that catches a duplicate appending a second message to an
      // existing conversation — a bug the row count alone cannot see.
      expect(rows.messages).toBe(1);
    });

    /** Event ids are per tenant, which is why the unique index leads with
     *  org_id and the Redis key embeds it. Two providers numbering their events
     *  from 1 must not silently suppress each other. */
    it('treats the same event id in two orgs as two events', async () => {
      const body = event('cross-tenant');

      await post(body, key).expect(201);
      await post(body, otherKey).expect(201);

      expect((await rowsFor(orgId, body.eventId)).conversations).toBe(1);
      expect((await rowsFor(otherOrgId, body.eventId)).conversations).toBe(1);
    });

    it('stays inside its query budget', async () => {
      const response = await post(event('budget')).expect(201);
      expect(Number(response.headers['x-query-count'])).toBeLessThanOrEqual(3);
    });
  });

  // ------------------------------------------------------------- the storm

  describe('a duplicate storm', () => {
    const eventIds = Array.from(
      { length: STORM_UNIQUE },
      (_, i) => `${tag}-storm-${String(i).padStart(3, '0')}`,
    );

    let statuses: number[] = [];

    beforeAll(async () => {
      // Copies of one event adjacent to each other, all dispatched before any
      // resolves. Shuffled, the copies land far enough apart that the winner has
      // committed before the next arrives and nothing races at all — the test
      // would pass on every arm including `none`.
      const inFlight = eventIds.flatMap((eventId) =>
        Array.from({ length: STORM_COPIES }, () =>
          post({ eventId, message: `storm ${eventId}` }).then(
            (r) => r.status,
            () => 500,
          ),
        ),
      );

      statuses = await Promise.all(inFlight);
    });

    /**
     * The card's DONE WHEN. Green on `constraint`, `redis` and `both`; red on
     * `none`, where the SELECT and the INSERT of check-then-insert interleave
     * and the unique index turns the loser into a 23505.
     */
    it('creates exactly one conversation per event', async () => {
      const created = statuses.filter((s) => s === 201).length;
      const failed = statuses.filter((s) => s >= 500).length;

      const counts = await Promise.all(
        eventIds.map((id) => rowsFor(orgId, id)),
      );

      expect(failed).toBe(0);
      expect(created).toBe(STORM_UNIQUE);
      expect(counts.map((c) => c.conversations)).toEqual(
        Array(STORM_UNIQUE).fill(1),
      );
      expect(counts.map((c) => c.messages)).toEqual(
        Array(STORM_UNIQUE).fill(1),
      );
    });

    /**
     * The property only the constraint has, and the card's "failure mode of the
     * Redis version" as an assertion.
     *
     * `ON CONFLICT ... DO UPDATE` takes a row lock on the conflicting tuple, so
     * a concurrent duplicate BLOCKS until the winner commits and then gets the
     * id. Redis cannot block on a Postgres transaction, and `DO NOTHING` cannot
     * see an uncommitted row, so both of those arms answer 202 instead.
     *
     * Expected red under `pnpm db:test:redis` and `pnpm db:test:donothing`.
     */
    it('answers every concurrent duplicate with the conversation id', () => {
      const pending = statuses.filter((s) => s === 202).length;
      const duplicates = statuses.filter((s) => s === 200).length;

      expect(pending).toBe(0);
      expect(duplicates).toBe(STORM_UNIQUE * (STORM_COPIES - 1));
    });
  });

  // -------------------------------------------------------- the guard itself

  describe('the Redis guard', () => {
    it('holds the conversation id once the write has committed', async () => {
      if (IDEMPOTENCY !== 'redis' && IDEMPOTENCY !== 'both') return;

      const body = event('guard-value');
      const response = await post(body).expect(201);

      // Not an internal detail worth hiding: the value IS the mechanism. A
      // guard still holding 'pending' after a committed write is what makes
      // every later duplicate a 202 instead of a 200.
      const held = await redis.get(`idem:${orgId}:${body.eventId}`);
      expect(held).toBe(ingested(response).conversationId);
    });
  });
});
