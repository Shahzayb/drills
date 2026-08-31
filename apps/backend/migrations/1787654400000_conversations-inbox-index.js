export const shorthands = undefined;

const INDEX_NAME = 'conversations_org_updated_idx';

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
      ON conversations (org_id, updated_at DESC, id DESC);
  `);
};

export const down = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME};`);
};
