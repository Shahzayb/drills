// Fails the build when a table that carries org_id is not covered by row-level
// security, or when the role the API serves with could bypass the policies
// anyway. `pnpm check:tenancy` from the repo root.
//
// This is the half of drill 07's stretch goal that catches the *next* table.
// The ESLint rule in apps/backend/eslint.config.mjs is the other half: it fires
// on the code, this fires on the schema, and neither is sufficient alone.
//
// Honest about what it is: this needs a live, migrated database, so it is an
// integration check rather than a static one. That is the right trade — the
// question "is conversations protected" is a fact about the running database,
// and a parser reading migration files would answer it from a model that can
// drift from the thing it models. See
// plans/2026-08-15_drill-07-tenant-isolation.md.

import pg from 'pg';

// Owner credentials, deliberately: this reads pg_class/pg_policy and inspects
// the *app* role's attributes, which is a maintenance job, not a serving one.
const client = new pg.Client({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

const APP_USER = process.env.POSTGRES_APP_USER;

const failures = [];

await client.connect();

// ---------------------------------------------------------------------------
// 1. Every table carrying org_id has RLS enabled, a policy, and a WITH CHECK.
// ---------------------------------------------------------------------------
//
// org_id is the marker because drill 02 made it one: every tenant-owned row
// carries it directly, so "has an org_id column" is the same set as "holds one
// tenant's data". A table that breaks that convention is invisible here, which
// is a real limit and the reason the convention is written down.

const { rows: tables } = await client.query(`
  SELECT c.relname AS table_name,
         c.relrowsecurity AS rls_enabled,
         c.relforcerowsecurity AS rls_forced,
         (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
         (SELECT count(*) FROM pg_policy p
           WHERE p.polrelid = c.oid AND p.polwithcheck IS NOT NULL) AS with_check
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = c.oid
                    AND a.attname = 'org_id'
                    AND a.attnum > 0
                    AND NOT a.attisdropped)
   ORDER BY c.relname
`);

if (tables.length === 0) {
  failures.push(
    'no table in `public` has an org_id column — either the database is not ' +
      'migrated, or this check is looking at the wrong thing',
  );
}

for (const t of tables) {
  if (!t.rls_enabled) {
    failures.push(
      `${t.table_name}: carries org_id but ROW LEVEL SECURITY is disabled`,
    );
    continue;
  }
  if (Number(t.policies) === 0) {
    failures.push(
      `${t.table_name}: RLS is enabled with no policy — that denies everything, ` +
        'which is safe and is almost certainly not what was meant',
    );
    continue;
  }
  if (Number(t.with_check) === 0) {
    // USING alone filters what you can see and therefore change. Only WITH
    // CHECK looks at the row as it will be after the write, which is what stops
    // a tenant setting org_id to somebody else's.
    failures.push(
      `${t.table_name}: no policy has a WITH CHECK — a tenant can write a row ` +
        'out of its own scope',
    );
  }
}

// ---------------------------------------------------------------------------
// 2. The serving role cannot bypass what those policies say.
// ---------------------------------------------------------------------------
//
// This is the check that matters most, because its failure mode is invisible:
// the policies are present, the schema looks protected, `\d conversations`
// shows them — and nothing is enforced. Postgres exempts three things from RLS:
// a superuser, a role with BYPASSRLS, and the table owner (unless FORCE ROW
// LEVEL SECURITY, which this schema deliberately does not set so that
// migrations and drill 04's COPY seed still work as the owner).

if (!APP_USER) {
  failures.push('POSTGRES_APP_USER is not set — cannot check the serving role');
} else {
  const { rows } = await client.query(
    `SELECT r.rolsuper, r.rolbypassrls,
            (SELECT count(*) FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND c.relkind = 'r'
                AND c.relrowsecurity
                AND NOT c.relforcerowsecurity
                AND c.relowner = r.oid) AS owned_unforced
       FROM pg_roles r
      WHERE r.rolname = $1`,
    [APP_USER],
  );

  if (rows.length === 0) {
    failures.push(`role ${APP_USER} does not exist`);
  } else {
    const role = rows[0];
    if (role.rolsuper) {
      failures.push(
        `${APP_USER} is a SUPERUSER — superusers bypass RLS unconditionally, ` +
          'and FORCE ROW LEVEL SECURITY does not change that',
      );
    }
    if (role.rolbypassrls) {
      failures.push(`${APP_USER} has BYPASSRLS`);
    }
    if (Number(role.owned_unforced) > 0) {
      failures.push(
        `${APP_USER} owns ${role.owned_unforced} RLS table(s) without FORCE — ` +
          'a table owner is exempt from its own policies',
      );
    }
  }
}

await client.end();

// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error('tenant isolation check FAILED\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    '\nSee plans/2026-08-15_drill-07-tenant-isolation.md and ' +
      'migrations/1786791300000_tenant-isolation-rls.js',
  );
  process.exit(1);
}

// Printed on success too, not just on failure. This doubles as the "check
// rather than assume" command — there is no separate `rls:status`, because a
// second command that reports the same facts is a second thing to keep true.
console.log('tenant isolation check passed\n');
console.table(
  tables.map((t) => ({
    table: t.table_name,
    rls: t.rls_enabled,
    forced: t.rls_forced,
    policies: Number(t.policies),
    with_check: Number(t.with_check),
  })),
);
console.log(
  `serving role: ${APP_USER} — not a superuser, no BYPASSRLS, owns none of the above`,
);
