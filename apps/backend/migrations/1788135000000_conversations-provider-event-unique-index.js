/**
 * The idempotency key. This index IS the mechanism — everything the ingest
 * endpoint does on the `constraint` arm is a consequence of it existing.
 *
 *   (org_id, provider_event_id)  —  tenant first, same as drill 11's GIN
 *
 * Not UNIQUE (provider_event_id) alone. Two tenants may legitimately be sent the
 * same provider event id, and those are two different events; a global unique
 * would make one tenant's traffic silently suppress another's.
 *
 * PARTIAL, and that is about size rather than correctness. A plain unique index
 * would already be correct — NULL is distinct from NULL in a btree unique index,
 * so the 2.5M seeded rows would not collide with each other. The WHERE clause is
 * there so the index holds only ingested rows instead of 2.5M NULL entries.
 *
 * WATCH OUT: the price of the predicate is that every `ON CONFLICT` statement
 * has to repeat it in the inference clause —
 *
 *   ON CONFLICT (org_id, provider_event_id) WHERE provider_event_id IS NOT NULL
 *
 * — or Postgres cannot match the statement to this index and raises 42P10,
 * "there is no unique or exclusion constraint matching the ON CONFLICT
 * specification". See src/ingest/ingest.service.ts.
 *
 * CONCURRENTLY for the reason migration 005 spells out: a plain CREATE INDEX
 * blocks every write to conversations for the length of the build. The price is
 * that this migration is not atomic — a failure leaves an index with
 * indisvalid = false, invisible to the planner, still maintained on writes, and
 * NOT enforcing the uniqueness the endpoint depends on.
 *
 *   SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE NOT indisvalid;
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

const INDEX_NAME = 'conversations_org_provider_event_idx';

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`
    CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
      ON conversations (org_id, provider_event_id)
      WHERE provider_event_id IS NOT NULL;
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME};`);
};
