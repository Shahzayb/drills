/**
 * A plan change made anywhere, including straight in psql, announces itself on the `entitlements`
 * channel. The API's `notify` arm LISTENs and deletes the cached key.
 * NOTIFY is sent at COMMIT and only to sessions listening at that moment: at-most-once, not durable.
 * See plans/2026-09-23_drill-19-entitlement-cache.md.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  // plan_limits edits are not covered: one row fans out to every org on the plan. TTL bounds them.
  pgm.sql(`
    CREATE FUNCTION app_notify_entitlements() RETURNS trigger
      LANGUAGE plpgsql
      AS $$
      BEGIN
        PERFORM pg_notify('entitlements', NEW.id::text);
        RETURN NULL;
      END
      $$;

    CREATE TRIGGER organizations_entitlements_notify
      AFTER UPDATE OF plan ON organizations
      FOR EACH ROW
      WHEN (OLD.plan IS DISTINCT FROM NEW.plan)
      EXECUTE FUNCTION app_notify_entitlements();
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`
    DROP TRIGGER organizations_entitlements_notify ON organizations;
    DROP FUNCTION app_notify_entitlements();
  `);
};
