// pg_stat_statements: the zero-application-code way to see a request's round
// trips, alongside the statement log db:log:on already gives. Card 08's
// detection exercise compares the two — see
// plans/2026-08-17_drill-08-n-plus-one.md.
//
// Off by default: shared_preload_libraries is postmaster-context, so turning
// it on needs postgres_db recreated, not just reloaded —
//
//   PG_PRELOAD=pg_stat_statements docker compose up -d postgres_db
//   pnpm db:stats:on
//   pnpm db:stats
//   pnpm db:stats:reset
//
// `.mts` and not `.ts`: apps/backend/package.json has no `type` field, so a
// `.ts` here would be CommonJS. See plans/2026-08-30_instrument-typescript.md.
//
// One script, one subcommand, not three files — the psql-in-package.json
// pattern (db:log:*) breaks down once a query needs two orderings and a
// dealloc read; that is what killed drill 07's rls:status. See
// plans/2026-08-15_drill-07-tenant-isolation.md.

import { client as pgClient } from './lib/run.mts';

const client = pgClient();

const subcommand = process.argv[2];
const USAGE = 'usage: node db/stats.mts <on|report|reset>';

if (!['on', 'report', 'reset'].includes(subcommand)) {
  console.error(USAGE);
  process.exit(1);
}

async function on() {
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
  } catch (error) {
    // The one failure worth a legible message: the extension's SQL objects
    // need the C library preloaded first, and that error message is a stock
    // one-liner that does not say what to do about it.
    //
    // `catch` binds `unknown`, and pg's SQLSTATE arrives as a `code` property
    // rather than on a typed error class — so it is read off a narrowed shape.
    const failed = error as { code?: string; message?: string };
    if (
      failed.code === '55000' ||
      /shared_preload_libraries/i.test(String(failed.message))
    ) {
      console.error(
        'pg_stat_statements is not preloaded.\n\n' +
          '  PG_PRELOAD=pg_stat_statements docker compose up -d postgres_db\n' +
          '  pnpm db:stats:on\n',
      );
      process.exit(1);
    }
    throw error;
  }
  console.log('pg_stat_statements enabled');
}

async function report() {
  const { rows: info } = await client.query(
    `SELECT dealloc, stats_reset FROM pg_stat_statements_info`,
  );

  // Two orderings, deliberately not one. `calls` is what an N+1 loop looks
  // like from here — many cheap round trips. `mean_exec_time` is what a
  // genuinely slow statement looks like — few, expensive ones. A query can be
  // the worst offender by one and invisible by the other; sorting only by
  // total_exec_time would blur the two into a single number and hide exactly
  // the contrast this check exists to show.
  const byCalls = await client.query(`
    SELECT calls, round(mean_exec_time::numeric, 3) AS mean_ms,
           round(total_exec_time::numeric, 1) AS total_ms,
           left(query, 100) AS query
      FROM pg_stat_statements
     WHERE query NOT ILIKE '%pg_stat_statements%'
     ORDER BY calls DESC
     LIMIT 10
  `);

  const byMean = await client.query(`
    SELECT calls, round(mean_exec_time::numeric, 3) AS mean_ms,
           round(total_exec_time::numeric, 1) AS total_ms,
           left(query, 100) AS query
      FROM pg_stat_statements
     WHERE query NOT ILIKE '%pg_stat_statements%'
     ORDER BY mean_exec_time DESC
     LIMIT 10
  `);

  console.log(
    `dealloc=${info[0]?.dealloc ?? 'n/a'} (pg_stat_statements.max entries evicted since reset — a climbing number under a fixed workload means queryids are not normalising and every request is minting its own row)`,
  );
  console.log(`stats_reset=${info[0]?.stats_reset ?? 'n/a'}\n`);

  console.log('top 10 by calls (an N+1 loop looks like this):');
  console.table(byCalls.rows);

  console.log(
    '\ntop 10 by mean_exec_time (a genuinely slow statement looks like this):',
  );
  console.table(byMean.rows);
}

async function reset() {
  await client.query('SELECT pg_stat_statements_reset()');
  console.log('pg_stat_statements reset');
}

await client.connect();
try {
  if (subcommand === 'on') await on();
  else if (subcommand === 'report') await report();
  else await reset();
} finally {
  await client.end();
}
