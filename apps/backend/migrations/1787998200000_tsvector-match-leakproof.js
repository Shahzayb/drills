export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.sql(`ALTER FUNCTION ts_match_vq(tsvector, tsquery) LEAKPROOF;`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`ALTER FUNCTION ts_match_vq(tsvector, tsquery) NOT LEAKPROOF;`);
};
