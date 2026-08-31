import { faker } from '@faker-js/faker';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { from as copyFrom } from 'pg-copy-streams';
import { createCorpus, mulberry32, phaseFor } from './lib/corpus.mts';
import type { ExplainResult, PlanNode } from './lib/run.mts';
import {
  client as pgClient,
  header,
  knob,
  knobNumber,
  record,
} from './lib/run.mts';

const MODES = ['plans', 'indexes', 'gaps', 'writes'];
const mode = process.argv[2];

if (!MODES.includes(mode)) {
  console.error(`usage: node db/search.mts <${MODES.join('|')}>`);
  process.exit(1);
}

const APP_USER = process.env.POSTGRES_APP_USER;

if (!APP_USER) {
  console.error('POSTGRES_APP_USER must be set');
  process.exit(1);
}

const ORG_ID = knob('ORG_ID', '1');
const ROUNDS = knobNumber('ROUNDS', 5);
const LIMIT = knobNumber('LIMIT', 20);
const MWM = knob('MAINTENANCE_WORK_MEM', '512MB');
const ONLY = knob('ONLY', '');
const ROWS = knobNumber('ROWS', 50000);
const INSERTS = knobNumber('INSERTS', 2000);
const INDEX_NAME = 'messages_org_tsv_idx';

if (ROUNDS < 1) {
  console.error('ROUNDS must be at least 1');
  process.exit(1);
}

const SEARCH_TERM = knob('SEARCH_TERM', '');
const TERMS = SEARCH_TERM ? [SEARCH_TERM] : ['export', 'ERR_2452'];

const client = pgClient();

const likeQuery = `
  SELECT m.id, m.conversation_id, m.created_at, m.message
    FROM messages m
   WHERE m.org_id = $1 AND m.message ILIKE '%' || $2 || '%'
   ORDER BY m.created_at DESC, m.id DESC
   LIMIT ${LIMIT}`;

const ftsQuery = `
  SELECT m.id, m.conversation_id, m.created_at, m.message
    FROM messages m
   WHERE m.org_id = $1 AND m.tsv @@ websearch_to_tsquery('english', $2)
   ORDER BY m.created_at DESC, m.id DESC
   LIMIT ${LIMIT}`;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

function bars(rows: { label: string; ms: number }[]) {
  const max = Math.max(...rows.map((r) => Math.log10(Math.max(r.ms, 0.01))));
  const min = Math.log10(0.1);
  console.log('\n  log10 scale — each block is roughly a factor of 1.3\n');
  for (const row of rows) {
    const scaled = (Math.log10(Math.max(row.ms, 0.01)) - min) / (max - min);
    const width = Math.max(1, Math.round(scaled * 46));
    console.log(
      `  ${row.label.padEnd(26)} ${'█'.repeat(width).padEnd(48)}` +
        `${row.ms.toFixed(2).padStart(10)} ms`,
    );
  }
}

const rule = (label: string) =>
  console.log(`\n--- ${label} ${'-'.repeat(Math.max(0, 68 - label.length))}`);

function findScan(node: PlanNode): PlanNode | null {
  if (node['Relation Name'] === 'messages') return node;
  for (const child of node.Plans ?? []) {
    const found = findScan(child);
    if (found) return found;
  }
  return null;
}

async function explainJson(
  sql: string,
  params: unknown[],
): Promise<ExplainResult> {
  const { rows } = await client.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    params,
  );
  return rows[0]['QUERY PLAN'][0] as ExplainResult;
}

