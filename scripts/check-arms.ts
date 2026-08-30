// Fails when a knob cannot reach the code that reads it. `pnpm check:arms`
// from the repo root.
//
// Two questions, both of which have cost this repo a set of numbers:
//
//   1. Is every arm switch read in apps/backend/src forwarded by the
//      nest_server `environment:` list? A variable missing from that list is
//      not forwarded at all — `KEYSET_TIEBREAK=off docker compose up -d`
//      looks like it works and runs the default arm (drill 10).
//   2. Is every knob read in db/ forwarded by `docker compose exec -e` in the
//      root script that invokes it? Drill 09's ORG_ID and drill 11's INSERTS
//      were not, and both printed the default back as though they had arrived.
//
// Plus a name check: a knob may not be called TERM. Every interactive shell
// exports TERM as the terminal type, so `-e TERM` forwards 'xterm-256color'
// into the instrument (drill 11).
//
// Lives in scripts/ because it runs on the HOST: it reads docker-compose.yml,
// scripts/measure.ts and scripts/load.ts, none of which is mounted into the
// container. That is the split — scripts/ runs on your machine, and
// apps/backend/db/ and k6/ run in a container.
//
// It reads those files as TEXT, so every path and extension below is a literal
// the TypeScript conversion had to update in the same commit — `.mts` under
// apps/backend, `.ts` in k6 and scripts. See
// plans/2026-08-30_instrument-typescript.md.
//
// This does not go in check-tenancy.mts. That script answers whether the schema
// is protected, this one answers whether the harness is wired, and one checker
// with two subjects is harder to read than two with one each.
//
// Honest limit: it finds `process.env.X` reads in two directories. A knob read
// from anywhere else is invisible to it, the same limit check-tenancy.mts
// states about org_id. See plans/2026-08-30_instrument-hardening.md.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');

// This runs on the host, where nothing loads .env — Compose reads it itself, so
// BACKEND_PORT=4000 there publishes 4000 while plain Node still reads 3002 and
// reports the server down. The shell still wins over the file, so
// `BACKEND_PORT=4000 pnpm arms` overrides both.
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));

// -------------------------------------------------------------- live arms

/** The `arms` block of GET /info — the arms the API resolved at module load. */
interface Info {
  arms?: Record<string, string> | null;
}

// `pnpm arms` — what the running container is actually serving, as opposed to
// what the shell believes it asked for. The static check below proves a
// variable can arrive; this proves it did. A container started before the
// variable changed is the other half of drill 10's lost evening.
if (process.argv[2] === 'live') {
  const api = `http://localhost:${process.env.BACKEND_PORT || 3002}`;
  const response = await fetch(`${api}/info`).catch(() => null);

  if (!response?.ok) {
    console.error(`no answer from ${api}/info — is nest_server up?`);
    process.exit(1);
  }

  // Whatever is on that port may not be nest_server at all. An unguarded
  // .json() turns "a dev server answers here" into a SyntaxError stack from the
  // one command whose job is saying what is answering.
  const body = (await response.json().catch(() => null)) as Info | null;
  if (!body) {
    console.error(
      `${api}/info did not answer with JSON — is that nest_server?`,
    );
    process.exit(1);
  }
  const { arms } = body;

  // The container answering is older than the code that reports arms, which is
  // the exact situation this command exists to surface. It is also the first
  // thing that happened when this was run against a live stack.
  if (!arms) {
    console.error(
      `${api}/info answered without an arms block — nest_server is running ` +
        `code older than src/info/info.controller.ts.\n\n` +
        `  docker compose up -d --force-recreate nest_server\n`,
    );
    process.exit(1);
  }

  console.log(`${api}  (resolved at module load, not re-read per request)\n`);
  for (const [name, value] of Object.entries(arms)) {
    console.log(`  ${name.padEnd(18)} ${value}`);
  }
  process.exit(0);
}

// Supplied by `env_file: .env` on every service, so they need no -e flag and no
// entry in the environment list. Connection details, never an A/B arm.
const INFRA = /^(POSTGRES_|REDIS_)/;
const INFRA_NAMES = new Set([
  'PORT',
  'NODE_ENV',
  'BACKEND_INTERNAL_URL',
  'BACKEND_PORT',
  'FRONTEND_PORT',
]);

// Names the shell already owns. TERM is the one that has actually bitten.
const RESERVED = new Set([
  'TERM',
  'PATH',
  'HOME',
  'USER',
  'SHELL',
  'LANG',
  'PWD',
  'EDITOR',
  'PAGER',
  'LOGNAME',
  'TMPDIR',
]);

