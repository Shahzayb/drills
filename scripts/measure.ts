// Runs the db/ measurement instruments in the container. `pnpm db:paging depths`,
// `pnpm db:explain sweep --org 150`, `pnpm db:search indexes --only gin`.
//
// This file exists because the four instrument entries in package.json had grown
// to 709 characters of `docker compose exec -T -e ORG_ID -e STATUS -e SORT …`,
// and because none of it told you which knobs a subcommand actually reads.
// `k6/run-baseline.mjs` already solved the same problem for k6 in 24 characters
// of package.json, by being a runner. This is that, for db/.
//
// The catalog below is the single declaration of every knob. It generates the
// -e flags, so the class of bug scripts/check-arms.ts was written to catch —
// a knob set in the shell that never reaches the code reading it — cannot be
// introduced by forgetting a flag any more. check-arms now checks this catalog
// against the instrument source instead.
//
// The catalog's literal shape is load-bearing twice over: check-arms parses it
// as TEXT for `file: '…'` and `env: '…', def: '…'`, so the types below annotate
// the surrounding const and never move a key inside the object literals. See
// plans/2026-08-30_instrument-typescript.md.
//
// Runs on the HOST. See plans/2026-08-30_instrument-hardening.md section 6.

import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

interface Knob {
  /** The `--flag` spelling. */
  flag: string;
  /** The environment variable `docker compose exec -e` forwards it as. */
  env: string;
  /** Shown in --help. Not sent: the default lives in the container, in knob(). */
  def?: string;
  help: string;
}

interface Instrument {
  file: string;
  blurb: string;
  subcommands: Record<string, string> | null;
  knobs: Knob[];
}

