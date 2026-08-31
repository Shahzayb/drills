import pg from 'pg';

const client = new pg.Client({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

const APP_USER = process.env.POSTGRES_APP_USER;

const failures: string[] = [];

await client.connect();

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
    failures.push(
      `${t.table_name}: no policy has a WITH CHECK — a tenant can write a row ` +
        'out of its own scope',
    );
  }
}

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

if (failures.length > 0) {
  console.error('tenant isolation check FAILED\n');
  for (const failure of failures) console.error(`  - ${failure}`);
  console.error(
    '\nSee plans/2026-08-15_drill-07-tenant-isolation.md and ' +
      'migrations/1786791300000_tenant-isolation-rls.js',
  );
  process.exit(1);
}

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
