import { Injectable } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { getRequestContext } from '../observability/request-context';
import {
  QUOTA_MAX_RETRIES,
  ScopeOptions,
  TenantDb,
  TenantQuery,
} from '../tenancy/tenant-db.service';
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

/**
 * How the monthly quota counter is incremented. Card 13.
 *
 * - `rmw`          SELECT the count, add one in JavaScript, write it back. The
 *                  bug: two callers read 99 and both write 100. It passes every
 *                  sequential test and loses money under concurrency.
 * - `atomic`       one statement, `used = usage_counters.used + 1`. Postgres
 *                  takes the row lock and does the arithmetic on the value it
 *                  can see, which is the one nobody else has moved.
 * - `locking`      `rmw` plus `FOR UPDATE`. Same arithmetic in the application,
 *                  correct anyway, because the row is held from the read to the
 *                  write.
 * - `serializable` `rmw` byte for byte, inside a SERIALIZABLE transaction with
 *                  retry on 40001.
 *
 * `atomic` is the default because it is what you would ship. The three others
 * are permanent measurement arms, the way `naive` and `like` are.
 *
 * See plans/2026-09-07_drill-13-lost-update.md.
 */
export type QuotaMode = 'rmw' | 'atomic' | 'locking' | 'serializable';

const QUOTA_MODES: QuotaMode[] = ['rmw', 'atomic', 'locking', 'serializable'];

export const QUOTA: QuotaMode = QUOTA_MODES.includes(
  process.env.QUOTA as QuotaMode,
)
  ? (process.env.QUOTA as QuotaMode)
  : 'atomic';

/**
 * Whether the ingest path fills `conversations.last_message_at`. Card 16.
 *
 * - `write`  `now()`, which inside this transaction is the same instant the
 *            first message's `created_at` default resolves to.
 * - `skip`   NULL, which the NOT NULL constraint added by migration 016 rejects.
 *
 * `skip` is the expand/contract ordering failure as a switch: the constraint
 * went on before the code that fills the column, so every delivery is a 500.
 * That is what a required column costs when the three deploys are done in the
 * wrong order, and `pnpm db:test:skiplast` is the red run that proves the arm
 * still switches.
 *
 * See plans/2026-09-10_drill-16-zero-downtime-migration.md.
 */
export type LastMessageMode = 'write' | 'skip';

export const LAST_MESSAGE: LastMessageMode =
  process.env.LAST_MESSAGE === 'skip' ? 'skip' : 'write';

/** Inlined rather than bound: it is SQL, not a value, and the two arms differ
 *  in which expression runs rather than in what is sent. */
const LAST_MESSAGE_AT = LAST_MESSAGE === 'skip' ? 'NULL' : 'now()';

/**
 * The billing period, as SQL rather than as a JavaScript date.
 *
 * `now()` is transaction start time, so every statement in one transaction gets
 * the same period even across a midnight-on-the-first boundary. Computing it in
 * Node would put the *application server's* clock in the billing key, and two
 * app servers disagreeing about the month is a class of bug that has no
 * symptom until the invoice.
 *
 * UTC, and that is a placeholder rather than a defended choice: a real meter
 * truncates in the org's billing timezone, which this schema does not carry.
 */
export const PERIOD_SQL = `date_trunc('month', now() AT TIME ZONE 'UTC')::date`;

/** The only metric the endpoint writes. `usage_counters.metric` has a second
 *  value, and it exists for `pnpm db:quota skew`. */
