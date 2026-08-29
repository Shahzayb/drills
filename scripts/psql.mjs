// The psql one-liners that used to live in package.json. `pnpm db:log:on`,
// `pnpm db:activity`, `pnpm db:psql`.
//
// Seven scripts had grown to 1,124 characters, 588 of which was one 84-character
// prefix — `docker compose exec -T postgres_db sh -c 'psql -U "$POSTGRES_USER"
// -d "$POSTGRES_DB"` — pasted seven times. CLAUDE.md limits shell in
// package.json to one-liners, and a 235-character psql call with embedded SQL is
// not one. The script names did not change, so every `pnpm db:log:on` printed
// across plans/ and drills/ still works.
//
// The other half of the point: SQL in a JSON string cannot carry a comment
// saying why. Here it can.
//
// Runs on the HOST. See plans/2026-08-30_instrument-hardening.md section 6.

import { spawnSync } from 'node:child_process';

const COMMANDS = {
  'migrate:status': {
    blurb: 'which migrations have run',
    sql: ['table pgmigrations order by id'],
  },

  reset: {
    blurb:
      'drop and recreate the public schema (package.json chains migrate + seed)',
    stopOnError: true,
    sql: ['DROP SCHEMA public CASCADE; CREATE SCHEMA public;'],
  },

  psql: {
    blurb: 'an interactive prompt',
    interactive: true,
    sql: [],
  },

  // log_min_duration_statement = 0 logs every statement with its duration. ALTER
  // SYSTEM writes postgresql.auto.conf, so it survives a restart until reset —
  // hence a matching :off rather than relying on the container being recreated.
  // pg_reload_conf() applies it without a restart.
  'log:on': {
    blurb: 'log every statement with its duration',
    stopOnError: true,
    sql: [
      'ALTER SYSTEM SET log_min_duration_statement = 0',
      'SELECT pg_reload_conf()',
    ],
  },

  'log:off': {
    blurb: 'stop logging every statement',
    stopOnError: true,
    sql: [
      'ALTER SYSTEM RESET log_min_duration_statement',
      'SELECT pg_reload_conf()',
    ],
  },

  'log:status': {
    blurb: 'is statement logging on',
    sql: ['show log_min_duration_statement'],
  },

  // left(query, 140) because a seeded INSERT is thousands of characters and one
  // row would fill the terminal. pid <> pg_backend_pid() drops this very query,
  // which otherwise always appears as the one active statement.
  activity: {
    blurb: 'what is running on this database right now',
    sql: [
      'select pid, state, left(query, 140) as query from pg_stat_activity ' +
        'where datname = current_database() and pid <> pg_backend_pid() order by state',
    ],
  },
};

const name = process.argv[2];
const command = COMMANDS[name];

if (!command) {
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  console.error('usage: node scripts/psql.mjs <command>\n');
  for (const [key, { blurb }] of Object.entries(COMMANDS)) {
    console.error(`  ${key.padEnd(width + 2)} ${blurb}`);
  }
  process.exit(1);
}

// Each statement is single-quoted into the sh -c string, so a statement
// containing one would end the quote and change what runs.
for (const sql of command.sql) {
  if (sql.includes("'")) {
    console.error(
      `${name}: SQL containing a single quote needs different quoting`,
    );
    process.exit(1);
  }
}

// The env vars stay unexpanded here and are resolved by the container's sh,
// which is where POSTGRES_USER and POSTGRES_DB are actually set.
const psql = [
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
  command.stopOnError ? '-v ON_ERROR_STOP=1' : '',
  ...command.sql.map((sql) => `-c '${sql}'`),
]
  .filter(Boolean)
  .join(' ');

// -T everywhere except the interactive prompt, which needs the TTY.
const { status, error } = spawnSync(
  'docker',
  [
    'compose',
    'exec',
    ...(command.interactive ? [] : ['-T']),
    'postgres_db',
    'sh',
    '-c',
    psql,
  ],
  { stdio: 'inherit' },
);

if (error) {
  console.error(`could not run docker: ${error.message}`);
  process.exit(1);
}
process.exit(status ?? 1);
