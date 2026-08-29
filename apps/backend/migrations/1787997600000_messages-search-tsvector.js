/**
 * The search column: a stored tsvector over messages.message.
 *
 * GENERATED ALWAYS rather than a trigger because to_tsvector(regconfig, text)
 * is IMMUTABLE, so Postgres enforces the invariant itself and no trigger can
 * drift. The two-argument form is the only legal one here — the one-argument
 * to_tsvector(text) reads default_text_search_config and is merely STABLE.
 *
 *   SELECT proname, pg_get_function_arguments(oid), provolatile FROM pg_proc
 *   WHERE proname = 'to_tsvector';
 *
 * The cost, which is the point of the card: ADD COLUMN ... STORED takes ACCESS
 * EXCLUSIVE and rewrites the whole table. At 10M rows that is minutes with the
 * table unavailable. Reasoning, the measured duration and the online
 * alternative are in plans/2026-08-29_drill-11-full-text-search.md.
 *
 * btree_gin is what lets org_id sit in a GIN key alongside the tsvector; the
 * index itself is the next migration, because it builds CONCURRENTLY.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS btree_gin;`);
  pgm.sql(`
    ALTER TABLE messages
      ADD COLUMN tsv tsvector
      GENERATED ALWAYS AS (to_tsvector('english', message)) STORED;
  `);
};

/**
 * The extension stays. Dropping it would break any other index that came to
 * depend on it, and an unused extension costs nothing.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`ALTER TABLE messages DROP COLUMN IF EXISTS tsv;`);
};
