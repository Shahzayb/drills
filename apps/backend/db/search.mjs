// Card 11's instrument: LIKE '%term%' against a tsvector + GIN index, and the
// price of every index that could have served the search box instead.
//
//   pnpm db:search plans     EXPLAIN (ANALYZE, BUFFERS) both arms, both terms
//   pnpm db:search indexes   build time + on-disk size for five candidates
//   pnpm db:search gaps      the inputs where FTS answers worse than LIKE
//   pnpm db:search writes    stretch: what the GIN costs on the way in
//
// Same two load-bearing choices as db/explain.mjs, for the same reasons: it
// connects as the owner and drops into the app role inside a transaction, so
// every plan carries the RLS predicate the application runs with; and every
// query goes through bind parameters, because that is how the service sends
// them and a one-shot unnamed statement always gets a custom plan.
//
// Knobs (forwarded by the root script with `docker compose exec -e`, without
// which they silently do nothing):
//
//   ORG_ID=150   the tail org — several of these numbers invert there
//   TERM=refund  a single term instead of the default ladder
//   ROUNDS=5     timed repetitions per cell, median reported
//   LIMIT=20     page size
//
// Full reasoning and the captured output:
// plans/2026-08-29_drill-11-full-text-search.md.

import pg from 'pg';
import { faker } from '@faker-js/faker';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { from as copyFrom } from 'pg-copy-streams';
import { createCorpus, mulberry32, phaseFor } from './lib/corpus.mjs';

const MODES = ['plans', 'indexes', 'gaps', 'writes'];
const mode = process.argv[2];

if (!MODES.includes(mode)) {
  console.error(`usage: node db/search.mjs <${MODES.join('|')}>`);
  process.exit(1);
}

const APP_USER = process.env.POSTGRES_APP_USER;

if (!APP_USER) {
  console.error('POSTGRES_APP_USER must be set');
  process.exit(1);
}

// `||` rather than `??`: `docker compose exec -e ORG_ID` delivers an unset host
// variable as the empty string, not as absent. Drill 09's ORG_ID knob measured
// org 1 for a whole card because of it.
const ORG_ID = process.env.ORG_ID || '1';
const ROUNDS = Number(process.env.ROUNDS || 5);
const LIMIT = Number(process.env.LIMIT || 20);
const INDEX_NAME = 'messages_org_tsv_idx';

// A selectivity ladder, not one term. `export` is 4.1% of the whale org and
// `ERR_2452` is 0.045%, and the two answer the question "is FTS fast?"
// differently enough that reporting only one of them would be a lie by
// selection. Counted with
//   select count(*) from messages where org_id = 1 and message ilike '%export%';
const TERMS = process.env.TERM ? [process.env.TERM] : ['export', 'ERR_2452'];

