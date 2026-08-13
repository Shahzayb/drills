// The card's warm-up: get one COPY of 100k rows working before building the real
// seeder, and measure it against the insert loop it replaces. See
// plans/2026-08-11_drill-04-bulk-seed.md.
//
// Kept in the repo rather than thrown away because it is the evidence behind the
// writeup's "COPY is N times faster" claim, and because it is the smallest thing
// that still demonstrates the mechanism.
//
// Run: docker compose exec nest_server pnpm --filter=backend run bench:copy
//
// It writes into a scratch table it creates and drops itself, so it never
// touches the real schema and can run against a seeded database safely.

import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { faker } from '@faker-js/faker';
import { createCorpus, mulberry32, PHASE } from './lib/corpus.mjs';

const ROWS = Number(process.env.BENCH_ROWS ?? 100_000);
const BATCH_LINES = 10_000;
const SEED = 20260811;

// Shaped like `messages`: a uuid, a bigint, a ~180 char body, two timestamps.
// Benchmarking a narrow two-column table would flatter COPY by removing exactly
// the serialisation cost the real seed has to pay.
const SCRATCH = `
  CREATE UNLOGGED TABLE bench_rows (
    id              bigint      PRIMARY KEY,
    conversation_id uuid        NOT NULL,
    org_id          bigint      NOT NULL,
    message         text        NOT NULL,
    created_at      timestamptz NOT NULL
  );
`;

const client = new pg.Client({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? 'postgres',
  password: process.env.POSTGRES_PASSWORD ?? 'postgres',
  database: process.env.POSTGRES_DB ?? 'postgres',
});

const BODY = 'x'.repeat(180);
const UUID = '018f3a2b-0000-7000-8000-000000000000';
const STAMP = '2026-01-01 00:00:00+00';

const ms = (ns) => Number(ns) / 1e6;

async function reset() {
  await client.query('DROP TABLE IF EXISTS bench_rows');
  await client.query(SCRATCH);
}

/** One round trip per row. The thing COPY is supposed to beat. */
async function insertLoop(rows) {
  const started = process.hrtime.bigint();
  for (let i = 1; i <= rows; i++) {
    await client.query(
      'INSERT INTO bench_rows (id, conversation_id, org_id, message, created_at) VALUES ($1,$2,$3,$4,$5)',
      [i, UUID, 1, BODY, STAMP],
    );
  }
  return ms(process.hrtime.bigint() - started);
}

/**
 * Same rows, one statement. The generator is a Readable rather than a string so
 * the 100k-row case exercises the same backpressure path the 10M-row case will.
 */
async function copyStream(rows) {
  const started = process.hrtime.bigint();
  const stream = client.query(
    copyFrom(
      'COPY bench_rows (id, conversation_id, org_id, message, created_at) FROM STDIN',
    ),
  );

  const source = Readable.from(
    (function* () {
      const batch = [];
      for (let i = 1; i <= rows; i++) {
        batch.push(`${i}\t${UUID}\t1\t${BODY}\t${STAMP}`);
        if (batch.length === BATCH_LINES) {
          yield batch.join('\n') + '\n';
          batch.length = 0;
        }
      }
      if (batch.length) yield batch.join('\n') + '\n';
    })(),
  );

  await pipeline(source, stream);
  return ms(process.hrtime.bigint() - started);
}

/**
 * Body generation, the other half of the budget. Two ways to reach the same
 * realism bar, measured against the rule fixed in the plan: >=150k bodies/sec
 * ships, below that the composition gets simpler until it clears.
 */
function benchBodies(rows) {
  const out = { lengths: 0, sample: [] };

  faker.seed(SEED);
  const perRowStart = process.hrtime.bigint();
  for (let i = 0; i < rows; i++) {
    // The naive realistic option: ask faker for every part, every row.
    const s = `${faker.hacker.phrase()} ${faker.company.name()} ${faker.person.fullName()}`;
    if (i === 0) out.sample.push(s);
  }
  const perRowMs = ms(process.hrtime.bigint() - perRowStart);

  faker.seed(SEED);
  const corpus = createCorpus(faker, mulberry32(SEED));
  const phases = Object.values(PHASE);

  const tplStart = process.hrtime.bigint();
  let total = 0;
  for (let i = 0; i < rows; i++) {
    const s = corpus.body(phases[i % phases.length]);
    total += s.length;
    if (i < 6) out.sample.push(s);
  }
  const tplMs = ms(process.hrtime.bigint() - tplStart);

  out.lengths = total / rows;
  return { perRowMs, tplMs, ...out };
}

async function main() {
  await client.connect();
  const { rows: v } = await client.query('SHOW server_version');
  console.log(
    `Postgres ${v[0].server_version}, ${ROWS.toLocaleString()} rows each\n`,
  );

  await reset();
  const loopMs = await insertLoop(ROWS);

  await reset();
  const copyMs = await copyStream(ROWS);

  await client.query('DROP TABLE bench_rows');

  const fmt = (t) =>
    `${(t / 1000).toFixed(2)}s  (${Math.round(ROWS / (t / 1000)).toLocaleString()} rows/s)`;

  console.log('== Ingest ==');
  console.log(`INSERT loop : ${fmt(loopMs)}`);
  console.log(`COPY        : ${fmt(copyMs)}`);
  console.log(`COPY is ${(loopMs / copyMs).toFixed(1)}x faster.\n`);

  const b = benchBodies(ROWS);
  const rate = (t) => Math.round(ROWS / (t / 1000));
  console.log('== Body generation ==');
  console.log(`faker per row : ${fmt(b.perRowMs)}`);
  console.log(`templates     : ${fmt(b.tplMs)}`);
  console.log(`templates are ${(b.perRowMs / b.tplMs).toFixed(1)}x faster.`);
  console.log(`mean body length: ${b.lengths.toFixed(0)} chars`);
  console.log(
    `\nBudget rule (>=150k/sec): faker per row ${rate(b.perRowMs) >= 150_000 ? 'PASSES' : 'FAILS'}, ` +
      `templates ${rate(b.tplMs) >= 150_000 ? 'PASSES' : 'FAILS'}.`,
  );
  console.log(
    `\nProjected for 10M bodies: faker ${((b.perRowMs * 100) / 1000).toFixed(0)}s, templates ${((b.tplMs * 100) / 1000).toFixed(0)}s.`,
  );

  console.log('\n== Sample bodies ==');
  for (const s of b.sample.slice(1)) console.log(`  - ${s}`);

  await client.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
