import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { TenantDb, TenantQuery } from '../tenancy/tenant-db.service';
import { IngestEventDto } from './dto/ingest-event.dto';

/**
 * Which mechanism makes a duplicate delivery harmless. Read once at module
 * load, same as LIST_STRATEGY and SEARCH_STRATEGY and for the same reason: an
 * A/B whose arms are two different checkouts measures the checkout.
 *
 * - `none`        check-then-insert, the version everyone writes first. It is
 *                 a TOCTOU race and it is here to be measured, not shipped.
 * - `constraint`  the unique index does the work, inside the transaction.
 * - `redis`       a SETNX guard in front of the database, and nothing else.
 * - `both`        the guard as a fast path, the constraint as the guarantee.
 *
 * `both` is the default because it is what you would actually ship. The three
 * others are permanent measurement arms, the way `naive` and `like` are.
 */
export type IdempotencyMode = 'none' | 'constraint' | 'redis' | 'both';

const MODES: IdempotencyMode[] = ['none', 'constraint', 'redis', 'both'];

export const IDEMPOTENCY: IdempotencyMode = MODES.includes(
  process.env.IDEMPOTENCY as IdempotencyMode,
)
  ? (process.env.IDEMPOTENCY as IdempotencyMode)
  : 'both';

/**
 * Which shape the `ON CONFLICT` clause takes.
 *
 * - `update`   a no-op assignment. Returns the conflicting row, so one
 *              statement answers. Costs a dead tuple per duplicate.
 * - `nothing`  returns zero rows on conflict, so the id needs a follow-up
 *              SELECT: two statements, and no dead tuple.
 *
 * MEASURED, because the obvious reasoning about this is wrong. Both shapes take
 * the speculative-insertion lock and BOTH block until the concurrent inserter
 * commits — `DO NOTHING` does not skip the wait. And because this app runs at
 * READ COMMITTED, where every statement takes a fresh snapshot, the follow-up
 * SELECT runs after the winner has committed and does see the row.
 *
 * So under READ COMMITTED the two shapes differ in COST, not correctness:
 * one round trip against two, one dead tuple against none. The plan predicted a
 * correctness gap and there is not one. `pnpm db:storm race` is the experiment.
 *
 * Raise the isolation level and both shapes fail instead — 40001, could not
 * serialize access due to concurrent update — which is a different problem with
 * a different fix (retry the transaction), not this one.
 */
export type ConflictShape = 'update' | 'nothing';

export const ON_CONFLICT: ConflictShape =
  process.env.ON_CONFLICT === 'nothing' ? 'nothing' : 'update';

/**
 * How long a Redis guard lives.
 *
 * On the `redis` arm this is a CORRECTNESS parameter: it has to cover the
 * provider's maximum retry horizon, or a late replay walks in as a new event.
 * On `both` it is only a cost parameter, because the constraint is still there
 * when the guard expires. 24h is a placeholder for "look up your provider's
 * documented retry window" and is deliberately not defended as a universal
 * number.
 */
export const IDEMPOTENCY_TTL_SECONDS = Number(
  process.env.IDEMPOTENCY_TTL_SECONDS || '86400',
);

/** What the guard holds between the SETNX and the commit. Anything that is not
 *  this is a conversation id. */
const PENDING = 'pending';

interface IngestRow {
  id: string;
  created: boolean;
}

export interface IngestResult {
  /** Null only on `pending` — the one case where nobody can name the row. */
  conversationId: string | null;
  duplicate: boolean;
  /**
   * `created` -> 201, `duplicate` -> 200, `pending` -> 202. Mapped by the
   * controller; the service does not know about HTTP.
   */
  outcome: 'created' | 'duplicate' | 'pending';
  /** Echoed so a measurement can tell which arm answered without reading the
   *  container's environment. */
  mode: IdempotencyMode;
}

@Injectable()
export class IngestService {
  constructor(
    private readonly tenants: TenantDb,
    private readonly redis: RedisService,
  ) {}

  private readonly usesRedis =
    IDEMPOTENCY === 'redis' || IDEMPOTENCY === 'both';
  private readonly usesConstraint =
    IDEMPOTENCY === 'constraint' || IDEMPOTENCY === 'both';

  /**
   * The Redis key.
   *
   * The org is in it for the same reason it is the leading column of the unique
   * index: two tenants may legitimately be sent the same provider event id, and
   * those are two different events. A global key would make one tenant's
   * traffic silently suppress another's — a cross-tenant data loss with no
   * error anywhere.
   */
  private guardKey = (orgId: string, eventId: string) =>
    `idem:${orgId}:${eventId}`;