const client = new pg.Client({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

// ---------------------------------------------------------------- the queries

// Both arms are verbatim from SearchService — org_id is passed explicitly even
// though the RLS policy also constrains it, because that is what the service
// sends and because the explicit predicate is the one that reaches the GIN
// key's leading column.
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

// ------------------------------------------------------------------ reporting

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Log-scaled for the same reason paging.mjs is: 0.5ms and 4,000ms on one
 *  linear axis is one bar and one invisible line. */
function bars(rows) {
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

const rule = (label) =>
  console.log(`\n--- ${label} ${'-'.repeat(Math.max(0, 68 - label.length))}`);

// -------------------------------------------------------------------- helpers

/** The scan node on `messages` — the thing the whole card is about. */
function findScan(node) {
  if (node['Relation Name'] === 'messages') return node;
  for (const child of node.Plans ?? []) {
    const found = findScan(child);
    if (found) return found;
  }
  return null;
}

async function explainJson(sql, params) {
  const { rows } = await client.query(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`,
    params,
  );
  return rows[0]['QUERY PLAN'][0];
}

async function explainText(label, sql, params) {
  const { rows } = await client.query(
    `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
    params,
  );
  rule(label);
  for (const row of rows) console.log(row['QUERY PLAN']);
}

/** Median wall-clock over ROUNDS runs, first discarded — the first run pays for
 *  whatever is not in shared_buffers and is not the number you serve. */
async function timed(sql, params) {
  const samples = [];
  for (let k = 0; k <= ROUNDS; k++) {
    const started = process.hrtime.bigint();
    await client.query(sql, params);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (k > 0) samples.push(ms);
  }
  return median(samples);
}

async function scalar(sql, params) {
  const { rows } = await client.query(sql, params);
  return Object.values(rows[0])[0];
}

// --------------------------------------------------------------------- scopes

/** BEGIN + the app role + the transaction-local GUC the policies read. */
async function openScope() {
  await client.query('BEGIN');
  await client.query(`SET LOCAL ROLE ${APP_USER}`);
  await client.query('SELECT set_config($1, $2, true)', ['app.org_id', ORG_ID]);
}

/** DDL runs as the owner, measurement runs as the app role. Every savepoint
 *  helper below hops between the two for that reason. */
async function asOwner(fn) {
  await client.query('SET LOCAL ROLE NONE');
  try {
    return await fn();
  } finally {
    await client.query(`SET LOCAL ROLE ${APP_USER}`);
  }
}

/** Runs `fn` with the GIN index dropped and puts it back by rolling back to a
 *  savepoint. DDL is transactional in Postgres, which is what makes the "before"
 *  plan reproducible after the migration has landed. */
async function withoutIndex(fn) {
  await client.query('SAVEPOINT no_index');
  try {
    await asOwner(() => client.query(`DROP INDEX ${INDEX_NAME}`));
    await fn();
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT no_index');
  }
}

/**
 * Runs `fn` with the tsvector match operator put back to NOT LEAKPROOF, then
 * rolls that away. Reproduces the state migration 1787998200000 fixed, which is
 * the state a fresh Postgres is in: under RLS the planner cannot promote a
 * non-leakproof qual into an index condition, so no index path exists at all.
 */
async function notLeakproof(fn) {
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

/**
 * Builds a candidate index, times the build, sizes it, runs `fn` against it and
 * rolls the whole thing away — pricing an index before committing to a
 * migration. Plain CREATE INDEX, not CONCURRENTLY: CONCURRENTLY cannot run
 * inside a transaction, which is exactly what makes this possible.
 */
async function withIndex(name, definition, fn) {
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
    const pretty = await scalar(
      `SELECT pg_size_pretty(pg_relation_size($1::regclass))`,
      [name],
    );
    await fn({ buildMs, bytes, pretty });
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT trial');
  }
}

// ---------------------------------------------------------------------- plans

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

  const chart = [];

  for (const term of TERMS) {
    const matches = Number(
      await scalar(
        `SELECT count(*) FROM messages WHERE org_id = $1 AND message ILIKE '%' || $2 || '%'`,
        [ORG_ID, term],
      ),
    );

    const row = async (arm, sql) => {
      const plan = await explainJson(sql, [ORG_ID, term]);
      const scan = findScan(plan.Plan) ?? plan.Plan;
      const ms = await timed(sql, [ORG_ID, term]);
      chart.push({ label: `${term} ${arm}`, ms });
      console.log(
        `  ${term.padEnd(15)} ${arm.padEnd(18)} ${scan['Node Type'].padEnd(31)}` +
          `${matches.toLocaleString().padStart(9)}  ${ms.toFixed(2).padStart(10)}   ` +
          `${scan['Shared Hit Blocks']}/${scan['Shared Read Blocks']}`,
      );
    };

    await row('like', likeQuery);
    await row('fts', ftsQuery);

    // The two controls. Without them "FTS is fast" is a claim about tsvector
    // rather than about the index, and the reason the index nearly went unused
    // stays invisible.
    const control = async (arm) => {
      const plan = await explainJson(ftsQuery, [ORG_ID, term]);
      const scan = findScan(plan.Plan) ?? plan.Plan;
      console.log(
        `  ${term.padEnd(15)} ${arm.padEnd(18)} ${scan['Node Type'].padEnd(31)}` +
          `${matches.toLocaleString().padStart(9)}  ` +
          `${plan['Execution Time'].toFixed(2).padStart(10)}   ` +
          `${scan['Shared Hit Blocks']}/${scan['Shared Read Blocks']}`,
      );
    };

    // The index is present and valid the whole time this runs. It is the
    // security qual from drill 07's RLS policy that puts it out of reach.
    await notLeakproof(() => control('fts, not leakproof'));
    await withoutIndex(() => control('fts, no gin'));
  }

  bars(chart);

  // The full plans for the common term, because the interesting part is what
  // sits ABOVE the scan node: a 164k-row bitmap still has to be sorted.
  await explainText(`like — ${TERMS[0]}`, likeQuery, [ORG_ID, TERMS[0]]);
  await explainText(`fts — ${TERMS[0]}`, ftsQuery, [ORG_ID, TERMS[0]]);
  if (TERMS.length > 1) {
    await explainText(`fts — ${TERMS[1]}`, ftsQuery, [ORG_ID, TERMS[1]]);
  }

  await client.query('COMMIT');
}

// -------------------------------------------------------------------- indexes

/**
 * Every index that could plausibly have been the answer, priced. The point of
 * the table is not that GIN wins; it is that `btree (message)` — the reflex
 * index — cannot serve `LIKE '%term%'` at any size, and that the tsvector
 * COLUMN costs more disk than the GIN index built on top of it.
 */
async function indexes() {
  await openScope();

  // Session-level and stated, because a build time without its
  // maintenance_work_mem is not a number. The shipped index's real build time
  // is measured separately, by the migration, at the server default of 64MB.
  const MWM = process.env.MAINTENANCE_WORK_MEM || '512MB';
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
  const candidates = [
    ['gin (org_id, tsv)', 'trial_gin_org_tsv', 'USING gin (org_id, tsv)', ftsQuery], // prettier-ignore
    ['gin (tsv)', 'trial_gin_tsv', 'USING gin (tsv)', ftsQuery],
    ['btree (message)', 'trial_btree_msg', '(message)', likeQuery],
    ['btree (message text_pattern_ops)', 'trial_btree_pat', '(message text_pattern_ops)', likeQuery], // prettier-ignore
    ['gin (message gin_trgm_ops)', 'trial_gin_trgm', 'USING gin (message gin_trgm_ops)', likeQuery], // prettier-ignore
  ];

  // A substring filter over the labels, so the two GIN variants can be
  // re-priced against the tail org without rebuilding two 1,959 MB btrees and a
  // trigram index to get there: ONLY=gin ORG_ID=150 pnpm db:search indexes
  const ONLY = process.env.ONLY || '';

  console.log(
    '  candidate                          build s      size   ' +
      'scan node on messages           median ms',
  );

  // Two rules, both learned by getting them wrong.
  //
  // 1. Every candidate is priced with the SHIPPED index dropped. Otherwise the
  //    planner reaches `messages_org_tsv_idx` while a rival is being measured —
  //    it picks the better of the two, or BitmapAnds them together — and the
  //    row reports the shipped index's number under the candidate's name.
  // 2. Every candidate gets its OWN transaction. Run in sequence inside one,
  //    `gin (tsv)` on the tail org measured 3.10ms; priced alone it measures
  //    5,188ms. Whatever an earlier candidate leaves behind, the number stops
  //    being about the index named in the row.
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

    // ROLLBACK, not COMMIT. Nothing a candidate did survives — including
    // `CREATE EXTENSION pg_trgm`, installed by the mode whose whole purpose is
    // to argue against installing it.
    await client.query('ROLLBACK');
  }

  if (!ONLY) {
    await openScope();
    await setMwm();
  }

  // Why every LIKE-serving candidate above says "Seq Scan": under RLS none of
  // them is reachable either. The security qual blocks any non-leakproof
  // operator from becoming an index condition, and all three text matchers are
  // non-leakproof — only `@@` was fixed, by migration 1787998200000.
  //
  //   SELECT proname, proleakproof FROM pg_proc
  //    WHERE proname IN ('textlike', 'texticlike');   -- f, f
  //
  // So the two probes below run as the OWNER, with no policy in the way. That
  // isolates the structural question the card asks — what a btree can and
  // cannot serve — from the RLS question, which is a different finding.
  if (!ONLY)
    await withoutIndex(async () => {
      // count(*), not LIMIT 20. With a LIMIT and no ORDER BY a sequential scan
      // stops at the twentieth match, so a common term "beats" an index scan by
      // never finishing. Counting makes both arms do all of their work.
      const counted = (pattern) =>
        `SELECT count(*) FROM messages WHERE org_id = $1 AND message LIKE ${pattern}`;

      // A prefix that exists. 83,571 messages in org 1 open with "Thanks", and
      // nothing at all starts with "export" — the first version of this probe
      // measured a 0-row scan and read like the index had failed.
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

      // The rejected index, shown doing the one thing the tsvector cannot: an
      // interior substring. Also as the owner, and for the same reason — shipping
      // it would mean marking texticlike LEAKPROOF too.
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

  // ROLLBACK, not COMMIT. Every index above was rolled away by its own
  // savepoint, but `CREATE EXTENSION pg_trgm` was not — and the decision this
  // mode exists to support is *not* to ship the trigram index. Measuring it
  // must not leave the extension installed.
  await client.query('ROLLBACK');
}

// ----------------------------------------------------------------------- gaps

/**
 * Where the two disagree, with the tsquery the input actually parsed into.
 *
 * The card asks for "at least one query where FTS is worse". There are two, and
 * they are not the two that were predicted: an interior substring is the only
 * thing FTS genuinely cannot answer, and the identifier case that was expected
 * to be a loss turns out to be a win. Both are in the table.
 */
async function gaps() {
  await openScope();

  // verdict is what MEASURING said, not what the plan predicted.
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

  // A prefix names a place in the lexeme btree that sits under every GIN entry;
  // an interior fragment names nothing, exactly as it names nothing in a btree
  // on the raw text. Same structural reason, one level down.
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

  // The prediction that was wrong. LIKE '%GGY%' looks like the case FTS loses;
  // measured, three quarters of what it returns is the name "Peggy". A lexeme
  // knows where a word ends and a substring does not.
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

// --------------------------------------------------------------------- writes

/**
 * The stretch: is search costing you writes? COPY and single-row INSERT into
 * `messages`, with the GIN index present and with it dropped, everything rolled
 * back at the end.
 *
 * Runs as the OWNER rather than the app role. RLS's WITH CHECK would be one
 * more thing between the client and the heap, and this is a measurement of
 * index maintenance, not of the policy.
 *
 * The number to distrust is the fast one. GIN buffers new entries in a pending
 * list (fastupdate is on by default) and pays for them later, so a short burst
 * looks cheap and the bill arrives at cleanup. The pending list is measured
 * before and after for exactly that reason.
 */
async function writes() {
  const ROWS = Number(process.env.ROWS || 50000);
  const INSERTS = Number(process.env.INSERTS || 2000);

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

  // to_regclass, not a bare cast. In the dropped-index arm the cast raises
  // 42P01, and one raised error inside a transaction aborts every statement
  // after it — including the COPY this was meant to be measuring. A `.catch()`
  // hides the error and not the abort, which is how that read as a COPY bug.
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

  // Interleaved, and each round starts from the same table — same rule as
  // paging.mjs. The first version of this ran both arms once, in order, and
  // reported 1.02x for COPY; the immediate re-run reported 1.36x and 3.31x for
  // INSERT. Un-interleaved single runs of this are not a measurement: the arm
  // that goes first pays for the cold state, and the rolled-back rows of one
  // round change the next.
  const samples = {
    copyWith: [],
    copyWithout: [],
    insWith: [],
    insWithout: [],
  };
  let grewWith = 0;
  let cleaned = null;

  for (let round = 0; round < ROUNDS; round++) {
    await client.query('SAVEPOINT arm');
    const withGin = await copy();
    samples.copyWith.push(withGin.rate);
    grewWith = withGin.grew;
    samples.insWith.push(await inserts());
    // The deferred bill, measured while the index still holds it. fastupdate
    // buffers new entries in a pending list and merges them later, so the COPY
    // rate above is not the whole cost; gin_clean_pending_list() does the merge
    // on demand and returns how many pages it had to move.
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

  const row = (label, values) =>
    console.log(
      `  ${label.padEnd(24)} ${median(values).toFixed(0).padStart(8)} rows/s   ` +
        `(${values.map((v) => v.toFixed(0)).join(', ')})`,
    );

  row('COPY, gin present', samples.copyWith);
  row('COPY, gin dropped', samples.copyWithout);
  row('INSERT, gin present', samples.insWith);
  row('INSERT, gin dropped', samples.insWithout);

  const ratio = (a, b) => (median(b) / median(a)).toFixed(2);
  console.log(
    `\n  COPY   ${ratio(samples.copyWith, samples.copyWithout)}x faster without the GIN index` +
      `   (index grew ${(grewWith / 1024 ** 2).toFixed(1)} MB per ${ROWS.toLocaleString()} rows)`,
  );
  console.log(
    `  INSERT ${ratio(samples.insWith, samples.insWithout)}x faster without the GIN index`,
  );

  // Why the two arms are closer than they look. Dropping the index does NOT
  // avoid building the tsvector — `tsv` is a generated column, so both arms
  // parse and stem every message on the way in.
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
  console.log(
    `  gin_clean_pending_list: ${cleaned.pages.toLocaleString()} pages in ` +
      `${cleaned.ms.toFixed(0)} ms — work one COPY deferred`,
  );

  // Nothing above this line survives.
  await client.query('ROLLBACK');
}

// ----------------------------------------------------------------------- main

await client.connect();
try {
  if (mode === 'plans') await plans();
  else if (mode === 'indexes') await indexes();
  else if (mode === 'gaps') await gaps();
  else await writes();
} finally {
  await client.end();
}
