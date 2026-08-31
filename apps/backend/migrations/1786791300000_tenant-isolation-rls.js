export const shorthands = undefined;

const SCOPED_TABLES = ['conversations', 'messages', 'memberships'];

const APP_USER = process.env.POSTGRES_APP_USER;
const APP_PASSWORD = process.env.POSTGRES_APP_PASSWORD;

const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  if (!APP_USER || !APP_PASSWORD) {
    throw new Error(
      'POSTGRES_APP_USER and POSTGRES_APP_PASSWORD must be set to run this migration',
    );
  }

  pgm.sql(`
    CREATE FUNCTION app_current_org() RETURNS bigint
      LANGUAGE sql
      STABLE
      PARALLEL SAFE
      AS $$ SELECT nullif(current_setting('app.org_id', true), '')::bigint $$;

    COMMENT ON FUNCTION app_current_org() IS
      'Tenant for the current transaction, from the app.org_id setting. NULL when unset, which denies every row.';
  `);

  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${literal(APP_USER)}) THEN
        EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', ${literal(APP_USER)}, ${literal(APP_PASSWORD)});
      ELSE
        EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', ${literal(APP_USER)}, ${literal(APP_PASSWORD)});
      END IF;
    END
    $$;
  `);

  pgm.sql(`
    GRANT USAGE ON SCHEMA public TO ${APP_USER};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_USER};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_USER};
    REVOKE ALL ON TABLE pgmigrations FROM ${APP_USER};
  `);

  for (const table of SCOPED_TABLES) {
    pgm.sql(`
      ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;

      CREATE POLICY ${table}_tenant_isolation ON ${table}
        FOR ALL
        TO PUBLIC
        USING (org_id = app_current_org())
        WITH CHECK (org_id = app_current_org());
    `);
  }
};

export const down = (pgm) => {
  for (const table of SCOPED_TABLES) {
    pgm.sql(`
      DROP POLICY ${table}_tenant_isolation ON ${table};
      ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;
    `);
  }

  if (APP_USER) {
    pgm.sql(`
      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${APP_USER};
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${APP_USER};
      REVOKE ALL ON SCHEMA public FROM ${APP_USER};
      DROP ROLE IF EXISTS ${APP_USER};
    `);
  }

  pgm.sql(`DROP FUNCTION app_current_org();`);
};
