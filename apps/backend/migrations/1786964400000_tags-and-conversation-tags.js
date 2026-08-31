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
    CREATE TABLE tags (
      id         bigserial   PRIMARY KEY,
      org_id     bigint      NOT NULL REFERENCES organizations (id),
      name       text        NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT tags_org_id_name_key UNIQUE (org_id, name)
    );
  `);

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
