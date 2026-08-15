/**
 * Row-level security: tenant isolation that holds below the application.
 *
 * The rule this encodes: **every table carrying `org_id` has RLS enabled and a
 * policy with both `USING` and `WITH CHECK`.** Drill 02 made that rule possible
 * by giving every tenant-owned row an `org_id` directly, so a policy needs no
 * join to find the tenant. `apps/backend/db/check-tenancy.mjs` fails the build
 * when a new table breaks the rule.
 *
 * Hand-written SQL inside pgm.sql(), same as migration 001: later drills read a
 * migration and reason about which lock a statement takes, and that only works
 * if the statement is the thing in the file.
 *
 * See plans/2026-08-15_drill-07-tenant-isolation.md for what was rejected.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

// The tables that carry org_id. organizations and users are deliberately absent:
// organizations is the tenant registry rather than tenant-owned data, and users
// has no org_id at all because a person can belong to several orgs. Both are
// real leak surfaces that this mechanism does not cover, and saying so is worth
// more than a policy that pretends otherwise.
const SCOPED_TABLES = ['conversations', 'messages', 'memberships'];

const APP_USER = process.env.POSTGRES_APP_USER;
const APP_PASSWORD = process.env.POSTGRES_APP_PASSWORD;

/**
 * Postgres single-quoted literal. The password reaches the server as SQL text —
 * pgm.sql() takes no bind parameters — so it is escaped here rather than
 * trusted.
 *
 * WATCH OUT: **node-pg-migrate echoes every statement it runs to stdout**, with
 * no flag involved, so `pnpm db:migrate` prints this password. Checked, not
 * assumed — an earlier version of this comment claimed the opposite.
 *
 * That is survivable here because the credential is a local dev one in
 * `.env.example`. It is the wrong shape for anywhere else: creating a login role
 * is a one-time cluster operation, not a per-database migration, so in a real
 * deployment the role and its password come from whatever manages the cluster
 * and the migration only ever does the GRANTs and the policies below.
 */
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

  // STABLE, not VOLATILE: the planner may only fold a stable function into an
  // index qualifier, and a volatile one would be re-evaluated per row and cost
  // the whale a sequential scan. PARALLEL SAFE for the same reason — a parallel
  // plan is illegal if any expression in it is not.
  //
  // The nullif is load-bearing, and not for the reason it looks like.
  // current_setting(..., true) returns NULL for an unset GUC, which is what
  // makes this fail *closed*: NULL = anything is NULL, the policy admits no
  // rows, and a forgotten scope is an empty page rather than someone else's
  // inbox.
  //
  // But a connection that has *ever* run a scoped transaction does not go back
  // to unset. Once the session knows a custom GUC's name, end-of-transaction
  // reverts it to its reset value, which is the **empty string** — measured, see
  // case 9 of test/tenant-isolation.e2e-spec.ts. And ''::bigint raises 22P02.
  // So without the nullif, every unscoped query on a recycled pool connection
  // would be a 500 rather than an empty result: fail-closed would have degraded
  // into fail-loudly-in-the-wrong-way, on the second request and not the first.
  pgm.sql(`
    CREATE FUNCTION app_current_org() RETURNS bigint
      LANGUAGE sql
      STABLE
      PARALLEL SAFE
      AS $$ SELECT nullif(current_setting('app.org_id', true), '')::bigint $$;

    COMMENT ON FUNCTION app_current_org() IS
      'Tenant for the current transaction, from the app.org_id setting. NULL when unset, which denies every row.';
  `);

  // A role is a *cluster* object; the pgmigrations ledger is a *database* one.
  // `pnpm db:reset` is DROP SCHEMA public CASCADE, which takes the tables, the
  // function and the ledger — and leaves this role behind. An unguarded CREATE
  // ROLE therefore fails the whole migration on a command this repo runs
  // constantly. Hence the guard, and hence the grants below run every time:
  // after a reset the role survives holding grants on objects that do not.
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

  // Deliberately no ALTER DEFAULT PRIVILEGES. A new table should need an
  // explicit grant, because that is a moment where somebody has to think about
  // its policy — and check-tenancy.mjs is the backstop for when they do not.
  //
  // pgmigrations is excluded: the app has no business editing the ledger that
  // says which migrations have run.
  pgm.sql(`
    GRANT USAGE ON SCHEMA public TO ${APP_USER};
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_USER};
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_USER};
    REVOKE ALL ON TABLE pgmigrations FROM ${APP_USER};
  `);

  // TO PUBLIC, not TO app_user. A role-targeted policy silently protects
  // nothing the day a second application role is added — and PUBLIC still
  // exempts the table owner and every superuser, which is exactly the split
  // wanted here: the owner runs migrations and drill 04's COPY seed.
  //
  // No FORCE ROW LEVEL SECURITY, for that same reason. The cost of that
  // decision, stated plainly: anything connecting as the owner is unprotected.
  //
  // WITH CHECK is not optional and is not a duplicate of USING. USING filters
  // the rows you may *see* and therefore update or delete; WITH CHECK inspects
  // the row as it will be *after* the write. With USING alone a tenant can take
  // a row it legitimately owns and set org_id to somebody else's — handing data
  // out, or stealing it in, one UPDATE at a time.
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

/**
 * A true inverse. Policies first, then the role's grants, then the role, then
 * the function — reverse dependency order, because DROP ROLE refuses while the
 * role still holds a privilege anywhere.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
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
