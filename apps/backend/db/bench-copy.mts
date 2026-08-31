import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { from as copyFrom } from 'pg-copy-streams';
import { faker } from '@faker-js/faker';
import { createCorpus, mulberry32, PHASE } from './lib/corpus.mts';
import { client as pgClient, header, knobNumber, record } from './lib/run.mts';

const ROWS = knobNumber('BENCH_ROWS', 100_000);
const BATCH_LINES = 10_000;
const SEED = 20260811;

const SCRATCH = `
  CREATE UNLOGGED TABLE bench_rows (
    id              bigint      PRIMARY KEY,
    conversation_id uuid        NOT NULL,
    org_id          bigint      NOT NULL,
    message         text        NOT NULL,
    created_at      timestamptz NOT NULL
  );
`;

const client = pgClient();

const BODY = 'x'.repeat(180);
const UUID = '018f3a2b-0000-7000-8000-000000000000';
const STAMP = '2026-01-01 00:00:00+00';

const ms = (ns: bigint) => Number(ns) / 1e6;

async function reset() {
  await client.query('DROP TABLE IF EXISTS bench_rows');
  await client.query(SCRATCH);
}

async function insertLoop(rows: number): Promise<number> {
  const started = process.hrtime.bigint();
  for (let i = 1; i <= rows; i++) {
    await client.query(
      'INSERT INTO bench_rows (id, conversation_id, org_id, message, created_at) VALUES ($1,$2,$3,$4,$5)',
      [i, UUID, 1, BODY, STAMP],
    );
  }
  return ms(process.hrtime.bigint() - started);
}

async function copyStream(rows: number): Promise<number> {
  const started = process.hrtime.bigint();
  const stream = client.query(
    copyFrom(
      'COPY bench_rows (id, conversation_id, org_id, message, created_at) FROM STDIN',
    ),
  );

  const source = Readable.from(
    (function* () {
      const batch: string[] = [];
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

function benchBodies(rows: number) {
  const out = { lengths: 0, sample: [] as string[] };

  faker.seed(SEED);
  const perRowStart = process.hrtime.bigint();
  for (let i = 0; i < rows; i++) {
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

  const fmt = (t: number) =>
    `${(t / 1000).toFixed(2)}s  (${Math.round(ROWS / (t / 1000)).toLocaleString()} rows/s)`;

  console.log('== Ingest ==');
  console.log(`INSERT loop : ${fmt(loopMs)}`);
  console.log(`COPY        : ${fmt(copyMs)}`);
  console.log(`COPY is ${(loopMs / copyMs).toFixed(1)}x faster.\n`);

  const b = benchBodies(ROWS);
  const rate = (t: number) => Math.round(ROWS / (t / 1000));
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
  record('bench-copy', 'copy', {});
}

header('bench-copy');

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
