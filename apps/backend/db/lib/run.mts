import { mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';

export interface ResolvedKnob {
  value: string;
  source: 'env' | 'default';
}

const knobs = new Map<string, ResolvedKnob>();

export function knob(name: string, fallback: string): string {
  const raw = process.env[name];
  const fromEnv = raw !== undefined && raw !== '';
  const value = fromEnv ? raw : fallback;
  knobs.set(name, { value, source: fromEnv ? 'env' : 'default' });
  return value;
}

function number(label: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    console.error(`${label} is not a number`);
    process.exit(1);
  }
  return value;
}

export const knobNumber = (name: string, fallback: number): number => {
  const raw = knob(name, String(fallback));
  return number(`${name}=${raw}`, raw);
};

export const knobList = (name: string, fallback: string): number[] => {
  const raw = knob(name, fallback);
  return raw
    .split(',')
    .map((part) => number(`${name}=${raw}: '${part.trim()}'`, part.trim()));
};

export const client = (user = process.env.POSTGRES_USER): pg.Client => {
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

export interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Plan Rows': number;
  'Actual Rows': number;
  'Actual Loops'?: number;
  'Shared Hit Blocks': number;
  'Shared Read Blocks': number;
  Plans?: PlanNode[];
}

export interface ExplainResult {
  Plan: PlanNode;
  'Execution Time': number;
  'Planning Time': number;
}

export const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

const transcript: string[] = [];
const realLog = console.log;
console.log = (...args: unknown[]) => {
  transcript.push(args.map(String).join(' '));
  realLog(...args);
};

export function header(title: string): void {
  console.log(title);
  for (const [name, k] of knobs) {
    console.log(
      `  ${name.padEnd(20)} ${(String(k.value) || '(none)').padEnd(28)} (${k.source})`,
    );
  }
  console.log('');
}

export type Arms = Record<string, string>;

export async function serverArms(
  api = process.env.BACKEND_INTERNAL_URL,
): Promise<Arms | null> {
  if (!api) return null;
  try {
    const response = await fetch(`${api}/info`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { arms?: Arms | null };
    return body.arms ?? null;
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

export function record(
  instrument: string,
  subcommand: string,
  { rows = null, arms = null }: { rows?: unknown; arms?: Arms | null },
): void {
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
