/**
 * `conversations.provider_event_id` — the provider's id for the event that
 * created this conversation, and the column the unique index in the next
 * migration is built on.
 *
 * Split from that index for the same reason migrations 006 and 007 are split:
 * the index is CONCURRENTLY and therefore cannot run in a transaction, and
 * welding a column onto a non-transactional migration gives up atomicity for a
 * statement that does not need it.
 *
 * Nullable with no default, which is what keeps this cheap. Since Postgres 11 a
 * new column with no default (or a non-volatile one) is a catalog change: no
 * table rewrite, no ACCESS EXCLUSIVE for the length of a 2.5M-row scan. Compare
 * migration 006, where `ADD COLUMN ... GENERATED ALWAYS AS (...) STORED` took
 * 135 seconds on `messages` and read exactly like this statement.
 *
 * NULL is the right value for the 2.5M seeded rows: they did not come from a
 * webhook, and "no provider event" is not the empty string.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE conversations ADD COLUMN provider_event_id text;

    COMMENT ON COLUMN conversations.provider_event_id IS
      'Idempotency key from the delivering provider. NULL for anything not ingested over POST /ingest.';
  `);
};

/**
 * Lossy, and knowingly so: the ingested rows keep their conversations and lose
 * the only record of which delivery produced them.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`ALTER TABLE conversations DROP COLUMN provider_event_id;`);
};
