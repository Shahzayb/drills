/**
 * `conversations.version` — the token an optimistic write is checked against.
 *
 * One column, no index, no constraint beyond NOT NULL. The index is missing on
 * purpose: `version` is only ever read and written by primary key, in the same
 * statement, so an index on it would be pure write amplification on the hottest
 * table in the schema.
 *
 * The DEFAULT is what makes this cheap. Since Postgres 11 an `ADD COLUMN … NOT
 * NULL DEFAULT <constant>` stores the value in `pg_attribute.attmissingval` and
 * rewrites nothing — existing rows read the default until something updates
 * them. A volatile default (`DEFAULT random()`) or no default at all with NOT
 * NULL would rewrite all 2.5M rows under an ACCESS EXCLUSIVE lock instead. The
 * timing is in plans/2026-09-08_drill-14-optimistic-locking.md rather than
 * asserted here.
 *
 * Starts at 1 rather than 0 so that "the client sent no version" and "the client
 * sent version 0" are not both falsy in JavaScript. A version token that a
 * `if (!version)` check silently discards is the bug this column exists to
 * prevent, one layer up.
 *
 * integer, not bigint: 2^31 assignments to one conversation is not a number this
 * schema will reach, and the column is on every row of the largest table.
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
    ALTER TABLE conversations
      ADD COLUMN version integer NOT NULL DEFAULT 1;
  `);
};

/**
 * A true inverse, and a lossy one: dropping the column throws away every
 * version any client is currently holding, so an assign in flight across the
 * rollback lands as a 400 rather than as a wrong write.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`ALTER TABLE conversations DROP COLUMN version;`);
};
