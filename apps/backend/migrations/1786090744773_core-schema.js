/**
 * Core schema: organizations, users, memberships, conversations, messages.
 *
 * The DDL is written out by hand rather than built with pgm.createTable(). Later
 * drills read a migration and reason about exactly which lock a statement takes
 * and for how long — that only works if the statement is the thing in the file.
 * node-pg-migrate is here for ordering, the pgmigrations ledger, the advisory
 * lock and the surrounding transaction, not to generate SQL.
 *
 * The load-bearing rule: every tenant-owned row carries org_id directly, even
 * where a join could reach it. conversations and messages both have one.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  // plan is text + CHECK rather than an enum: adding a value to an enum is DDL,
  // adding one here is a one-line constraint swap. The constraint is named
  // explicitly so the error that comes back through `pg` identifies itself.
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

  // users.name is text, deliberately unlike organizations.name's varchar(255) —
  // length here is the application's business, and a varchar(n) is a constraint
  // you need a migration to relax.
  pgm.sql(`
    CREATE TABLE users (
      id         bigserial   PRIMARY KEY,
      name       text        NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  // UNIQUE (user_id, org_id) is not just integrity: its btree also answers
  // "which orgs is this user in?" as a leftmost-prefix scan, so user_id needs no
  // index of its own. Two indexes here, not three.
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

  // uuidv7() is native in Postgres 18 — no pgcrypto, no extension. Sequential
  // enough to keep the btree from fragmenting the way uuid_generate_v4() would,
  // but still 16 bytes against bigserial's 8, and every messages.conversation_id
  // pays that too. Chosen to be measured, not because it's free.
  //
  // Deliberately under-indexed: org_id and assignee_id get plain indexes, but
  // the composite an inbox listing actually wants —
  // (org_id, status, updated_at DESC) — is absent. Card 09 needs a victim.
  //
  // subject is dropped again in the next migration. It exists so the rollback
  // exercise has something lossy to roll back.
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

  // org_id is denormalized here on purpose — reaching the tenant through
  // conversations would put a join in front of every scoped query in the app.
  // It carries a real FK but no index, also on purpose. The first cost isn't
  // the obvious one: an unindexed *referencing* column means deleting an
  // organization has to sequential-scan messages to enforce this constraint.
  // Per-org aggregates are the second.
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

/**
 * A true inverse, which is only possible because nothing existed before it.
 * Reverse FK order; each DROP TABLE takes its indexes and its owned bigserial
 * sequence with it.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE messages;
    DROP TABLE conversations;
    DROP TABLE memberships;
    DROP TABLE users;
    DROP TABLE organizations;
  `);
};
