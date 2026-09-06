/**
 * The billing meter: `usage_events` (the ledger) and `usage_counters` (the
 * counter that loses updates).
 *
 * Two tables for one feature, and the split is the whole point of card 13.
 *
 *   usage_events    append-only. An INSERT has no read-modify-write, so it
 *                   cannot lose an update. That makes count(*) over it the
 *                   ORACLE that proves the counter wrong: `used = 87` against a
 *                   ledger of 100 is thirteen lost updates, measured rather
 *                   than argued.
 *
 *   usage_counters  the denormalisation. It exists so that "how much has this
 *                   org used this month" is one index probe instead of an
 *                   aggregate over the ledger — and it is a cache of that
 *                   aggregate, which is why every problem in this drill exists.
 *
 * Both carry org_id, so migration 003's rule applies and `pnpm check:tenancy`
 * enforces it: RLS, a policy, USING and WITH CHECK. Because migration 003
 * deliberately declined ALTER DEFAULT PRIVILEGES, the grants are written by hand
 * here — that is the moment this file exists to force.
 *
 * Both must also be added to db/seed.mts's TRUNCATE list. A table referencing
 * organizations that is missing from it fails the whole seed with 0A000.
 *
 * See plans/2026-09-07_drill-13-lost-update.md.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

const APP_USER = process.env.POSTGRES_APP_USER;

const TABLES = ['usage_events', 'usage_counters'];

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  if (!APP_USER) {
    throw new Error('POSTGRES_APP_USER must be set to run this migration');
  }

  // period is a date — the first day of the billing month — and not text
  // 'YYYY-MM'. It sorts, it compares against a range, and `date_trunc('month',
  // …)::date` is the single expression that produces it. The timezone that
  // date_trunc runs in is a real decision and it is UTC here; a live billing
  // system uses the org's billing timezone, which this schema does not carry.
  //
  // metric is a column rather than two columns on one row, and that is
  // deliberate: the invariant `db:quota skew` tests is ACROSS ROWS. Two columns
  // in one row would make every cross-metric check trivially atomic — one row,
  // one UPDATE — and delete the experiment. The shipped endpoint only ever
  // writes 'events'.
  //
  // No unique constraint on (org_id, conversation_id, metric). The ledger row
  // and the conversation are inserted in one CTE inside one transaction, so
  // atomicity is the transaction's job; a unique index here would be a second
  // mechanism doing the first one's work, which drill 12 already priced.
  //
  // ON DELETE SET NULL, and nullable, is a statement about what a ledger IS.
  // The row records that this org was billed; the link to the conversation is a
  // convenience. Deleting a conversation must not unbill it, so CASCADE is
  // wrong — and a plain NOT NULL reference is wrong too, because it makes
  // DELETE /conversations/:id fail with a foreign key violation the moment the
  // conversation arrived through ingest.
  pgm.sql(`
    CREATE TABLE usage_events (
      id              bigserial   PRIMARY KEY,
      org_id          bigint      NOT NULL REFERENCES organizations (id),
      conversation_id uuid        REFERENCES conversations (id) ON DELETE SET NULL,
      period          date        NOT NULL,
      metric          text        NOT NULL
                      CONSTRAINT usage_events_metric_check
                      CHECK (metric IN ('events', 'messages')),
      quantity        integer     NOT NULL DEFAULT 1,
      occurred_at     timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX usage_events_org_period_metric_idx
      ON usage_events (org_id, period, metric);
  `);

  // The primary key IS the upsert's conflict target, which is what lets the
  // atomic arm be one statement that both creates the row and increments it.
  //
  // quota_limit is carried and NOT enforced by the endpoint. Card 13 is about
  // counting correctly, not about rejecting; the limit does real work only in
  // `db:quota skew`, where the invariant is `sum(used) <= quota_limit` across
  // the metric rows of one (org, period).
  //
  // CHECK (used >= 0) is cheap insurance on a counter written by four different
  // mechanisms — a negative meter is a bug that should not reach a bill.
  pgm.sql(`
    CREATE TABLE usage_counters (
      org_id      bigint      NOT NULL REFERENCES organizations (id),
      period      date        NOT NULL,
      metric      text        NOT NULL
                  CONSTRAINT usage_counters_metric_check
                  CHECK (metric IN ('events', 'messages')),
      used        bigint      NOT NULL DEFAULT 0
                  CONSTRAINT usage_counters_used_check CHECK (used >= 0),
      quota_limit bigint      NOT NULL DEFAULT 1000000000,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (org_id, period, metric)
    );
  `);

  pgm.sql(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON usage_events, usage_counters TO ${APP_USER};
    GRANT USAGE, SELECT ON SEQUENCE usage_events_id_seq TO ${APP_USER};
  `);

  // Same policy shape as migrations 003, 004 and 009: TO PUBLIC, USING and WITH
  // CHECK both present, no FORCE.
  for (const table of TABLES) {
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
 * Reverse dependency order: policies, grants, tables. A true inverse — and a
 * lossy one, because dropping the ledger destroys the only record of what was
 * billed. That is stated rather than mitigated: this is a drill repo, and a
 * real meter's rollback plan is a dump, not a DROP.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  for (const table of TABLES) {
    pgm.sql(`
      DROP POLICY ${table}_tenant_isolation ON ${table};
      ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;
    `);
  }

  if (APP_USER) {
    pgm.sql(`
      REVOKE ALL ON usage_events, usage_counters FROM ${APP_USER};
      REVOKE ALL ON SEQUENCE usage_events_id_seq FROM ${APP_USER};
    `);
  }

  pgm.sql(`
    DROP TABLE usage_counters;
    DROP TABLE usage_events;
  `);
};
