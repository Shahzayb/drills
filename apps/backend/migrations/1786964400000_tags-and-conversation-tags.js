/**
 * Tags: `tags` and the `conversation_tags` join table.
 *
 * Hand-written SQL inside pgm.sql(), same as migrations 001 and 003 — later
 * drills read a migration and reason about which lock a statement takes, and
 * that only works if the statement is the thing in the file.
 *
 * Drill 02's load-bearing rule applies again here: every tenant-owned row
 * carries org_id directly. A join table is exactly where that rule is easiest
 * to forget, because the tenant is reachable through either side of the join —
 * and "reachable through a join" is precisely what migration 003's policies do
 * not do; they read one column on the row in front of them.
 *
 * Because migration 003 deliberately declined ALTER DEFAULT PRIVILEGES, adding
 * a table means adding its grant and its policy by hand — that is the moment
 * this migration exists to force, not an oversight to fix later.
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

  // UNIQUE (org_id, name) is the org index, same trick as memberships in
  // migration 001: a leftmost-prefix scan answers "this org's tags" and org_id
  // needs no index of its own.
  pgm.sql(`
    CREATE TABLE tags (
      id         bigserial   PRIMARY KEY,
      org_id     bigint      NOT NULL REFERENCES organizations (id),
      name       text        NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tags_org_id_name_key UNIQUE (org_id, name)
    );
  `);

  // org_id is denormalized here on purpose, same reasoning as messages in
  // migration 001: reaching the tenant through conversations would put a join
  // in front of the policy, and RLS predicates read one column on the row in
  // front of them, not a column two joins away.
  //
  // No index on tag_id: nothing reads "conversations with tag X" yet — card 11
  // (search) is where that changes. Deliberately under-indexed, same habit as
  // conversations in migration 001.
  //
  // No updated_at: a membership between a conversation and a tag is created and
  // deleted, never edited in place — a deliberate deviation from every other
  // table's convention, not an omission.
  pgm.sql(`
    CREATE TABLE conversation_tags (
      conversation_id uuid        NOT NULL REFERENCES conversations (id),
      tag_id          bigint      NOT NULL REFERENCES tags (id),
      org_id          bigint      NOT NULL REFERENCES organizations (id),
      created_at      timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (conversation_id, tag_id)
    );
  `);

  pgm.sql(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON tags, conversation_tags TO ${APP_USER};
    GRANT USAGE, SELECT ON SEQUENCE tags_id_seq TO ${APP_USER};
  `);

  // Same policy shape as migration 003: TO PUBLIC (not TO app_user, so a second
  // app role is not silently unprotected), USING + WITH CHECK both present (a
  // tenant must not be able to write a row out of its own scope), no FORCE (the
  // owner still bypasses, for migrations and the seed).
  for (const table of ['tags', 'conversation_tags']) {
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
 * Reverse dependency order: policies and grants first, then the join table,
 * then tags. A true inverse, same as migration 001 — nothing existed before it.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  for (const table of ['conversation_tags', 'tags']) {
    pgm.sql(`
      DROP POLICY ${table}_tenant_isolation ON ${table};
      ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;
    `);
  }

  if (APP_USER) {
    pgm.sql(`
      REVOKE ALL ON tags, conversation_tags FROM ${APP_USER};
      REVOKE ALL ON SEQUENCE tags_id_seq FROM ${APP_USER};
    `);
  }

  pgm.sql(`
    DROP TABLE conversation_tags;
    DROP TABLE tags;
  `);
};