// Written by db/lib/run.mts rather than by any instrument, so every instrument
// gets them. GIT_SHA is computed here because .git is not mounted into the
// container.
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

  storm: {
    file: 'db/storm.mts',
    blurb: 'idempotent ingest under a duplicate storm (drill 12)',
    subcommands: {
      key: 'mint an api key for an org and print it once',
      fire: 'the storm: N requests, U unique, concurrent — asserts and exits 1',
      race: 'what each mechanism protects against, with two live sessions',
      'redis-restart': 'the same storm with the guard wiped half way through',
    },
    knobs: [
      { flag: 'org', env: 'ORG_ID', def: '1', help: 'which org receives them' },
      {
        flag: 'requests',
        env: 'REQUESTS',
        def: '10000',
        help: 'total deliveries',
      },
      {
        flag: 'unique',
        env: 'UNIQUE',
        def: '3000',
        help: 'distinct events among them',
      },
      {
        flag: 'concurrency',
        env: 'CONCURRENCY',
        def: '50',
        help: 'requests in flight at once',
      },
      {
        flag: 'shape',
        env: 'SHAPE',
        def: 'adjacent',
        help: 'adjacent | shuffled — shuffled never races',
      },
      {
        flag: 'flush-at',
        env: 'FLUSH_AT',
        def: '50',
        help: 'redis-restart: percent through the run to wipe the guard',
      },
    ],
  },

  quota: {
    file: 'db/quota.mts',
    blurb:
      'the lost update on the quota counter, and the three fixes (drill 13)',
    subcommands: {
      fire: 'N concurrent increments through POST /ingest — asserts and exits 1',
      bench:
        'the four arms in raw SQL at the same concurrency: throughput, retries',
      race: 'two sessions, a controlled interleaving, and the isolation ladder',
      skew: 'the stretch: a second counter under one shared budget',
    },
    knobs: [
      { flag: 'org', env: 'ORG_ID', def: '1', help: 'which org is metered' },
      {
        flag: 'requests',
        env: 'REQUESTS',
        def: '100',
        help: 'increments per run',
      },
      {
        flag: 'concurrency',
        env: 'CONCURRENCY',
        def: '100',
        help: 'how many are in flight at once',
      },
      {
        flag: 'rounds',
        env: 'ROUNDS',
        def: '3',
        help: 'bench: measurements per arm',
      },
      {
        flag: 'only',
        env: 'ONLY',
        def: '(all)',
        help: 'bench/skew: substring filter over arm labels',
      },
      {
        flag: 'quota-limit',
        env: 'QUOTA_LIMIT',
        def: '100',
        help: 'skew: the shared budget the two counters race against',
      },
    ],
  },

  claim: {
    file: 'db/claim.mts',
    blurb:
      'two agents claim one ticket: last-write-wins vs a version check (drill 14)',
    subcommands: {
      fire: 'N concurrent claims on ONE row through the API — asserts and exits 1',
      bench:
        'conflict rate and successful-write throughput at each contention level',
      race: 'two sessions, a controlled interleaving, and what each arm does',
    },
    knobs: [
      { flag: 'org', env: 'ORG_ID', def: '1', help: 'which org owns the row' },
      {
        flag: 'requests',
        env: 'REQUESTS',
        def: '50',
        help: 'fire: claimers racing for the row',
      },
      {
        flag: 'concurrency',
        env: 'CONCURRENCY',
        def: '50',
        help: 'fire: how many are in flight at once',
      },
      {
        flag: 'levels',
        env: 'LEVELS',
        def: '2,10,50',
        help: 'bench: the contention ladder',
      },
      {
        flag: 'rounds',
        env: 'ROUNDS',
        def: '3',
        help: 'bench: measurements per cell',
      },
      {
        flag: 'seconds',
        env: 'SECONDS',
        def: '5',
        help: 'bench: how long each cell runs',
      },
      {
        flag: 'only',
        env: 'ONLY',
        def: '(all)',
        help: 'bench: substring filter over arm labels',
      },
    ],
  },

  import: {
    file: 'db/import.mts',
    blurb:
      'a 200MB CSV import: buffered vs streamed, and what a retry does (drill 15)',
    subcommands: {
      gen: 'write a deterministic CSV of MB megabytes, optionally poisoned',
      fire: 'upload it through POST /imports and watch memory — asserts and exits 1',
      bench:
        'per-row vs batched INSERT vs COPY, in raw SQL, at each batch size',
      resume: 'fail an import mid-file, then resume and restart it',
    },
    knobs: [
      {
        flag: 'org',
        env: 'ORG_ID',
        def: '1',
        help: 'which org receives the rows',
      },
      {
        flag: 'mb',
        env: 'MB',
        def: '200',
        help: 'gen: file size in megabytes',
      },
      {
        flag: 'poison-at',
        env: 'POISON_AT',
        def: '0',
        help: 'gen: row number that fails to parse (0 = none)',
      },
      {
        flag: 'file',
        env: 'FILE',
        def: 'history-200mb.csv',
        help: 'the CSV every subcommand reads or writes',
      },
      {
        flag: 'batches',
        env: 'BATCHES',
        def: '100,1000,5000,10000',
        help: 'bench: the batch-size ladder',
      },
      { flag: 'rows', env: 'ROWS', def: '100000', help: 'bench: corpus size' },
      {
        flag: 'rounds',
        env: 'ROUNDS',
        def: '3',
        help: 'bench: measurements per cell',
      },
      {
        flag: 'only',
        env: 'ONLY',
        def: '(all)',
        help: 'bench: substring filter over arm labels',
      },
    ],
  },

  schema: {
    file: 'db/schema.mts',
    blurb:
      'a required column on 2.5M live rows: the lock, the backfill, the index (drill 16)',
    subcommands: {
      naive: 'the whole migration in one transaction — timed, and watched',
      safe: 'the same result in four steps, none of them blocking',
      backfill: "the real column's one-time backfill, resumable",
      locks: 'two live sessions: which lock, held how long, blocking what',
      bench: 'the batch ladder, and the scan shape inside it',
      index: 'CREATE INDEX vs CONCURRENTLY, and the failures CIC has alone',
    },
    knobs: [
      { flag: 'org', env: 'ORG_ID', def: '1', help: 'labels the report' },
      {
        flag: 'shape',
        env: 'SHAPE',
        def: 'backfill',
        help: 'naive: backfill | rewrite | fastwrong',
      },
      {
        flag: 'column',
        env: 'COLUMN',
        def: 'last_message_at',
        help: 'the column to fill; naive/safe suffix it',
      },
      { flag: 'batch', env: 'BATCH', def: '1000', help: 'rows per batch' },
      {
        flag: 'pause-ms',
        env: 'PAUSE_MS',
        def: '10',
        help: 'pause between batches',
      },
      {
        flag: 'scan',
        env: 'SCAN',
        def: 'keyset',
        help: 'keyset | isnull — how a batch is chosen',
      },
      {
        flag: 'sample-ms',
        env: 'SAMPLE_MS',
        def: '250',
        help: 'pg_locks sampling interval',
      },
      {
        flag: 'wait',
        env: 'WAIT',
        def: '0',
        help: 'seconds to wait before the DDL, to land inside a k6 window',
      },
      {
        flag: 'abort-after',
        env: 'ABORT_AFTER',
        def: '0',
        help: 'naive: cancel the transaction after N seconds',
      },
      {
        flag: 'batches',
        env: 'BATCHES',
        def: '1000,10000,100000',
        help: 'bench: the batch-size ladder',
      },
      {
        flag: 'rows',
        env: 'ROWS',
        def: '200000',
        help: 'bench: rows backfilled per cell',
      },
      {
        flag: 'only',
        env: 'ONLY',
        def: '(all)',
        help: 'bench/index: substring filter over cell labels',
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

// Annotated on the const, not on the arrow: TypeScript only lets a `never`
// return narrow the code after the call when the *variable* carries the type.
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

// ------------------------------------------------------------------- dispatch

const [name, ...rest] = process.argv.slice(2);
const instrument = name ? INSTRUMENTS[name] : undefined;

if (!instrument) {
  die(
    `usage: node scripts/measure.ts <${Object.keys(INSTRUMENTS).join('|')}> [subcommand] [--flags]`,
  );
}

const knobs = [...instrument.knobs, ...COMMON];

// No defaults in this config on purpose. parseArgs returns a configured default
// as though the operator had supplied it, which would forward every knob and
// make db/lib/run.mts report `(env)` for values nobody set — destroying the
// provenance the header exists to print. Defaults stay in knob(), in the
// container.
const options: Record<string, { type: 'string' | 'boolean'; short?: string }> =
  {
    help: { type: 'boolean', short: 'h' },
  };
for (const k of knobs) options[k.flag] = { type: 'string' };

// An arrow on a const, not a function declaration: a hoisted declaration does
// not see that the `if` above already narrowed instrument away from null.
const parse = (args: string[]) => {
  try {
    return parseArgs({ args, options, allowPositionals: true });
  } catch (error) {
    // parseArgs' own message trails into advice about `--` and positional
    // arguments, which is not the reader's problem. The knob list is.
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

// ------------------------------------------------------------------- the run

// A flag beats the environment; an unset knob is forwarded as nothing at all,
// so the instrument sees it as absent rather than as the empty string.
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
    // The instruments are run by path rather than through a package.json
    // script, so apps/backend/package.json needs no entry per instrument.
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
