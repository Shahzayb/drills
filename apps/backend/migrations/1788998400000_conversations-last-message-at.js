/**
 * `conversations.last_message_at` — the expand half of card 16.
 *
 * NULLABLE, and that is the whole design. A required column arrives in three
 * separate deploys: add it nullable, teach every writer to fill it, backfill
 * the rows that predate the column, and only then make it required. This file
 * is step one, and it is the only step that is allowed to be a migration —
 * `pnpm db:schema backfill` is step three, because a backfill that runs inside
 * a migration holds node-pg-migrate's advisory lock and blocks every other
 * deploy for as long as it takes.
 *
 * WHY NOT `ADD COLUMN ... NOT NULL DEFAULT now()` IN ONE STATEMENT
 *
 * It works, it takes about three milliseconds, and it is wrong. Since Postgres
 * 11 a NON-VOLATILE default is evaluated once and stored in
 * `pg_attribute.attmissingval`, so nothing is rewritten and every existing row
 * reads that single value back. `now()` is STABLE, so it qualifies — and all
 * 2.5M conversations end up claiming their last message arrived at the instant
 * of the migration. Fast, silent, and every row wrong.
 *
 * `pnpm db:schema naive --shape fastwrong` measures exactly that and counts the
 * rows it corrupts. Numbers in plans/2026-09-10_drill-16-zero-downtime-migration.md.
 *
 * So the DEFAULT is a SEPARATE statement. Setting a default on an EXISTING
 * column touches only the catalog and applies to future inserts only, which is
 * the semantics we want: a conversation created from now on gets `now()`, and a
 * conversation that predates the column gets whatever the backfill computes.
 *
 * WHY A DEFAULT AT ALL
 *
 * `POST /ingest` writes the conversation and its first message in one
 * transaction, so `now()` is the correct value for every row this application
 * creates. The default is therefore a real answer rather than a placeholder, and
 * it is what lets the ~18 other INSERT sites in this repo stay untouched.
 *
 * WHY NOT JUST USE `updated_at`
 *
 * Because `updateStatus()` and drill 14's assign both move `updated_at` on a
 * write that is not a message. The seed happens to build the two equal, which
 * makes it a useful oracle for the backfill and not a reason to skip the column.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * Both statements are catalog-only. They take ACCESS EXCLUSIVE on
 * `conversations` and hold it for microseconds, which is the difference between
 * a lock you take and an outage you cause.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE conversations
      ADD COLUMN last_message_at timestamptz;
  `);

  pgm.sql(`
    ALTER TABLE conversations
      ALTER COLUMN last_message_at SET DEFAULT now();
  `);
};

/**
 * A true inverse, and a lossy one: the column carries the only record of when a
 * conversation last had a message that is not also a record of every other kind
 * of write.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`ALTER TABLE conversations DROP COLUMN last_message_at;`);
};
