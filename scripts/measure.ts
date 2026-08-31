import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

interface Knob {
  flag: string;
  env: string;
  def?: string;
  help: string;
}

interface Instrument {
  file: string;
  blurb: string;
  subcommands: Record<string, string> | null;
  knobs: Knob[];
}

const COMMON: Knob[] = [
  { flag: 'name', env: 'NAME', help: 'labels the report directory' },
];

const INSTRUMENTS: Record<string, Instrument> = {
  explain: {
    file: 'db/explain.mts',
    blurb: 'query plans, index selectivity, and the offset/keyset EXPLAIN',
    subcommands: {
      plans: 'the shipped list query, one plan per filter combination',
      sweep: 'walk a date ladder until the planner abandons the index',
      experiments: 'candidate indexes priced against the shipped one',
      stats: 'pg_stats selectivity for the columns the list query filters',
      keyset: 'offset vs keyset plans at depth',
    },
    knobs: [
      { flag: 'org', env: 'ORG_ID', def: '1', help: 'which org to measure' },
      {
        flag: 'status',
        env: 'STATUS',
        def: 'closed',
        help: 'sweep: status filter',
      },
      {
        flag: 'sort',
        env: 'SORT',
        def: 'created_at / updated_at',
        help: 'sort column (keyset defaults to updated_at)',
      },
      {
        flag: 'days',
        env: 'DAYS',
        def: '548,365,270,…,3,1',
        help: 'sweep: the date ladder',
      },
      {
        flag: 'depths',
        env: 'DEPTHS',
        def: '1,100,5000',
        help: 'keyset: page depths',
      },
    ],
  },

  paging: {
    file: 'db/paging.mts',
    blurb: 'offset vs keyset pagination, measured over HTTP',
    subcommands: {
      depths: 'both arms at each depth, N rounds, median',
      walk: 'cost of paging the whole list, both arms',
      concurrent: 'both arms under concurrent load',
    },
    knobs: [
      { flag: 'org', env: 'ORG_ID', def: '1', help: 'which org to measure' },
      { flag: 'page-size', env: 'PAGE_SIZE', def: '50', help: 'rows per page' },
      {
        flag: 'rounds',
        env: 'ROUNDS',
        def: '3',
        help: 'measurements per cell',
      },
      {
        flag: 'depths',
        env: 'DEPTHS',
        def: '1,10,100,1000,5000',
        help: 'depths: which pages to sample',
      },
      {
        flag: 'max-pages',
        env: 'MAX_PAGES',
        def: '400',
        help: 'walk: stop after this many pages per arm',
      },
    ],
  },

  search: {
    file: 'db/search.mts',
    blurb: 'full-text search: plans, index candidates, and write cost',
    subcommands: {
      plans: 'ILIKE vs FTS plans across a selectivity ladder',
      indexes: 'every candidate index priced — build time, size, scan node',
      gaps: 'what FTS misses that ILIKE finds, and the reverse',
      writes: 'what the tsvector column and its index cost on INSERT',
    },
    knobs: [
      { flag: 'org', env: 'ORG_ID', def: '1', help: 'which org to measure' },
      {
        flag: 'term',
        env: 'SEARCH_TERM',
        def: 'export, ERR_2452',
        help: 'one term instead of the selectivity ladder',
      },
      {
        flag: 'rounds',
        env: 'ROUNDS',
        def: '5',
        help: 'measurements per cell',
      },
      { flag: 'limit', env: 'LIMIT', def: '20', help: 'rows per search' },
      {
        flag: 'only',
        env: 'ONLY',
        def: '(all)',
        help: 'indexes: substring filter over candidate labels',
      },
      {
        flag: 'mwm',
        env: 'MAINTENANCE_WORK_MEM',
        def: '512MB',
        help: 'indexes: session maintenance_work_mem',
      },
      { flag: 'rows', env: 'ROWS', def: '50000', help: 'writes: corpus size' },
      {
        flag: 'inserts',
        env: 'INSERTS',
        def: '2000',
        help: 'writes: how many rows to time',
      },
    ],
  },

  bench: {
    file: 'db/bench-copy.mts',
    blurb: 'INSERT vs multi-row INSERT vs COPY, on a scratch table',
    subcommands: null,
    knobs: [
      { flag: 'rows', env: 'BENCH_ROWS', def: '100000', help: 'rows per arm' },
    ],
  },
};

const die: (message: string) => never = (message) => {
  console.error(message);
  process.exit(1);
};

function help(name: string, instrument: Instrument): string {
  const lines = [`${name} — ${instrument.blurb}`, ''];

  if (instrument.subcommands) {
    const width = Math.max(
      ...Object.keys(instrument.subcommands).map((s) => s.length),
    );
    for (const [sub, blurb] of Object.entries(instrument.subcommands)) {
      lines.push(`  ${sub.padEnd(width + 2)} ${blurb}`);
    }
    lines.push('');
  }

  lines.push('knobs   (--flag value, or NAME=value in the environment)');
  const knobs = [...instrument.knobs, ...COMMON];
  const width = Math.max(...knobs.map((k) => k.flag.length));
  for (const k of knobs) {
    lines.push(
      `  --${k.flag.padEnd(width + 2)} ${(k.def ?? '(none)').padEnd(22)} ${k.help}`,
    );
  }

  return lines.join('\n');
}

const [name, ...rest] = process.argv.slice(2);
const instrument = name ? INSTRUMENTS[name] : undefined;

if (!instrument) {
  die(
    `usage: node scripts/measure.ts <${Object.keys(INSTRUMENTS).join('|')}> [subcommand] [--flags]`,
  );
}

const knobs = [...instrument.knobs, ...COMMON];

const options: Record<string, { type: 'string' | 'boolean'; short?: string }> =
  {
    help: { type: 'boolean', short: 'h' },
  };
for (const k of knobs) options[k.flag] = { type: 'string' };

const parse = (args: string[]) => {
  try {
    return parseArgs({ args, options, allowPositionals: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    die(`${message.split('. ')[0]}\n\n${help(name, instrument)}`);
  }
};

const { values, positionals } = parse(rest);

const [subcommand] = positionals;

if (values.help || (instrument.subcommands && !subcommand)) {
  console.log(help(name, instrument));
  process.exit(values.help ? 0 : 1);
}

if (instrument.subcommands && !instrument.subcommands[subcommand]) {
  die(`${name} has no subcommand '${subcommand}'\n\n${help(name, instrument)}`);
}

const env: string[] = [];
for (const k of knobs) {
  const value = values[k.flag] ?? process.env[k.env];
  if (value) env.push('-e', `${k.env}=${String(value)}`);
}

const gitSha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], {
  encoding: 'utf8',
}).stdout?.trim();
if (gitSha) env.push('-e', `GIT_SHA=${gitSha}`);

const { status, error } = spawnSync(
  'docker',
  [
    'compose',
    'exec',
    '-T',
    '-w',
    '/app/apps/backend',
    ...env,
    'nest_server',
    'node',
    instrument.file,
    ...(subcommand ? [subcommand] : []),
  ],
  { stdio: 'inherit' },
);

if (error) die(`could not run docker: ${error.message}`);
process.exit(status ?? 1);
