/**
 * `api_keys`, and the one deliberate hole in drill 07's mechanism.
 *
 * The table carries org_id, so migration 003's rule applies and
 * `pnpm check:tenancy` enforces it: RLS enabled, a policy, USING and WITH CHECK.
 * That check finds tables by looking for an org_id column, so there is no list
 * to add to and no way to opt out.
 *
 * Which creates a problem the other five tables do not have. The lookup that
 * authenticates a key runs BEFORE any org is known — it is what decides the org.
 * As app_user with app.org_id unset, app_current_org() is NULL, the policy
 * admits no rows, and the lookup finds nothing. Authentication cannot run inside
 * the tenant scope it exists to establish.
 *
 * app_org_for_api_key() below is the hole, and it is exactly one bigint wide.
 *
 * Because migration 003 declined ALTER DEFAULT PRIVILEGES, the grant and the
 * policy are written by hand here — that is the moment this file exists to
 * force. See plans/2026-08-31_drill-12-idempotent-ingest.md.
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

  // key_hash holds sha256 hex and is UNIQUE, so the lookup below is one index
  // probe. The plaintext key is never stored: it is shown once, at mint time,
  // and a lost one is replaced rather than recovered.
  //
  // revoked_at rather than a DELETE — the org that owned a leaked key wants to
  // see that it existed, and an FK from anything audit-shaped needs the row.
  //
  // No index on org_id: nothing lists an org's keys yet. Deliberately
  // under-indexed, same habit as conversations in migration 001.
  pgm.sql(`
    CREATE TABLE api_keys (
      id         bigserial   PRIMARY KEY,
      org_id     bigint      NOT NULL REFERENCES organizations (id),
      name       text        NOT NULL,
      key_hash   text        NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz,
      CONSTRAINT api_keys_key_hash_key UNIQUE (key_hash)
    );
  `);

  // SECURITY DEFINER, so it runs as the owner — and migration 003 deliberately
  // set no FORCE ROW LEVEL SECURITY, which is what exempts the owner from the
  // policy below. That exemption is the whole mechanism here, so this function
  // stops working the day FORCE is added, loudly and on the first request.
  //
  // STABLE so the planner may fold it; not PARALLEL SAFE, because it is called
  // once per request outside any query that could go parallel, and claiming a
  // property nothing needs is how the drill 07 mistake happened in reverse.
  //
  // SET search_path is not decoration. A SECURITY DEFINER function with an
  // unpinned search_path lets anyone who can create a schema put their own
  // `api_keys` in front of this one and have the OWNER read it. pg_catalog
  // first, and public named explicitly rather than inherited.
  //
  // It returns a bigint and nothing else. The serving role never gains SELECT
  // on the table, so a bug in the guard cannot enumerate keys.
  pgm.sql(`
    CREATE FUNCTION app_org_for_api_key(hash text) RETURNS bigint
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
        SELECT org_id FROM api_keys
         WHERE key_hash = hash AND revoked_at IS NULL
      $$;

    COMMENT ON FUNCTION app_org_for_api_key(text) IS
      'Tenant for an api key hash, or NULL. SECURITY DEFINER on purpose: authentication cannot run inside the tenant scope it establishes.';
  `);

  // Deliberately NOT `SELECT, INSERT, UPDATE, DELETE`, which is what every other
  // table in this schema grants. This is the credential table: with no SELECT,
  // even a full SQL injection running as app_user cannot read key_hash out and
  // take it away to crack offline. The only read path is the function above,
  // which returns a bigint.
  //
  // The price is real and shows up immediately. Postgres requires SELECT on any
  // column a WHERE or RETURNING clause reads, so with no SELECT grant:
  //
  //   DELETE FROM api_keys WHERE org_id = $1   -- permission denied
  //   DELETE FROM api_keys                     -- fine, and scoped by the policy
  //   INSERT ... RETURNING id                  -- permission denied
  //
  // The second line is not a loophole. Inside `TenantDb.withOrg` the policy's
  // USING clause is applied by the system and needs no privilege, so a filterless
  // DELETE removes exactly one org's keys — the same "filterless on purpose"
  // shape as drill 07's /conversations/:id endpoints. test/ingest.e2e-spec.ts
  // cleans up that way.
  pgm.sql(`
    GRANT INSERT, UPDATE, DELETE ON api_keys TO ${APP_USER};
    GRANT USAGE, SELECT ON SEQUENCE api_keys_id_seq TO ${APP_USER};
    GRANT EXECUTE ON FUNCTION app_org_for_api_key(text) TO ${APP_USER};
  `);

  // Same policy shape as migrations 003 and 004: TO PUBLIC, USING and WITH
  // CHECK both present, no FORCE.
  pgm.sql(`
    ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

    CREATE POLICY api_keys_tenant_isolation ON api_keys
      FOR ALL
      TO PUBLIC
      USING (org_id = app_current_org())
      WITH CHECK (org_id = app_current_org());
  `);
};

/**
 * Reverse dependency order: policy, grants, function, table. A true inverse.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP POLICY api_keys_tenant_isolation ON api_keys;
    ALTER TABLE api_keys DISABLE ROW LEVEL SECURITY;
  `);

  if (APP_USER) {
    pgm.sql(`
      REVOKE ALL ON api_keys FROM ${APP_USER};
      REVOKE ALL ON SEQUENCE api_keys_id_seq FROM ${APP_USER};
      REVOKE ALL ON FUNCTION app_org_for_api_key(text) FROM ${APP_USER};
    `);
  }

  pgm.sql(`
    DROP FUNCTION app_org_for_api_key(text);
    DROP TABLE api_keys;
  `);
};
