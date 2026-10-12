/**
 * Drill 24: the usage rollup, a scheduled job that must run once per slot however many replicas run.
 *
 *   usage_rollups  one row per org, metric and slot. No unique key, on purpose: it stands in for an
 *                  effect a constraint cannot dedupe (an email, a billing export), so a duplicate run
 *                  shows up as a duplicate row instead of an error.
 *   job_runs       one row per (job, slot). The claim: inserted in the same transaction as the rollup,
 *                  so a row exists only if the slot's work committed.
 *
 * See plans/2026-10-12_drill-24-three-replicas.md.
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

  pgm.sql(`
    CREATE TABLE usage_rollups (
      id         bigserial   PRIMARY KEY,
      org_id     bigint      NOT NULL REFERENCES organizations (id),
      slot_start timestamptz NOT NULL,
      metric     text        NOT NULL,
      quantity   bigint      NOT NULL,
      holder     text        NOT NULL,
      term       bigint      NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE usage_rollups ENABLE ROW LEVEL SECURITY;

    CREATE POLICY usage_rollups_tenant_isolation ON usage_rollups
      FOR ALL
      TO PUBLIC
      USING (org_id = app_current_org())
      WITH CHECK (org_id = app_current_org());
  `);

  // No org_id: the job's own bookkeeping, not tenant data.
  pgm.sql(`
    CREATE TABLE job_runs (
      job         text        NOT NULL,
      slot_start  timestamptz NOT NULL,
      holder      text        NOT NULL,
      term        bigint      NOT NULL,
      rows        integer,
      started_at  timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      PRIMARY KEY (job, slot_start)
    );
  `);

  // Crosses tenants by design: a rollup reads every org's ledger. SECURITY DEFINER runs it as the
  // owner, which RLS exempts (no FORCE), the same mechanism as app_org_for_api_key().
  pgm.sql(`
    CREATE FUNCTION app_rollup_usage(
      p_start timestamptz, p_end timestamptz, p_holder text, p_term bigint
    ) RETURNS integer
      LANGUAGE sql
      VOLATILE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
        WITH inserted AS (
          INSERT INTO usage_rollups (org_id, slot_start, metric, quantity, holder, term)
          SELECT org_id, p_start, metric, sum(quantity), p_holder, p_term
            FROM usage_events
           WHERE occurred_at >= p_start AND occurred_at < p_end
           GROUP BY org_id, metric
          RETURNING 1
        )
        SELECT count(*)::integer FROM inserted
      $$;
  `);

  pgm.sql(`
    GRANT SELECT ON usage_rollups TO ${APP_USER};
    GRANT SELECT, INSERT, UPDATE ON job_runs TO ${APP_USER};
    GRANT EXECUTE ON FUNCTION app_rollup_usage(timestamptz, timestamptz, text, bigint) TO ${APP_USER};
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP FUNCTION app_rollup_usage(timestamptz, timestamptz, text, bigint);
    DROP TABLE job_runs;
    DROP TABLE usage_rollups;
  `);
};