  async ingest(orgId: string, event: IngestEventDto): Promise<IngestResult> {
    const key = this.guardKey(orgId, event.eventId);

    // Whether THIS caller created the guard. Only the owner writes the id back
    // and only the owner releases it — a loser that deleted the key on its own
    // failure would be releasing the winner's guard, and the next duplicate
    // would sail past into a second write.
    let ownsGuard = false;

    if (this.usesRedis) {
      ownsGuard = await this.redis.setIfAbsent(
        key,
        PENDING,
        IDEMPOTENCY_TTL_SECONDS,
      );

      if (!ownsGuard) {
        const held = await this.redis.get(key);

        // A real id: the winner committed and wrote it back, so this duplicate
        // is answered without touching Postgres at all. That is the whole
        // latency case for the guard, and it is the common case once a storm
        // has been running for more than a few milliseconds.
        if (held && held !== PENDING) {
          return {
            conversationId: held,
            duplicate: true,
            outcome: 'duplicate',
            mode: IDEMPOTENCY,
          };
        }

        // Still 'pending' (or gone, if it expired between the SET and the GET).
        // The winner has not committed and Redis has no way to make this caller
        // wait for it.
        //
        // On `both` that is not the end of the story: fall through to the
        // constraint, whose speculative-insertion lock does the waiting Redis
        // cannot. THIS is what the second mechanism buys and why the arms are
        // not redundant — the guard is a fast path, and when it cannot answer,
        // something behind it has to.
        //
        // On the pure `redis` arm there is nothing behind it. 202 is then the
        // only honest answer: the event is known, the row cannot be named. That
        // 202 is the one assertion `pnpm db:test:redis` fails on, and it is the
        // card's "failure mode the constraint version doesn't have" as a test.
        if (!this.usesConstraint) {
          return {
            conversationId: null,
            duplicate: true,
            outcome: 'pending',
            mode: IDEMPOTENCY,
          };
        }
      }
    }

    try {
      const result = await this.write(orgId, event);

      // Replace the placeholder with the id, so the NEXT duplicate short-
      // circuits. Best-effort: a failure here costs a Postgres round trip on
      // the next duplicate, not correctness.
      if (ownsGuard && result.conversationId) {
        await this.redis
          .set(key, result.conversationId, IDEMPOTENCY_TTL_SECONDS)
          .catch(() => undefined);
      }

      return result;
    } catch (error) {
      // The compensating release. This NARROWS the window and does not close
      // it: a process that dies between the SETNX above and this catch leaves
      // the guard held with nothing behind it, and the event is lost until the
      // TTL expires. The guard and the commit are in two different systems and
      // no amount of code here makes them one transaction. That is the failure
      // mode the constraint does not have.
      if (ownsGuard) {
        await this.redis.del(key).catch(() => undefined);
      }
      throw error;
    }
  }

  /** One transaction either way: the conversation and its first message are one
   *  atomic unit, or a retry finds a conversation with no message in it. */
  private write(orgId: string, event: IngestEventDto): Promise<IngestResult> {
    return this.tenants.withOrg(orgId, async (tx) => {
      // Three paths, not two. The pure `redis` arm inserts straight in: the
      // guard has already decided this event is new, so a SELECT in front of
      // the INSERT would be a second mechanism the arm is not supposed to have,
      // and would price the guard against a comparison it never makes.
      const row = this.usesConstraint
        ? await this.upsert(tx, orgId, event)
        : this.usesRedis
          ? await this.plainInsert(tx, orgId, event)
          : await this.checkThenInsert(tx, orgId, event);

      if (!row) {
        return {
          conversationId: null,
          duplicate: true,
          outcome: 'pending' as const,
          mode: IDEMPOTENCY,
        };
      }

      return {
        conversationId: row.id,
        duplicate: !row.created,
        outcome: row.created ? ('created' as const) : ('duplicate' as const),
        mode: IDEMPOTENCY,
      };
    });
  }

