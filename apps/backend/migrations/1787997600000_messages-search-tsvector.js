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

export const down = (pgm) => {
  pgm.sql(`ALTER TABLE messages DROP COLUMN IF EXISTS tsv;`);
};
