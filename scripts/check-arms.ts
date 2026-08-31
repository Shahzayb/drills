import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');

if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));

interface Info {
  arms?: Record<string, string> | null;
}

if (process.argv[2] === 'live') {
  const api = `http://localhost:${process.env.BACKEND_PORT || 3002}`;
  const response = await fetch(`${api}/info`).catch(() => null);

  if (!response?.ok) {
    console.error(`no answer from ${api}/info — is nest_server up?`);
    process.exit(1);
  }

  const body = (await response.json().catch(() => null)) as Info | null;
  if (!body) {
    console.error(
      `${api}/info did not answer with JSON — is that nest_server?`,
    );
    process.exit(1);
  }
  const { arms } = body;

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

const INFRA = /^(POSTGRES_|REDIS_)/;
const INFRA_NAMES = new Set([
  'PORT',
  'NODE_ENV',
  'BACKEND_INTERNAL_URL',
  'BACKEND_PORT',
  'FRONTEND_PORT',
]);

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

const RUN_RECORD_KNOBS = ['NAME', 'GIT_SHA'];

const isInfra = (name: string) => INFRA.test(name) || INFRA_NAMES.has(name);

const failures: string[] = [];

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

const catalog = read('scripts/measure.ts');

function catalogFor(file: string): Set<string> | null {
  const entry = catalog.indexOf(`file: '${file}'`);
  if (entry === -1) return null;

  const next = catalog.indexOf("file: 'db/", entry + 1);
  const block = catalog.slice(entry, next === -1 ? undefined : next);
  return new Set(
    [...block.matchAll(/env: '([A-Z][A-Z0-9_]*)'/g)].map((m) => m[1]),
  );
}

const common = new Set(
  RUN_RECORD_KNOBS.filter((n) => new RegExp(`\\b${n}\\b`).test(catalog)),
);

for (const path of walk('apps/backend/db', '.mts')) {
  if (path.includes('/lib/')) continue;

  const file = path.replace('apps/backend/', '');
  const source = read(path);
  const required = envReads(source).filter((n) => !isInfra(n));

  if (source.includes('record(')) required.push(...RUN_RECORD_KNOBS);

  for (const name of required) {
    if (RESERVED.has(name)) {
      failures.push(`${file} reads ${name}, which the shell already owns`);
    }
  }

  const declared = catalogFor(file);

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

const loader = read('scripts/load.ts');

const k6Files = walk('k6', '.ts').filter((f) => !f.includes('/reports/'));

const k6Defaults = new Map<string, { value: string; path: string }>();

for (const path of k6Files) {
  const source = read(path);

  for (const name of envReads(source)) {
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

if (failures.length) {
  console.error(`check:arms — ${failures.length} problem(s)\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error('');
  process.exit(1);
}

console.log('check:arms — every knob reaches the code that reads it');
