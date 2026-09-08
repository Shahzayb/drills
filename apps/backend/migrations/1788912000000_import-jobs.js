/**
 * `import_jobs` — one row per CSV upload, and the schema half of card 15's
 * "resume or restart" question.
 *
 * The load-bearing decision is that `resume_row` is a SEPARATE column from
 * `rows_read`:
 *
 *   rows_read    what the parser has handed to the writer. Ahead of the
 *                database by up to one batch, always.
 *   resume_row   what is COMMITTED. It is written inside the same transaction
 *                as the batch it describes, so it cannot name a row that is not
 *                durable. A crash between two batches leaves it exactly on a
 *                batch boundary.
 *
 * One column would collapse those two facts into a number that is right most of
 * the time, which is the class of bug this repo exists to produce on purpose and
 * then not ship.
 *
 * Resume is a COST optimisation here, not a correctness requirement. An imported
 * conversation carries drill 12's provider_event_id as `import:<external_id>`,
 * so re-importing a row it already has is an ON CONFLICT DO NOTHING. Restarting
 * from row zero is therefore also correct, just slower — and IMPORT_ON_FAIL is
 * the switch between them, with `pnpm db:test:restart` expected green.
 *
 * peak_rss_bytes is the measurement stored beside the thing it measured. The
 * card's DONE WHEN is "peak RSS stated and flat regardless of file size", and a
 * number that lives on the job row survives the scrollback that produced it.
 *
 * No CHECK on `status`. The values are pending | running | succeeded | failed
 * and the endpoint is the only writer; a constraint here would be a second
 * declaration of the same list, and the list is about to be read by a UI that
 * has to handle an unknown value anyway.
 *
 * Carries org_id, so migration 003's rule applies and `pnpm check:tenancy`
 * enforces it: RLS, a policy, USING and WITH CHECK, grants written by hand.
 * Must also be added to db/seed.mts's TRUNCATE list, or the seed fails 0A000.
 *
 * See plans/2026-09-09_drill-15-streaming-csv-import.md.
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

  // `mode` and `batch_rows` record which arm ran this job. Reading them off the
  // row beats reading them off the container's environment, which is drill 10's
  // lesson: the shell and the running process disagree, and the row is the one
  // that was there.
  pgm.sql(`
    CREATE TABLE import_jobs (
      id             uuid        PRIMARY KEY DEFAULT uuidv7(),
      org_id         bigint      NOT NULL REFERENCES organizations (id),
      filename       text        NOT NULL,
      byte_size      bigint      NOT NULL,
      status         text        NOT NULL DEFAULT 'pending',
      mode           text        NOT NULL,
      batch_rows     integer     NOT NULL,
      rows_read      bigint      NOT NULL DEFAULT 0,
      rows_written   bigint      NOT NULL DEFAULT 0,
      rows_skipped   bigint      NOT NULL DEFAULT 0,
      resume_row     bigint      NOT NULL DEFAULT 0,
      peak_rss_bytes bigint,
      error          text,
      started_at     timestamptz,
      finished_at    timestamptz,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now()
    );
  `);

  // The UI list is "this org's jobs, newest first", so the index key is the
  // query. (org_id, created_at DESC) and not (org_id, created_at): drill 09's
  // rule, an index the ORDER BY can be served from removes the Sort node.
  pgm.sql(`
    CREATE INDEX import_jobs_org_created_idx
      ON import_jobs (org_id, created_at DESC);
  `);

  pgm.sql(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON import_jobs TO ${APP_USER};`,
  );

  pgm.sql(`
    ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;

    CREATE POLICY import_jobs_tenant_isolation ON import_jobs
      FOR ALL
      TO PUBLIC
      USING (org_id = app_current_org())
      WITH CHECK (org_id = app_current_org());
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP POLICY import_jobs_tenant_isolation ON import_jobs;
    ALTER TABLE import_jobs DISABLE ROW LEVEL SECURITY;
  `);

  if (APP_USER) {
    pgm.sql(`REVOKE ALL ON import_jobs FROM ${APP_USER};`);
  }

  pgm.sql(`DROP TABLE import_jobs;`);
};
