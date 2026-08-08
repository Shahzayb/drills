/**
 * Drop conversations.subject.
 *
 * A conversation in this product is a stream of messages; the "subject" was
 * email thinking carried over, and nothing reads it.
 *
 * The interesting half is `down`. This migration is where the schema stops
 * having a true inverse — see the comment there.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * ACCESS EXCLUSIVE on conversations, but only for as long as it takes to edit
 * the catalog: since Postgres 11 a DROP COLUMN is metadata-only. The column is
 * marked dropped in pg_attribute and the bytes stay in every tuple until those
 * rows are rewritten. So the table does not get smaller here, and the lock is
 * held for microseconds — unless something else is holding a conflicting lock,
 * in which case this statement waits behind it and everything queues behind
 * this statement.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.sql(`ALTER TABLE conversations DROP COLUMN subject;`);
};

/**
 * This is not an inverse and cannot be made into one.
 *
 * The column was `subject text NOT NULL`. Re-adding it that way on a populated
 * table is rejected outright — the existing rows have no value — so the down
 * has to invent a DEFAULT '' that the original never had, then drop the default
 * again to match the original definition. What comes back is the shape. Every
 * subject that was ever written is gone, and no amount of care in this file
 * changes that.
 *
 * Rolling this back on a large table is also the expensive direction: ADD COLUMN
 * ... NOT NULL DEFAULT '' is metadata-only in Postgres 11+ for a *constant*
 * default, so it stays fast — but the row-rewrite trap is one non-constant
 * default away, and that would hold ACCESS EXCLUSIVE for the whole rewrite.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE conversations ADD COLUMN subject text NOT NULL DEFAULT '';
    ALTER TABLE conversations ALTER COLUMN subject DROP DEFAULT;
  `);
};
