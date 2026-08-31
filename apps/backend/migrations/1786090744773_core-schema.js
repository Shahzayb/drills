export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE organizations (
      id         bigserial    PRIMARY KEY,
      name       varchar(255) NOT NULL,
      plan       text         NOT NULL
                 CONSTRAINT organizations_plan_check
                 CHECK (plan IN ('free', 'basic', 'pro')),
      created_at timestamptz  NOT NULL DEFAULT now(),
      updated_at timestamptz  NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`
    CREATE TABLE users (
      id         bigserial   PRIMARY KEY,
      name       text        NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`
    CREATE TABLE memberships (
      id         bigserial   PRIMARY KEY,
      user_id    bigint      NOT NULL REFERENCES users (id),
      org_id     bigint      NOT NULL REFERENCES organizations (id),
      role       text        NOT NULL
                 CONSTRAINT memberships_role_check
                 CHECK (role IN ('admin', 'editor')),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT memberships_user_id_org_id_key UNIQUE (user_id, org_id)
    );

    CREATE INDEX memberships_org_id_idx ON memberships (org_id);
  `);

  pgm.sql(`
    CREATE TABLE conversations (
      id          uuid        PRIMARY KEY DEFAULT uuidv7(),
      org_id      bigint      NOT NULL REFERENCES organizations (id),
      status      text        NOT NULL
                  CONSTRAINT conversations_status_check
                  CHECK (status IN ('open', 'closed')),
      subject     text        NOT NULL,
      assignee_id bigint      REFERENCES memberships (id),
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX conversations_org_id_idx ON conversations (org_id);
    CREATE INDEX conversations_assignee_id_idx ON conversations (assignee_id);
  `);

  pgm.sql(`
    CREATE TABLE messages (
      id              bigserial   PRIMARY KEY,
      conversation_id uuid        NOT NULL REFERENCES conversations (id),
      org_id          bigint      NOT NULL REFERENCES organizations (id),
      message         text        NOT NULL,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX messages_conversation_id_idx ON messages (conversation_id);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE messages;
    DROP TABLE conversations;
    DROP TABLE memberships;
    DROP TABLE users;
    DROP TABLE organizations;
  `);
};
