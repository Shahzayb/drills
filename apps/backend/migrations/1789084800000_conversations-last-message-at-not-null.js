/**
 * `conversations.last_message_at` becomes required — the contract half of card 16.
 *
 * Runs AFTER the code that fills the column is deployed and AFTER
 * `pnpm db:schema backfill` has walked the 2.5M rows that predate it. Run it
 * before either and it is correct and useless: the constraint rejects every
 * insert that omits the column, and VALIDATE fails on the first NULL it finds.
 *
 * THE TWO STATEMENTS, AND THE LOCK EACH ONE TAKES
 *
 *   ADD CONSTRAINT ... NOT NULL ... NOT VALID   ACCESS EXCLUSIVE, catalog only,
 *                                               microseconds. Enforced for every
 *                                               INSERT and UPDATE from this
 *                                               moment on. NOT VALID means "the
 *                                               rows already here are unchecked",
 *                                               not "this is not enforced" —
 *                                               `pg_attribute.attnotnull` is set
 *                                               immediately.
 *   VALIDATE CONSTRAINT                         SHARE UPDATE EXCLUSIVE. Scans all
 *                                               2.5M rows and blocks NEITHER
 *                                               readers nor writers. It conflicts
 *                                               only with VACUUM, ANALYZE and
 *                                               CREATE INDEX CONCURRENTLY.
 *
 * The naive spelling of the same intent is one statement — ALTER COLUMN ... SET
 * NOT NULL — which takes ACCESS EXCLUSIVE and holds it for a full scan of the
 * table, queueing every read and every write in the application behind it. The
 * split above is the whole card.
 *
 * THIS SYNTAX IS POSTGRES 18. ON 17 AND EARLIER, USE A CHECK CONSTRAINT
 *
 * A not-null constraint only became a first-class catalog object (contype 'n',
 * addable NOT VALID) in Postgres 18. The recipe everyone wrote before that gets
 * to the same place in three statements, through a CHECK constraint as a proxy:
 *
 *   ALTER TABLE t ADD CONSTRAINT c CHECK (col IS NOT NULL) NOT VALID;
 *   ALTER TABLE t VALIDATE CONSTRAINT c;
 *   ALTER TABLE t ALTER COLUMN col SET NOT NULL;
 *
 * The third statement still takes ACCESS EXCLUSIVE and still returns instantly,
 * because since Postgres 12 SET NOT NULL accepts a VALIDATED CHECK as proof that
 * no NULL can be present and skips the scan it would otherwise need. The CHECK
 * is then redundant and usually dropped.
 *
 * `pgm.noTransaction()` IS NOT OPTIONAL HERE
 *
 * A lock is held until the transaction that took it commits. node-pg-migrate
 * wraps each migration in one transaction by default, so inside it the ACCESS
 * EXCLUSIVE taken by ADD CONSTRAINT would still be held while VALIDATE did its
 * full scan — reinstating, exactly, the outage the NOT VALID split exists to
 * avoid. The statements have to be two transactions, and noTransaction() is what
 * buys that.
 *
 * The price is the same one migration 005 pays for CREATE INDEX CONCURRENTLY:
 * this migration is NOT atomic. A failure between the two leaves the constraint
 * present and unvalidated, which is a safe state — writes are still checked —
 * and re-running is safe because VALIDATE on an already-valid constraint is a
 * no-op.
 *
 * PRIOR ART IN THIS REPO
 *
 * `db/seed.mts` already re-adds `messages_conversation_id_fkey` as NOT VALID and
 * then validates it, for the speed of the bulk load. Same technique, different
 * problem: there it avoids per-row checks during a COPY, here it avoids a long
 * lock on a live table.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

const CONSTRAINT = 'conversations_last_message_at_not_null';

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.noTransaction();

  pgm.sql(`
    ALTER TABLE conversations
      ADD CONSTRAINT ${CONSTRAINT} NOT NULL last_message_at NOT VALID;
  `);

  pgm.sql(`
    ALTER TABLE conversations
      VALIDATE CONSTRAINT ${CONSTRAINT};
  `);
};

/**
 * A true inverse, and cheap in this direction: dropping a not-null constraint is
 * catalog-only. It is only the ADDING of one that can require a scan.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`ALTER TABLE conversations DROP CONSTRAINT ${CONSTRAINT};`);
};