// Written by lib/run.mts rather than by the instrument, so every instrument
// that imports it needs both forwarded.
const RUN_RECORD_KNOBS = ['NAME', 'GIT_SHA'];

const isInfra = (name: string) => INFRA.test(name) || INFRA_NAMES.has(name);

const failures: string[] = [];

/**
 * Every knob a file reads, deduplicated.
 *
 * Three spellings — `process.env.X` on the host, `__ENV.X` in k6, and the db
 * instruments' `knob('X', …)`. The last is not optional: converting the
 * instruments to `knob('ORG_ID', '1')` made every db knob invisible to a
 * scanner that only knew `process.env.X`, and this check went green while
 * checking nothing. The red runs in the plan's verification section are what
 * caught it, which is the drill 08 lesson one level up — a check needs a test
 * that fails when it stops checking.
 */
function envReads(source: string): string[] {
  const names = new Set<string>();
  const pattern =
    /(?:process\.env\.|__ENV\.|\bknob(?:Number|List)?\(\s*')([A-Z][A-Z0-9_]*)/g;
  for (const m of source.matchAll(pattern)) names.add(m[1]);
  return [...names];
}

function walk(dir: string, extension: string, files: string[] = []): string[] {
  for (const entry of readdirSync(join(root, dir))) {
    const path = join(dir, entry);
    if (statSync(join(root, path)).isDirectory()) walk(path, extension, files);
    else if (entry.endsWith(extension)) files.push(path);
  }
  return files;
}

// -------------------------------------------------------- 1. the app's arms

// The nest_server block only — every other service forwards its own subset, and
// the arms this checks are all read by the API.
//
// Ends at the next service key rather than at a named one: keying on
// `next_app:` meant renaming that service silently widened this to every
// service below nest_server, and a variable forwarded to the collector would
// have passed as forwarded to the API.
const compose = read('docker-compose.yml');
const nestStart = compose.indexOf('\n  nest_server:');
if (nestStart === -1) {
  console.error('docker-compose.yml has no nest_server service');
  process.exit(1);
}
const after = compose.slice(nestStart + 1);
const nextService = after.slice(1).search(/^ {2}\S/m);
const nestBlock = nextService === -1 ? after : after.slice(0, nextService + 1);
const forwardedToNest = new Set(
  [...nestBlock.matchAll(/^ +- ([A-Z][A-Z0-9_]*)=\$\{/gm)].map((m) => m[1]),
);

for (const file of walk('apps/backend/src', '.ts')) {
  if (file.includes('.spec.')) continue;
  for (const name of envReads(read(file))) {
    if (isInfra(name)) continue;
    if (RESERVED.has(name)) {
      failures.push(`${file} reads ${name}, which the shell already owns`);
      continue;
    }
    if (!forwardedToNest.has(name)) {
      failures.push(
        `${file} reads ${name}, missing from the nest_server environment: list ` +
          `in docker-compose.yml — setting it in the shell does nothing`,
      );
    }
  }
}

// -------------------------------------------- 2. the instruments' own knobs

// scripts/measure.ts declares every knob once and generates the -e flags from
// that declaration, so "someone forgot a flag" is no longer reachable. What is
// still reachable is the declaration disagreeing with the code: a knob the
// instrument reads that the catalog never sends, and a catalog entry no
// instrument reads. Both directions are checked.
const catalog = read('scripts/measure.ts');

/** Every `env:` name the catalog declares for one instrument file. */
function catalogFor(file: string): Set<string> | null {
  const entry = catalog.indexOf(`file: '${file}'`);
  if (entry === -1) return null;

  // From this instrument's `file:` to the next one, so knobs are not read out
  // of a neighbouring block.
  const next = catalog.indexOf("file: 'db/", entry + 1);
  const block = catalog.slice(entry, next === -1 ? undefined : next);
  return new Set(
    [...block.matchAll(/env: '([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]),
  );
}

// Forwarded for every instrument rather than per block: NAME through the
// catalog's COMMON list, GIT_SHA computed by the runner itself. Matched by name
// anywhere in the file, the same crude test check 3 uses on the k6 runner — it
// catches a rename that half-lands, not a name that is mentioned and unused.
const common = new Set(
  RUN_RECORD_KNOBS.filter((n) => new RegExp(`\\b${n}\\b`).test(catalog)),
);

for (const path of walk('apps/backend/db', '.mts')) {
  // lib/ is shared, so its knobs are charged to the files that import it.
  if (path.includes('/lib/')) continue;

  const file = path.replace('apps/backend/', '');
  const source = read(path);
  const required = envReads(source).filter((n) => !isInfra(n));

  // Only the files that write a run record — importing lib/run.mts for the
  // client alone needs neither.
  if (source.includes('record(')) required.push(...RUN_RECORD_KNOBS);

  for (const name of required) {
    if (RESERVED.has(name)) {
      failures.push(`${file} reads ${name}, which the shell already owns`);
    }
  }

  const declared = catalogFor(file);

  // seed.mts, stats.mts and check-tenancy.mts are run by other scripts and read
  // no knobs of their own; an instrument that reads one must be in the catalog.
  if (!declared) {
    if (required.length) {
      failures.push(
        `${file} reads ${required.join(', ')} but scripts/measure.ts has no ` +
          `catalog entry for it — nothing forwards them`,
      );
    }
    continue;
  }

  for (const name of required) {
    if (RESERVED.has(name)) continue;
    if (!declared.has(name) && !common.has(name)) {
      failures.push(
        `${file} reads ${name}, which scripts/measure.ts does not declare ` +
          `— setting it in the shell does nothing`,
      );
    }
  }

  for (const name of declared) {
    if (!envReads(source).includes(name)) {
      failures.push(
        `scripts/measure.ts declares ${name} for ${file}, which does not read ` +
          `it — a flag that does nothing`,
      );
    }
  }
}

// ------------------------------------------------------ 3. the k6 scripts

// k6 reads its knobs from __ENV, and scripts/load.ts decides which ones cross
// into the container. A script reading a name the runner does not forward gets
// the script's own default, silently, exactly like the two cases above.
//
// Crude on purpose: it asks whether the name appears anywhere in the runner,
// not whether it reaches the env object. A rename that half-lands is the case
// it catches, and that is the case that has happened.
const loader = read('scripts/load.ts');

// k6/lib/scenario.ts is where every knob is actually read since the two scripts
// were reduced to a URL and a summary line, so lib/ is scanned rather than
// skipped — the opposite of db/lib/, whose knobs belong to their importers.
// reports/ is skipped because it is ~60 directories of recorded output.
const k6Files = walk('k6', '.ts').filter((f) => !f.includes('/reports/'));

// Every default a k6 script writes for itself, by knob name.
const k6Defaults = new Map<string, { value: string; path: string }>();

for (const path of k6Files) {
  const source = read(path);

  for (const name of envReads(source)) {
    // Set by the runner itself rather than by the operator.
    if (name === 'SUMMARY_OUT') continue;
    if (RESERVED.has(name)) {
      failures.push(`${path} reads ${name}, which the shell already owns`);
      continue;
    }
    if (!new RegExp(`\\b${name}\\b`).test(loader)) {
      failures.push(
        `${path} reads __ENV.${name}, which scripts/load.ts does not ` +
          `forward — setting it in the shell does nothing`,
      );
    }
  }

  for (const [, name, value] of source.matchAll(
    /__ENV\.([A-Z][A-Z0-9_]*)\s*\|\|\s*'([^']*)'/g,
  )) {
    k6Defaults.set(name, { value, path });
  }
}

// The one place a default is written twice on purpose: the catalog has to know
// it to build the report directory name, and the script has to know it to be
// runnable by hand. Two copies that disagree means a hand-run and a `pnpm load`
// run measure different things and both look right.
//
// Driven from the catalog's declarations rather than the script's reads, so
// EVERY declaration is compared. PAGE_SIZE is declared under both scripts, and
// looking the name up once in the file only ever checked the first of them —
// the same trap check 2 avoids by slicing per block in catalogFor().
for (const [, name, declared] of loader.matchAll(
  /env: '([A-Z][A-Z0-9_]*)',\s*def: '([^']*)'/g,
)) {
  const script = k6Defaults.get(name);
  if (script && script.value !== declared) {
    failures.push(
      `${script.path} defaults ${name} to '${script.value}' but ` +
        `scripts/load.ts declares '${declared}' — a hand-run and ` +
        `\`pnpm load\` would measure different things`,
    );
  }
}

// ------------------------------------------------------------------ verdict

if (failures.length) {
  console.error(`check:arms — ${failures.length} problem(s)\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error('');
  process.exit(1);
}

console.log('check:arms — every knob reaches the code that reads it');
