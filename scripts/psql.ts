import { spawnSync } from 'node:child_process';

interface Command {
  blurb: string;
  sql: string[];
  stopOnError?: boolean;
  interactive?: boolean;
}

const COMMANDS: Record<string, Command> = {
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

  activity: {
    blurb: 'what is running on this database right now',
    sql: [
      'select pid, state, left(query, 140) as query from pg_stat_activity ' +
        'where datname = current_database() and pid <> pg_backend_pid() order by state',
    ],
  },
};

const name = process.argv[2];
const command = name ? COMMANDS[name] : undefined;

if (!command) {
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  console.error('usage: node scripts/psql.ts <command>\n');
  for (const [key, { blurb }] of Object.entries(COMMANDS)) {
    console.error(`  ${key.padEnd(width + 2)} ${blurb}`);
  }
  process.exit(1);
}

for (const sql of command.sql) {
  if (sql.includes("'")) {
    console.error(
      `${name}: SQL containing a single quote needs different quoting`,
    );
    process.exit(1);
  }
}

const psql = [
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"',
  command.stopOnError ? '-v ON_ERROR_STOP=1' : '',
  ...command.sql.map((sql) => `-c '${sql}'`),
]
  .filter(Boolean)
  .join(' ');

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
