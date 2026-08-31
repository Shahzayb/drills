export const shorthands = undefined;

export const up = (pgm) => {
  pgm.sql(`ALTER TABLE conversations DROP COLUMN subject;`);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE conversations ADD COLUMN subject text NOT NULL DEFAULT '';
    ALTER TABLE conversations ALTER COLUMN subject DROP DEFAULT;
  `);
};
