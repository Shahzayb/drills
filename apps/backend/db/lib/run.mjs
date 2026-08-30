// The four things every instrument in db/ needs, in one place: a knob reader
// that remembers whether the value arrived, the Postgres client, the median,
// and the run record.
//
// The point is the provenance. Drill 11's `INSERTS` knob was never forwarded by
// the root script, so the header printed the default back and the run read as a
// success. A knob now prints where its value came from:
//
//   org         150   (env)
//   pageSize     50   (default)
//
// A value you set in the shell showing `(default)` is the bug, visible before
// the run rather than after it. `pnpm check:arms` catches the same thing
// statically, and catches it without running anything.
//
// See plans/2026-08-30_instrument-hardening.md.

import { mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const knobs = new Map();

/**
 * Read one knob and remember where its value came from.
 *
 * `||` and not `??`: `docker compose exec -e ORG_ID` delivers an unset host
 * variable as the empty string rather than as absent, so `??` would keep the
 * empty string and every query would run for org ''. Drill 09 measured org 1
 * for a whole card that way.
 */
export function knob(name, fallback) {
  const raw = process.env[name];
  const fromEnv = raw !== undefined && raw !== '';
  const value = fromEnv ? raw : fallback;
  knobs.set(name, { value, source: fromEnv ? 'env' : 'default' });
  return value;
}

/**
 * A knob that has to be a number, or the run stops.
 *
 * `Number()` alone returns NaN for `100_000` — the spelling this file's own
 * callers use in their source — and for `50k` and every typo. The header would
 * then print `BENCH_ROWS  100_000  (env)`, which is the line that exists to say
 * the value arrived, above a run that measured nothing. A knob that reports
 * itself as delivered and is not is the whole subject of this module.
 */
function number(label, raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.error(`${label} is not a number`);
    process.exit(1);
  }
  return value;
}

/** `knob`, cast. The recorded value stays the string that arrived. */
export const knobNumber = (name, fallback) => {
  const raw = knob(name, String(fallback));
  return number(`${name}=${raw}`, raw);
};

/** `knob`, split on commas. For the depth and selectivity ladders. */
export const knobList = (name, fallback) => {
  const raw = knob(name, fallback);
  return raw
    .split(',')
    .map((part) => number(`${name}=${raw}: '${part.trim()}'`, part.trim()));
};

/**
 * The one Postgres client, built from the five variables env_file supplies.
 *
 * Missing credentials throw here rather than at connect time. pg reports an
 * absent password as `SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be
 * a string` from inside its auth code, and an absent user by quietly falling
 * back to the OS username. Neither names the variable that is missing.
 *
 * No 'postgres' default for the database: POSTGRES_DB is `drills` here, so that
 * fallback would connect to a real but wrong database and measure it — the
 * exact silent-default failure this file exists to stop.
 */
export const client = (user = process.env.POSTGRES_USER) => {
  const missing = ['POSTGRES_PASSWORD', 'POSTGRES_DB'].filter(
    (n) => !process.env[n],
  );
  if (!user) missing.unshift('POSTGRES_USER');
  if (missing.length) {
    throw new Error(
      `${missing.join(', ')} not set — db/ instruments run inside the ` +
        `container, where env_file supplies them: docker compose exec nest_server`,
    );
  }

  return new pg.Client({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DB,
  });
};

/** Median, not mean. One GC pause should not own the number. */
export const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

// Everything printed is also kept, so the run record carries the output that
// produced its numbers. console.table formats internally and calls log, so
// patching log alone catches it.
const transcript = [];
const realLog = console.log;
console.log = (...args) => {
  transcript.push(args.map(String).join(' '));
  realLog(...args);
};

/** Print the resolved knobs. Call it before the first measurement. */
export function header(title) {
  console.log(title);
  for (const [name, k] of knobs) {
    console.log(
      `  ${name.padEnd(20)} ${(String(k.value) || '(none)').padEnd(28)} (${k.source})`,
    );
  }
  console.log('');
}

/**
 * The arm state the server is actually running, read from GET /info.
 *
 * Not a second read of process.env: the endpoint reports the resolved module
 * constants the request path branches on, so a container started before the
 * variable changed disagrees with the shell and says so. Returns null when the
 * server is unreachable, which is the normal case for the instruments that talk
 * to Postgres directly.
 */
export async function serverArms(api = process.env.BACKEND_INTERNAL_URL) {
  if (!api) return null;
  try {
    const response = await fetch(`${api}/info`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    return (await response.json()).arms ?? null;
  } catch {
    return null;
  }
}

const pad = (n) => String(n).padStart(2, '0');

/**
 * Write the run to db/reports/, the same per-run directory scheme
 * k6/run-baseline.mjs already uses.
 *
 * A plan or a drill then cites a directory instead of retyping a number out of
 * scrollback with its conditions left behind — drill 08's README defect.
 *
 * Called after the last measurement. The `/info` fetch and the write must never
 * land inside a timed region.
 */
export function record(instrument, subcommand, { rows = null, arms = null }) {
  const d = new Date();
  const stamp =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

  const name = (process.env.NAME || '')
    .trim()
    .replace(/[^a-zA-Z0-9._]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const org = knobs.get('ORG_ID')?.value;
  const dir =
    `${stamp}${name ? `-${name}` : ''}-${instrument}-${subcommand}` +
    `${org ? `-org${org}` : ''}`;

  const url = new URL(`../reports/${dir}/`, import.meta.url);
  mkdirSync(url, { recursive: true });

  writeFileSync(
    new URL('run.json', url),
    JSON.stringify(
      {
        instrument,
        subcommand,
        name: name || null,
        at: d.toISOString(),
        // Stamped by the root script, because .git is not mounted into the
        // container. Absent when the instrument is run by hand from inside it.
        gitSha: process.env.GIT_SHA || null,
        knobs: Object.fromEntries(knobs),
        arms,
        rows,
      },
      null,
      2,
    ) + '\n',
  );

  writeFileSync(new URL('output.txt', url), transcript.join('\n') + '\n');

  realLog(`\napps/backend/db/reports/${dir}/`);
}
