/**
 * The composite index the inbox listing wants, and the one migration 001
 * deliberately left out ("Card 09 needs a victim").
 *
 *   (org_id, updated_at DESC, id DESC)
 *
 * THE COLUMN ORDER THAT WAS REASONED OUT FIRST, AND WHY IT IS NOT THIS ONE
 *
 * The design written down before anything was measured was four columns —
 * (org_id, status, updated_at DESC, id DESC) — on the textbook rule "equality
 * columns before range columns". Measured, it was WRONG, and instructively so:
 * `status` is OPTIONAL, and an optional equality sitting between the tenant key
 * and the sort key makes the index unusable for every query that omits it.
 * Inside one org the four-column index is ordered by (status, updated_at), not
 * by updated_at — so the *default* page, the one with no status filter at all,
 * went right on sequential-scanning at ~113ms with the index sitting there.
 *
 * Dropping `status` out of the key costs nothing measurable (the filter becomes
 * a cheap recheck while walking updated_at DESC) and buys the default page:
 * every shape — filtered, unfiltered, either status — lands on an Index Scan at
 * ~0.25ms. It is 118MB against the four-column version's 140MB.
 *
 * The rule was not wrong; it was applied to a column that does not qualify.
 * "Equality before range" assumes the equality is always present. Numbers, the
 * rejected alternatives and the swap test are all in
 * plans/2026-08-25_drill-09-index-selectivity.md.
 *
 * So, column by column:
 *
 *   1. org_id      — the only predicate present in EVERY query this endpoint
 *                    can produce. A btree prefix is usable only if the query
 *                    constrains it, so the always-present column has to lead.
 *   2. updated_at  — the range AND the sort. With org_id pinned, the index's own
 *      DESC          order inside that slice IS `updated_at DESC`, so
 *                    ORDER BY ... LIMIT 50 walks 50 entries and stops, with no
 *                    Sort node at all — at any selectivity.
 *   3. id DESC     — drill 03's tiebreaker. Nothing filters on it; it is here so
 *                    the index covers the WHOLE sort key and the plan needs no
 *                    sort, not even a cheap one.
 *
 * DESC is not decoration either: a btree can be read backwards, so an all-ASC
 * index would serve `ORDER BY updated_at DESC, id DESC` as a full reverse scan.
 * It stops working the moment the two directions disagree. Matching the ORDER BY
 * exactly makes that a non-question.
 *
 * WHY CONCURRENTLY, AND WHAT IT COSTS
 *
 * A plain CREATE INDEX takes a SHARE lock on conversations: reads continue,
 * every INSERT/UPDATE/DELETE blocks until the build finishes. On 2.5M rows that
 * is an outage, not a migration. CONCURRENTLY takes SHARE UPDATE EXCLUSIVE
 * instead and lets writes through, paying for it with two table scans and a
 * wait for every transaction open when it starts.
 *
 * The price is that it CANNOT run inside a transaction block — hence
 * pgm.noTransaction() — and therefore this migration is NOT atomic. If it fails
 * half way it leaves an index with `indisvalid = false`: invisible to the
 * planner, still maintained on every write. Find one with
 *
 *   SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE NOT indisvalid;
 *
 * and recover by dropping it and re-running. IF NOT EXISTS makes the re-run
 * safe.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

const INDEX_NAME = 'conversations_org_updated_idx';

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS ${INDEX_NAME}
      ON conversations (org_id, updated_at DESC, id DESC);
  `);
};

/**
 * DROP CONCURRENTLY for the same reason as the build: the plain form takes
 * ACCESS EXCLUSIVE and blocks readers too, which is worse than what it undoes.
 *
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`DROP INDEX CONCURRENTLY IF EXISTS ${INDEX_NAME};`);
};
