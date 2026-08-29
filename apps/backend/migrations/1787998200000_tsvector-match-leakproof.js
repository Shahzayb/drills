/**
 * Marks the tsvector match operator LEAKPROOF, which is the only reason the
 * GIN index is reachable at all under row-level security.
 *
 * WHAT WAS MEASURED
 *
 * With RLS on `messages` and `@@` not leakproof, the planner does not merely
 * cost the GIN index badly — it generates no index path for it. `SET
 * enable_seqscan = off` leaves the sequential scan marked `Disabled: true` and
 * still chooses it, because there is nothing else. Whale org, ERR_2452, median
 * of 5 client round-trips with the first discarded (`db:search plans`):
 *
 *   not leakproof   3,621 ms   Seq Scan, 707,129 buffer reads
 *   leakproof          25 ms   Bitmap Heap Scan on messages_org_tsv_idx
 *
 * WHY
 *
 * An RLS policy becomes a security qual that must be evaluated before any
 * ordinary qual. A qual may be promoted past it into an index condition only if
 * it is leakproof, and `ts_match_vq` is not:
 *
 *   SELECT p.proleakproof FROM pg_operator o JOIN pg_proc p ON p.oid = o.oprcode
 *    WHERE o.oprname = '@@' AND o.oprleft = 'tsvector'::regtype;   -- f
 *
 * So the tenant policy that drill 07 installed is what switched this drill's
 * index off. Neither half is wrong on its own.
 *
 * WHAT IT COSTS, HONESTLY
 *
 * LEAKPROOF is an assertion that the function reveals nothing about its
 * arguments except through its return value — no error messages carrying row
 * data, no side channels. `ts_match_vq` returns bool and raises no error that
 * depends on the tsvector it was handed, so the assertion holds for the obvious
 * cases. It is still an assertion, and it still widens what a caller can infer:
 * the operator now runs against rows that RLS would otherwise have removed
 * first, so a determined caller could in principle use timing to probe whether
 * another tenant's messages contain a term. That is the trade, stated rather
 * than buried.
 *
 * The alternative that keeps the guarantee whole is to accept the sequential
 * scan, which is 100x slower and is the thing this card set out to remove.
 *
 * Requires superuser, and it is a catalog change to a built-in function: it
 * lives in this database only and does not survive a dump/restore or a major
 * version upgrade. See plans/2026-08-29_drill-11-full-text-search.md.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.sql(`ALTER FUNCTION ts_match_vq(tsvector, tsquery) LEAKPROOF;`);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`ALTER FUNCTION ts_match_vq(tsvector, tsquery) NOT LEAKPROOF;`);
};
