/**
 * The GIN index that serves the search endpoint.
 *
 *   (org_id, tsv)  —  btree_gin puts the tenant key in the same index
 *
 * Not GIN (tsv) alone. RLS injects org_id = app_current_org() into every query,
 * and a tsvector-only GIN returns matches across all 200 orgs, then discards
 * them on the heap. Tolerable for the whale org (40% of the table), ruinous for
 * a tail org at 0.1%. Both are measured in
 * plans/2026-08-29_drill-11-full-text-search.md.
 *
 * CONCURRENTLY for the reason migration 1787654400000 spells out: a plain
 * CREATE INDEX blocks every write to messages for the length of the build. The
 * price is that this migration is not atomic — a failure leaves an index with
 * indisvalid = false, invisible to the planner and still maintained on writes.
 *
 *   SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE NOT indisvalid;
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

const INDEX_NAME = 'messages_org_tsv_idx';

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
      ON messages USING gin (org_id, tsv);
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
