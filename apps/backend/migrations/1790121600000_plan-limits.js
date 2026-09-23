/**
 * `plan_limits`: what each plan is entitled to. Read on every org-scoped request and cached in Redis.
 * See plans/2026-09-23_drill-19-entitlement-cache.md.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

const APP_USER = process.env.POSTGRES_APP_USER;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  if (!APP_USER) {
    throw new Error('POSTGRES_APP_USER must be set to run this migration');
  }

  // NULL means unlimited. No org_id, so no RLS: this is a catalog, not tenant data.
  pgm.sql(`
    CREATE TABLE plan_limits (
      plan              text        PRIMARY KEY,
      ingest_per_minute integer     CHECK (ingest_per_minute > 0),
      updated_at        timestamptz NOT NULL DEFAULT now()
    );

    INSERT INTO plan_limits (plan, ingest_per_minute) VALUES
      ('free', 60), ('basic', 600), ('pro', NULL);
  `);

  // organizations_plan_check stays: it fires before the FK and the schema spec asserts its name.
  pgm.sql(`
    ALTER TABLE organizations
      ADD CONSTRAINT organizations_plan_fkey
      FOREIGN KEY (plan) REFERENCES plan_limits (plan);
  `);

  pgm.sql(`GRANT SELECT ON plan_limits TO ${APP_USER};`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE organizations DROP CONSTRAINT organizations_plan_fkey;
    DROP TABLE plan_limits;
  `);
};