async function explainText(label: string, sql: string, params?: unknown[]) {
  const { rows } = await client.query(
    `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
    params,
  );
  rule(label);
  for (const row of rows) console.log(row['QUERY PLAN']);
}

async function timed(sql: string, params: unknown[]) {
  const samples: number[] = [];
  for (let k = 0; k <= ROUNDS; k++) {
    const started = process.hrtime.bigint();
    await client.query(sql, params);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (k > 0) samples.push(ms);
  }
  return median(samples);
}

async function scalar(sql: string, params?: unknown[]): Promise<unknown> {
  const { rows } = await client.query(sql, params);
  return Object.values(rows[0])[0];
}

async function openScope() {
  await client.query('BEGIN');
  await client.query(`SET LOCAL ROLE ${APP_USER}`);
  await client.query('SELECT set_config($1, $2, true)', ['app.org_id', ORG_ID]);
}

async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  await client.query('SET LOCAL ROLE NONE');
  try {
    return await fn();
  } finally {
    await client.query(`SET LOCAL ROLE ${APP_USER}`);
  }
}

async function withoutIndex(fn: () => Promise<unknown>) {
  await client.query('SAVEPOINT no_index');
  try {
    await asOwner(async () => {
      await client.query(`SET LOCAL lock_timeout = '5s'`);
      await client.query(`DROP INDEX ${INDEX_NAME}`);
    });
    await fn();
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT no_index');
  }
}

async function notLeakproof(fn: () => Promise<unknown>) {
  await client.query('SAVEPOINT leaky');
  try {
    await asOwner(() =>
      client.query(
        'ALTER FUNCTION ts_match_vq(tsvector, tsquery) NOT LEAKPROOF',
      ),
    );
    await fn();
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT leaky');
  }
}

interface TrialIndex {
  buildMs: number;
  bytes: number;
  pretty: string;
}

async function withIndex(
  name: string,
  definition: string,
  fn: (index: TrialIndex) => Promise<void>,
) {
  await client.query('SAVEPOINT trial');
  try {
    const started = process.hrtime.bigint();
    await asOwner(async () => {
      await client.query(`CREATE INDEX ${name} ON messages ${definition}`);
    });
    const buildMs = Number(process.hrtime.bigint() - started) / 1e6;
    const bytes = Number(
      await scalar(`SELECT pg_relation_size($1::regclass)`, [name]),
    );
    const pretty = String(
      await scalar(`SELECT pg_size_pretty(pg_relation_size($1::regclass))`, [
        name,
      ]),
    );
    await fn({ buildMs, bytes, pretty });
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT trial');
  }
}

async function plans() {
  await openScope();

  const present = await scalar(
    `SELECT count(*) FROM pg_class WHERE relname = $1`,
    [INDEX_NAME],
  );
  const orgRows = Number(
    await scalar('SELECT count(*) FROM messages WHERE org_id = $1', [ORG_ID]),
  );

  console.log(`org ${ORG_ID}  ${orgRows.toLocaleString()} messages`);
  console.log(`${INDEX_NAME}: ${Number(present) ? 'present' : 'ABSENT'}`);
  console.log(`limit ${LIMIT}  rounds ${ROUNDS} (first discarded)\n`);
  console.log(
    '  term            arm                scan node                       ' +
      'matches    median ms   hit/read',
  );

  const chart: { label: string; ms: number }[] = [];

  for (const term of TERMS) {
    const counted = (predicate: string) =>
      scalar(
        `SELECT count(*) FROM messages WHERE org_id = $1 AND ${predicate}`,
        [ORG_ID, term],
      ).then(Number);

    const matched = {
      like: await counted(`message ILIKE '%' || $2 || '%'`),
      fts: await counted(`tsv @@ websearch_to_tsquery('english', $2)`),
    };

    const print = async (arm: string, sql: string, matches: number) => {
      const plan = await explainJson(sql, [ORG_ID, term]);
      const scan = findScan(plan.Plan) ?? plan.Plan;
      const ms = await timed(sql, [ORG_ID, term]);
      console.log(
        `  ${term.padEnd(15)} ${arm.padEnd(18)} ${scan['Node Type'].padEnd(31)}` +
          `${matches.toLocaleString().padStart(9)}  ${ms.toFixed(2).padStart(10)}   ` +
          `${scan['Shared Hit Blocks']}/${scan['Shared Read Blocks']}`,
      );
      return ms;
    };

    const row = async (arm: 'like' | 'fts', sql: string) => {
      const ms = await print(arm, sql, matched[arm]);
      chart.push({ label: `${term} ${arm}`, ms });
    };

    await row('like', likeQuery);
    await row('fts', ftsQuery);

    const control = (arm: string) => print(arm, ftsQuery, matched.fts);

    await notLeakproof(() => control('fts, not leakproof'));
    await withoutIndex(() => control('fts, no gin'));
  }

  bars(chart);

  await explainText(`like — ${TERMS[0]}`, likeQuery, [ORG_ID, TERMS[0]]);
  await explainText(`fts — ${TERMS[0]}`, ftsQuery, [ORG_ID, TERMS[0]]);
  if (TERMS.length > 1) {
    await explainText(`fts — ${TERMS[1]}`, ftsQuery, [ORG_ID, TERMS[1]]);
  }

  await client.query('COMMIT');
}

async function indexes() {
  console.log(
    '\n  Takes ACCESS EXCLUSIVE on messages for the length of each build.\n' +
      '  Every other session blocks on it — do not run this beside k6.\n',
  );

  await openScope();

  const setMwm = () =>
    asOwner(() => client.query(`SET LOCAL maintenance_work_mem = '${MWM}'`));
  await setMwm();

  const heap = Number(await scalar(`SELECT pg_relation_size('messages')`));
  const tsvBytes = Number(
    await scalar(
      `SELECT sum(pg_column_size(tsv))::bigint * (SELECT reltuples FROM pg_class WHERE relname = 'messages')::bigint / count(*)
         FROM (SELECT tsv FROM messages LIMIT 100000) s`,
    ),
  );

  console.log(`maintenance_work_mem = ${MWM}   (plain CREATE INDEX, in a`);
  console.log(`rolled-back transaction — the migration used CONCURRENTLY)\n`);
  console.log(`messages heap ${(heap / 1024 ** 2).toFixed(0)} MB`);
  console.log(
    `  of which the stored tsvector column is roughly ` +
      `${(tsvBytes / 1024 ** 2).toFixed(0)} MB\n`,
  );

  await client.query('ROLLBACK');

  const term = TERMS[0];
  const candidates: [
    label: string,
    name: string,
    definition: string,
    probe: string,
  ][] = [
    ['gin (org_id, tsv)', 'trial_gin_org_tsv', 'USING gin (org_id, tsv)', ftsQuery], // prettier-ignore
    ['gin (tsv)', 'trial_gin_tsv', 'USING gin (tsv)', ftsQuery],
    ['btree (message)', 'trial_btree_msg', '(message)', likeQuery],
    ['btree (message text_pattern_ops)', 'trial_btree_pat', '(message text_pattern_ops)', likeQuery], // prettier-ignore
    ['gin (message gin_trgm_ops)', 'trial_gin_trgm', 'USING gin (message gin_trgm_ops)', likeQuery], // prettier-ignore
  ];

  console.log(
    '  candidate                          build s      size   ' +
      'scan node on messages           median ms',
  );

  for (const [label, name, definition, probe] of candidates) {
    if (ONLY && !label.includes(ONLY)) continue;

    await openScope();
    await setMwm();
    if (definition.includes('gin_trgm_ops')) {
      await asOwner(() =>
        client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm'),
      );
    }

    await withoutIndex(() =>
      withIndex(name, definition, async ({ buildMs, pretty }) => {
        const plan = await explainJson(probe, [ORG_ID, term]);
        const scan = findScan(plan.Plan) ?? plan.Plan;
        const ms = await timed(probe, [ORG_ID, term]);
        console.log(
          `  ${label.padEnd(34)} ${(buildMs / 1000).toFixed(1).padStart(7)}  ` +
            `${pretty.padStart(8)}   ${scan['Node Type'].padEnd(31)} ` +
            `${ms.toFixed(2).padStart(9)}`,
        );
      }),
    );

    await client.query('ROLLBACK');
  }

  if (!ONLY) {
    await openScope();
    await setMwm();
  }

  if (!ONLY)
    await withoutIndex(async () => {
      const counted = (pattern: string) =>
        `SELECT count(*) FROM messages WHERE org_id = $1 AND message LIKE ${pattern}`;

      await withIndex(
        'trial_btree_pat',
        '(message text_pattern_ops)',
        async ({ pretty }) => {
          rule(
            `btree (message text_pattern_ops), ${pretty} — no RLS, as owner`,
          );
          await asOwner(async () => {
            await explainText(
              `LIKE 'Thanks%'  — a prefix names a subtree`,
              counted(`$2 || '%'`),
              [ORG_ID, 'Thanks'],
            );
            await explainText(
              `LIKE '%Thanks%' — a leading wildcard names nothing`,
              counted(`'%' || $2 || '%'`),
              [ORG_ID, 'Thanks'],
            );
          });
        },
      );

      await asOwner(() =>
        client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm'),
      );
      await withIndex(
        'trial_gin_trgm',
        'USING gin (message gin_trgm_ops)',
        async ({ pretty }) => {
          rule(`gin (message gin_trgm_ops), ${pretty} — no RLS, as owner`);
          await asOwner(() =>
            explainText(
              `LIKE '%xport%' — the query FTS answers with 0 rows`,
              counted(`'%' || $2 || '%'`),
              [ORG_ID, 'xport'],
            ),
          );
        },
      );
    });

  await client.query('ROLLBACK');
}

async function gaps() {
  await openScope();

  const cases = [
    ['ERR_24', 'fragment of an error code', 'closable with :*'],
    ['expor', 'mid-typing, a prefix of a word', 'closable with :*'],
    ['xport', 'the INTERIOR of "export"', 'FTS WORSE — no fix'],
    ['fund', 'the interior of "refunded"', 'FTS WORSE — no fix'],
    ['GGY', 'alphabetic half of a ticket ref', 'FTS BETTER — see below'],
    ['refunds', 'a plural the corpus never writes', 'FTS BETTER'],
    ['csv export', 'two words', 'agree'],
    ['"csv export"', 'the same two as a phrase', 'agree'],
  ];

  console.log(`org ${ORG_ID}\n`);
  console.log(
    '  input           like rows    fts rows   verdict                tsquery',
  );

  for (const [input, note, verdict] of cases) {
    const likeRows = Number(
      await scalar(
        `SELECT count(*) FROM messages WHERE org_id = $1 AND message ILIKE '%' || $2 || '%'`,
        [ORG_ID, input.replaceAll('"', '')],
      ),
    );
    const ftsRows = Number(
      await scalar(
        `SELECT count(*) FROM messages WHERE org_id = $1 AND tsv @@ websearch_to_tsquery('english', $2)`,
        [ORG_ID, input],
      ),
    );
    const tsquery = await scalar(
      `SELECT websearch_to_tsquery('english', $1)::text`,
      [input],
    );
    console.log(
      `  ${input.padEnd(15)} ${likeRows.toLocaleString().padStart(9)}   ` +
        `${ftsRows.toLocaleString().padStart(9)}   ${verdict.padEnd(22)} ${tsquery}`,
    );
    console.log(`  ${''.padEnd(15)} ${note}`);
  }

  rule(':* closes the prefix gap and does nothing for the interior one');
  for (const input of ['expor', 'ERR_24', 'xport', 'fund']) {
    const rows = Number(
      await scalar(
        `SELECT count(*) FROM messages WHERE org_id = $1 AND tsv @@ to_tsquery('english', $2 || ':*')`,
        [ORG_ID, input.toLowerCase()],
      ),
    );
    console.log(`  ${input.padEnd(15)} with :*  ${rows.toLocaleString()} rows`);
  }

  rule('why LIKE returns more rows for GGY, and why that is not a win');
  const { rows: ggy } = await client.query(
    `SELECT substring(message from '[A-Za-z]*[Gg][Gg][Yy][A-Za-z0-9-]*') AS matched,
            count(*)::int AS rows
       FROM messages WHERE org_id = $1 AND message ILIKE '%ggy%'
      GROUP BY 1 ORDER BY 2 DESC`,
    [ORG_ID],
  );
  for (const r of ggy) {
    console.log(`  ${String(r.matched).padEnd(15)} ${r.rows.toLocaleString().padStart(9)} rows`); // prettier-ignore
  }

  rule('what the parser stores');
  console.log(
    await scalar(
      `SELECT to_tsvector('english', 'Logged as GGY-5178. Usage alerts returns ERR_2452 and the CSV export refunded twice.')::text`,
    ),
  );

  await client.query('COMMIT');
}

async function writes() {
  await client.query('BEGIN');

  const { rows: convs } = await client.query(
    `SELECT DISTINCT c.id FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.org_id = $1 LIMIT 1000`,
    [ORG_ID],
  );
  const ids = convs.map((r) => r.id);

  faker.seed(11);
  const corpus = createCorpus(faker, mulberry32(11));
  const bodies = Array.from({ length: 5000 }, (_, k) =>
    corpus.body(phaseFor(k % 12, 12, false)),
  );

  function* lines() {
    for (let k = 0; k < ROWS; k++) {
      const body = bodies[k % bodies.length].replaceAll('\\', '\\\\');
      yield `${ids[k % ids.length]}\t${ORG_ID}\t${body}\t2026-08-12T00:00:00Z\t2026-08-12T00:00:00Z\n`;
    }
  }

  const indexBytes = () =>
    scalar(`SELECT coalesce(pg_relation_size(to_regclass($1)), 0)::bigint`, [
      INDEX_NAME,
    ]).then(Number);

  const copy = async () => {
    const before = await indexBytes();
    const started = process.hrtime.bigint();
    await pipeline(
      Readable.from(lines()),
      client.query(
        copyFrom(
          'COPY messages (conversation_id, org_id, message, created_at, updated_at) FROM STDIN',
        ),
      ),
    );
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    return { rate: ROWS / seconds, grew: (await indexBytes()) - before };
  };

  const inserts = async () => {
    const started = process.hrtime.bigint();
    for (let k = 0; k < INSERTS; k++) {
      await client.query(
        `INSERT INTO messages (conversation_id, org_id, message, created_at, updated_at)
         VALUES ($1, $2, $3, now(), now())`,
        [ids[k % ids.length], ORG_ID, bodies[k % bodies.length]],
      );
    }
    return INSERTS / (Number(process.hrtime.bigint() - started) / 1e9);
  };

  console.log(
    `org ${ORG_ID}   ${ROWS.toLocaleString()} rows per COPY, ` +
      `${INSERTS.toLocaleString()} single-row INSERTs, ${ROUNDS} rounds\n`,
  );
  console.log(`  gin_pending_list_limit = ${await scalar('SHOW gin_pending_list_limit')}`); // prettier-ignore
  console.log(
    `  fastupdate             = ${await scalar(`SELECT coalesce((SELECT option_value FROM pg_options_to_table((SELECT reloptions FROM pg_class WHERE relname = $1)) WHERE option_name = 'fastupdate'), 'on (default)')`, [INDEX_NAME])}\n`,
  );

  const samples: Record<string, number[]> = {
    copyWith: [],
    copyWithout: [],
    insWith: [],
    insWithout: [],
  };
  let grewWith = 0;
  let cleaned: { pages: number; ms: number } | null = null;

  for (let round = 0; round < ROUNDS; round++) {
    await client.query('SAVEPOINT arm');
    const withGin = await copy();
    samples.copyWith.push(withGin.rate);
    grewWith = withGin.grew;
    samples.insWith.push(await inserts());
    if (cleaned === null) {
      const started = process.hrtime.bigint();
      const pages = Number(
        await scalar(`SELECT gin_clean_pending_list($1::regclass)`, [
          INDEX_NAME,
        ]),
      );
      cleaned = { pages, ms: Number(process.hrtime.bigint() - started) / 1e6 };
    }
    await client.query('ROLLBACK TO SAVEPOINT arm');

    await client.query('SAVEPOINT arm');
    await client.query(`DROP INDEX ${INDEX_NAME}`);
    samples.copyWithout.push((await copy()).rate);
    samples.insWithout.push(await inserts());
    await client.query('ROLLBACK TO SAVEPOINT arm');
  }

  const row = (label: string, values: number[]) =>
    console.log(
      `  ${label.padEnd(24)} ${median(values).toFixed(0).padStart(8)} rows/s   ` +
        `(${values.map((v) => v.toFixed(0)).join(', ')})`,
    );

  row('COPY, gin present', samples.copyWith);
  row('COPY, gin dropped', samples.copyWithout);
  row('INSERT, gin present', samples.insWith);
  row('INSERT, gin dropped', samples.insWithout);

  const ratio = (a: number[], b: number[]) =>
    (median(b) / median(a)).toFixed(2);
  console.log(
    `\n  COPY   ${ratio(samples.copyWith, samples.copyWithout)}x faster without the GIN index` +
      `   (index grew ${(grewWith / 1024 ** 2).toFixed(1)} MB per ${ROWS.toLocaleString()} rows)`,
  );
  console.log(
    `  INSERT ${ratio(samples.insWith, samples.insWithout)}x faster without the GIN index`,
  );

  const tsStarted = process.hrtime.bigint();
  await client.query(
    `SELECT count(to_tsvector('english', message))
       FROM (SELECT message FROM messages WHERE org_id = $1 LIMIT $2) s`,
    [ORG_ID, ROWS],
  );
  console.log(
    `\n  to_tsvector over ${ROWS.toLocaleString()} bodies: ` +
      `${(Number(process.hrtime.bigint() - tsStarted) / 1e6).toFixed(0)} ms ` +
      `— paid by BOTH arms, because the column is generated`,
  );
  if (cleaned) {
    console.log(
      `  gin_clean_pending_list: ${cleaned.pages.toLocaleString()} pages in ` +
        `${cleaned.ms.toFixed(0)} ms — work one COPY deferred`,
    );
  }

  await client.query('ROLLBACK');
}

header(`search ${mode}`);

await client.connect();
try {
  if (mode === 'plans') await plans();
  else if (mode === 'indexes') await indexes();
  else if (mode === 'gaps') await gaps();
  else await writes();
} finally {
  await client.end();
}

record('search', mode, {});