  /**
   * The constraint arm. One statement on `update`, two on `nothing`, atomic by
   * construction either way — the uniqueness decision and the write are the
   * same transaction, which is the whole property Redis cannot have.
   *
   * The `WHERE provider_event_id IS NOT NULL` in the conflict target is not
   * optional. The index is partial, and Postgres will not match a statement to
   * a partial index unless the inference clause repeats its predicate — without
   * it this raises 42P10, "no unique or exclusion constraint matching the ON
   * CONFLICT specification".
   *
   * `first_message` is never selected from, and runs anyway: a data-modifying
   * CTE executes exactly once and to completion whether or not the primary
   * query reads its output. `WHERE created` is what keeps a duplicate from
   * appending a second message to a conversation that already has one.
   *
   * `xmax = 0` is the created-vs-duplicate discriminator. It is an
   * implementation detail rather than documented API — a freshly inserted tuple
   * has no xmax, one produced by the DO UPDATE path does. It is load-bearing
   * enough that test/ingest.e2e-spec.ts asserts on it directly, so it goes red
   * the day it stops being true.
   */
  private async upsert(
    tx: TenantQuery,
    orgId: string,
    event: IngestEventDto,
  ): Promise<IngestRow | null> {
    const action =
      ON_CONFLICT === 'update'
        ? // A no-op assignment, and it has to assign something: DO UPDATE has no
          // empty form. Writing the column back to itself takes the row lock and
          // costs one dead tuple.
          `DO UPDATE SET provider_event_id = EXCLUDED.provider_event_id`
        : `DO NOTHING`;

    const { rows } = await tx.query<IngestRow>(
      `WITH ingested AS (
         INSERT INTO conversations (org_id, status, provider_event_id)
         VALUES ($1::bigint, $4, $2)
         ON CONFLICT (org_id, provider_event_id) WHERE provider_event_id IS NOT NULL
           ${action}
         RETURNING id, xmax = 0 AS created
       ), first_message AS (
         INSERT INTO messages (conversation_id, org_id, message)
         SELECT id, $1::bigint, $3 FROM ingested WHERE created
       )
       SELECT id, created FROM ingested`,
      [orgId, event.eventId, event.message, event.status],
    );

    if (rows.length) return rows[0];

    // The `nothing` arm's second statement, and the reason that arm costs an
    // extra round trip. At READ COMMITTED this always finds the row: DO NOTHING
    // above already blocked until the concurrent inserter committed, and this
    // statement takes its own fresh snapshot afterwards.
    //
    // The null branch below is therefore unreachable in practice here. It is
    // kept rather than replaced with a throw because it stops being unreachable
    // the moment anything raises the isolation level or the row is deleted
    // between the two statements, and inventing an id would be worse than 202.
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM conversations
        WHERE org_id = $1::bigint AND provider_event_id = $2`,
      [orgId, event.eventId],
    );

    return existing.rows[0]
      ? { id: existing.rows[0].id, created: false }
      : null;
  }

  /**
   * The `redis` arm's write: no guard of its own, because the guard is in the
   * other system. One statement, same CTE shape as `upsert` so the two are
   * comparable, minus the ON CONFLICT clause that would make Postgres a second
   * line of defence.
   *
   * The unique index is still in the schema and still enforced — it is not an
   * arm, it is DDL — so a duplicate that gets past the guard (Redis restarted,
   * the key evicted) raises 23505 here and surfaces as a 500 rather than as a
   * duplicate row. Worth being exact about: this arm demonstrates the guard
   * failing, and something else catches the fall. `pnpm db:storm race` is where
   * the same failure with nothing underneath writes real duplicate rows.
   */
  private async plainInsert(
    tx: TenantQuery,
    orgId: string,
    event: IngestEventDto,
  ): Promise<IngestRow> {
    const { rows } = await tx.query<{ id: string }>(
      `WITH ingested AS (
         INSERT INTO conversations (org_id, status, provider_event_id)
         VALUES ($1::bigint, $4, $2)
         RETURNING id
       ), first_message AS (
         INSERT INTO messages (conversation_id, org_id, message)
         SELECT id, $1::bigint, $3 FROM ingested
       )
       SELECT id FROM ingested`,
      [orgId, event.eventId, event.message, event.status],
    );

    return { id: rows[0].id, created: true };
  }

  /**
   * The `none` arm: look, then leap. Deliberately the naive shape, including
   * two separate INSERTs rather than one CTE — this is what gets written before
   * anyone has thought about concurrency, and the point is to measure it, not
   * to write a tidier version of it.
   *
   * The race is between the SELECT and the INSERT. Sequentially it looks
   * correct and passes every test. Concurrently both callers see nothing and
   * both insert; the unique index then turns the second one into a 23505, which
   * propagates as a 500. Without that index it would be a duplicate row and a
   * 201 — `pnpm db:storm race` shows that version.
   *
   * Four statements including the guard's, so it also breaches the route's
   * @QueryBudget(3) and says so in the log.
   */
  private async checkThenInsert(
    tx: TenantQuery,
    orgId: string,
    event: IngestEventDto,
  ): Promise<IngestRow> {
    const existing = await tx.query<{ id: string }>(
      `SELECT id FROM conversations
        WHERE org_id = $1::bigint AND provider_event_id = $2`,
      [orgId, event.eventId],
    );

    if (existing.rows[0]) return { id: existing.rows[0].id, created: false };

    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO conversations (org_id, status, provider_event_id)
       VALUES ($1::bigint, $3, $2)
       RETURNING id`,
      [orgId, event.eventId, event.status],
    );

    const id = inserted.rows[0].id;

    await tx.query(
      `INSERT INTO messages (conversation_id, org_id, message)
       VALUES ($1::uuid, $2::bigint, $3)`,
      [id, orgId, event.message],
    );

    return { id, created: true };
  }
}