export const QUOTA_METRIC = 'events';

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
  /** Which quota arm answered, same reasoning as `mode`. */
  quota: QuotaMode;
  /** The counter after this delivery, or null when nothing was billed — a
   *  duplicate must not move the meter. */
  quotaUsed: number | null;
  /** Transaction restarts this request paid for. Non-zero only on
   *  `QUOTA=serializable`, and it is the retry rate one request at a time. */
  retries: number;
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
            quota: QUOTA,
            // Nothing was billed and nothing was read: the guard answered
            // without touching Postgres at all.
            quotaUsed: null,
            retries: 0,
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
            quota: QUOTA,
            quotaUsed: null,
            retries: 0,
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

  /**
   * How the transaction is opened. Only the `serializable` arm changes it.
   *
   * Retrying restarts the WHOLE callback below, conversation insert included.
   * That is safe here for one reason and it belongs to the previous card: the
   * write is idempotent. `ON CONFLICT` means a re-run finds its own row instead
   * of adding a second. Retry-on-40001 is a feature you buy with idempotency,
   * which is why this arm would have been unshippable one drill ago.
   */
  private readonly scope: ScopeOptions =
    QUOTA === 'serializable'
      ? { isolation: 'SERIALIZABLE', retries: QUOTA_MAX_RETRIES }
      : {};

  /** One transaction either way: the conversation and its first message are one
   *  atomic unit, or a retry finds a conversation with no message in it. */
  private write(orgId: string, event: IngestEventDto): Promise<IngestResult> {
    return this.tenants.withOrg(
      orgId,
      async (tx) => {
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
            quota: QUOTA,
            quotaUsed: null,
            retries: 0,
          };
        }

        // Only a delivery that CREATED something is billable. A duplicate that
        // moved the meter would be the same overcount this drill is about, in the
        // other direction — and drill 12's `created` discriminator is already the
        // flag that says which is which.
        const quotaUsed = row.created ? await this.bill(tx, orgId) : null;

        return {
          conversationId: row.id,
          duplicate: !row.created,
          outcome: row.created ? ('created' as const) : ('duplicate' as const),
          mode: IDEMPOTENCY,
          quota: QUOTA,
          quotaUsed,
          // Read at the end of the transaction, not accumulated by hand: the
          // count lives on the request context, so a retry inside withOrg
          // increments it whether or not this file remembers to.
          retries: getRequestContext()?.retries ?? 0,
        };
      },
      this.scope,
    );
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
         INSERT INTO conversations (org_id, status, provider_event_id, last_message_at)
         VALUES ($1::bigint, $4, $2, ${LAST_MESSAGE_AT})
         ON CONFLICT (org_id, provider_event_id) WHERE provider_event_id IS NOT NULL
           ${action}
         RETURNING id, xmax = 0 AS created
       ), first_message AS (
         INSERT INTO messages (conversation_id, org_id, message)
         SELECT id, $1::bigint, $3 FROM ingested WHERE created
       ), billed AS (
         INSERT INTO usage_events (org_id, conversation_id, period, metric)
         SELECT $1::bigint, id, ${PERIOD_SQL}, '${QUOTA_METRIC}'
           FROM ingested WHERE created
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
         INSERT INTO conversations (org_id, status, provider_event_id, last_message_at)
         VALUES ($1::bigint, $4, $2, ${LAST_MESSAGE_AT})
         RETURNING id
       ), first_message AS (
         INSERT INTO messages (conversation_id, org_id, message)
         SELECT id, $1::bigint, $3 FROM ingested
       ), billed AS (
         INSERT INTO usage_events (org_id, conversation_id, period, metric)
         SELECT $1::bigint, id, ${PERIOD_SQL}, '${QUOTA_METRIC}' FROM ingested
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
      `INSERT INTO conversations (org_id, status, provider_event_id, last_message_at)
       VALUES ($1::bigint, $3, $2, ${LAST_MESSAGE_AT})
       RETURNING id`,
      [orgId, event.eventId, event.status],
    );

    const id = inserted.rows[0].id;

    await tx.query(
      `INSERT INTO messages (conversation_id, org_id, message)
       VALUES ($1::uuid, $2::bigint, $3)`,
      [id, orgId, event.message],
    );

    // A fourth statement rather than a CTE, for the same reason the two INSERTs
    // above are separate: this arm is what gets written before anyone has
    // thought about any of this, and tidying it would stop it being the control.
    await tx.query(
      `INSERT INTO usage_events (org_id, conversation_id, period, metric)
       VALUES ($1::bigint, $2::uuid, ${PERIOD_SQL}, '${QUOTA_METRIC}')`,
      [orgId, id],
    );

    return { id, created: true };
  }

  /**
   * Move the meter by one, whichever way this arm moves it.
   *
   * The counter is a CACHE of `count(*)` over usage_events, and every problem
   * below is a consequence of keeping one. The ledger cannot lose a row — an
   * INSERT has nothing to read — so `count(usage_events)` is the oracle that
   * tells you the counter is short.
   */
  private async bill(tx: TenantQuery, orgId: string): Promise<number> {
    if (QUOTA === 'atomic') return this.incrementAtomic(tx, orgId);

    // `rmw`, `locking` and `serializable` share these two statements exactly.
    // The lock below is the whole of `locking`; the isolation level, set on the
    // transaction rather than here, is the whole of `serializable`. Three arms,
    // one code path, so nothing else can differ between them.
    const lock = QUOTA === 'locking' ? ' FOR UPDATE' : '';

    const { rows } = await tx.query<{ used: string }>(
      `SELECT used FROM usage_counters
        WHERE org_id = $1::bigint AND period = ${PERIOD_SQL}
          AND metric = $2${lock}`,
      [orgId, QUOTA_METRIC],
    );

    // No row yet — the first billable event of the period. There is nothing to
    // read, so there is no read-modify-write to demonstrate: every arm creates
    // the row atomically. Once per org per month, and it keeps the naive arm
    // from failing for the wrong reason (a PK violation instead of an
    // undercount).
    if (!rows[0]) return this.incrementAtomic(tx, orgId);

    // THE BUG, on the `rmw` arm. The value came from a snapshot; by the time
    // the UPDATE below lands, another transaction may have written a larger one,
    // and this statement overwrites it with a smaller number. No error, no
    // conflict, no log line. `bigint` arrives as a string from pg, so the
    // Number() is also what would silently cap this meter at 2^53.
    const next = Number(rows[0].used) + 1;

    await tx.query(
      `UPDATE usage_counters SET used = $3::bigint, updated_at = now()
        WHERE org_id = $1::bigint AND period = ${PERIOD_SQL} AND metric = $2`,
      [orgId, QUOTA_METRIC, next],
    );

    return next;
  }

  /**
   * One statement, and the fix nobody argues with.
   *
   * `used = usage_counters.used + 1` reads the value Postgres holds the row
   * lock over, not the one this session saw a round trip ago. Under READ
   * COMMITTED a concurrent updater blocks here, then re-evaluates against the
   * committed row — so the increment composes instead of overwriting.
   *
   * The upsert shape is not decoration: it is also how the row gets created,
   * which is why every other arm falls back to it on the cold path.
   */
  private async incrementAtomic(
    tx: TenantQuery,
    orgId: string,
  ): Promise<number> {
    const { rows } = await tx.query<{ used: string }>(
      `INSERT INTO usage_counters (org_id, period, metric, used)
       VALUES ($1::bigint, ${PERIOD_SQL}, $2, 1)
       ON CONFLICT (org_id, period, metric)
         DO UPDATE SET used = usage_counters.used + 1, updated_at = now()
       RETURNING used`,
      [orgId, QUOTA_METRIC],
    );

    return Number(rows[0].used);
  }
}
