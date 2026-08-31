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
