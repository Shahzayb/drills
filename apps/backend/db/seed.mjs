// Bulk development seed. NOT a migration: fixtures have no business in the
// pgmigrations ledger, and this must never run in CI against a real database.
//
// Targets at --scale=1: 200 orgs, 1,200 users, ~1,760 memberships,
// 2,500,000 conversations, 10,000,000 messages. Every design decision here —
// the 40/40/20 org skew, the recency-weighted timestamps, the client-side
// uuidv7, the single WAL-skipping transaction — is argued in
// plans/2026-08-11_drill-04-bulk-seed.md. Read that before "improving" any of it.
//
//   pnpm db:seed              full scale
//   pnpm db:seed:ci           --scale=0.1
//   pnpm db:reset             drop schema, migrate, seed
//
// One flag: --scale=N, a row multiplier for conversations and messages only.
// Flags that switched each performance lever off individually are gone now the
// attribution is settled — the A-F table in the plan file is the record.

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { faker } from '@faker-js/faker';
import { createCorpus, mulberry32, phaseFor } from './lib/corpus.mjs';

// ---------------------------------------------------------------- parameters

const SEED = 20260811;

const scaleArg = process.argv.slice(2).find((a) => a.startsWith('--scale='));
const SCALE = scaleArg ? Number(scaleArg.split('=')[1]) : 1;

if (!Number.isFinite(SCALE) || SCALE <= 0) {
  throw new Error(`--scale must be a positive number, got ${SCALE}`);
}

// Orgs and users do NOT scale. Shrinking the org count would change the shape of
// the skew, and the skew is what CI most needs to keep testing.
const ORGS = 200;
const USERS = 1200;
const CONVERSATIONS = Math.round(2_500_000 * SCALE);

const DAY_MS = 86_400_000;
const WINDOW_MS = 548 * DAY_MS; // 18 months
// Fixed, not Date.now(), because "two runs produce identical data" is a
// requirement and a moving anchor breaks it. Pinned to midnight UTC of the day
// the drill was built rather than a time of day: an anchor later than the wall
// clock back-dates nothing and forward-dates everything near the top of the
// distribution, which is how the first run put 75,606 conversations in the
// future.
const NOW = Date.UTC(2026, 7, 11, 0, 0, 0);

// Messages per conversation. Fractions chosen so the weighted mean is exactly
// 4.00, which makes 2.5M conversations produce exactly 10M messages with no
// rounding residue to patch up afterwards.
const MSG_BUCKETS = [
  { frac: 0.46, count: 2 },
  { frac: 0.25, count: 3 },
  { frac: 0.17, count: 5 },
  { frac: 0.09, count: 8 },
  { frac: 0.026, count: 20 },
  { frac: 0.004, count: 60 },
];

const COPY_BATCH = 10_000;

// ------------------------------------------------------------------- helpers

const ms = (ns) => Number(ns) / 1e6;

async function phase(name, fn, rows = null) {
  const started = process.hrtime.bigint();
  const result = await fn();
  const elapsed = ms(process.hrtime.bigint() - started);
  const rate = rows
    ? ` ${Math.round(rows / (elapsed / 1000)).toLocaleString()} rows/s`
    : '';
  console.log(
    `  ${name.padEnd(28)} ${(elapsed / 1000).toFixed(2).padStart(7)}s${rate}`,
  );
  return result;
}

// COPY text format parses ISO 8601 with the same input function as a literal, so
// there is nothing here to hand-roll. A day cache and a divmod formatter used to
// live here, worth 3.8s of CPU on a pipeline where the generator already runs 15x
// ahead of Postgres — see plans/2026-08-12_seed-simplification.md.
const stamp = (msEpoch) => new Date(Math.floor(msEpoch)).toISOString();

// Second granularity is load-bearing, not cosmetic: with ~80k of org 1's rows inside
// the last 24h it manufactures the updated_at ties that drill 03's
// `ORDER BY updated_at DESC, id DESC` tiebreaker exists for. Not redundant with
// planConversations — its Math.max floor can emit a non-aligned value for
// conversations younger than the minimum span.
const stampSecond = (msEpoch) =>
  new Date(Math.floor(msEpoch / 1000) * 1000).toISOString();

/**
 * uuidv7 built from the row's own created_at rather than insert time, so id
 * order and creation order agree and the PK btree is append-only during load.
 *
 * Layout is the spec's: 48-bit big-endian millisecond timestamp, 4-bit version
 * (7), 12 random bits, 2-bit variant (0b10), then 62 more random bits.
 */
function writeUuid(buf, off, msEpoch, rnd) {
  buf.writeUIntBE(Math.floor(msEpoch), off, 6);
  buf.writeUInt16BE(0x7000 | ((rnd() * 0x1000) | 0), off + 6);
  const hi = (rnd() * 0x100000000) >>> 0;
  // >>> 0 because `|` yields a *signed* int32 and writeUInt32BE rejects it.
  buf.writeUInt32BE((0x80000000 | (hi & 0x3fffffff)) >>> 0, off + 8);
  buf.writeUInt32BE((rnd() * 0x100000000) >>> 0, off + 12);
}

function uuidHex(buf, off) {
  const h = buf.toString('hex', off, off + 16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function shuffle(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
}

const sanitise = (s) =>
  String(s)
    .replace(/[\\\t\n\r]+/g, ' ')
    .trim();

// ------------------------------------------------------------------ planning

function planStructure() {
  faker.seed(SEED);
  const rnd = mulberry32(SEED + 1);

  // Orgs and users predate the conversation window so no child row is older
  // than its parent.
  const orgBase = NOW - WINDOW_MS - 60 * DAY_MS;

  const orgs = [];
  for (let i = 1; i <= ORGS; i++) {
    // Plan correlates with tier: the whale and the mid orgs are the paying ones.
    const plan =
      i === 1
        ? 'pro'
        : i <= 10
          ? rnd() < 0.6
            ? 'pro'
            : 'basic'
          : rnd() < 0.75
            ? 'free'
            : 'basic';
    const created = orgBase - Math.floor(rnd() * 300 * DAY_MS);
    orgs.push({
      id: i,
      name: sanitise(faker.company.name()).slice(0, 255),
      plan,
      created,
    });
  }

  const users = [];
  for (let i = 1; i <= USERS; i++) {
    users.push({
      id: i,
      name: sanitise(faker.person.fullName()),
      created: orgBase - Math.floor(rnd() * 280 * DAY_MS),
    });
  }

  // Memberships laid out in contiguous id blocks per org, so picking an
  // assignee for a conversation is a range index rather than a lookup.
  const memStart = new Int32Array(ORGS + 1);
  const memCount = new Int32Array(ORGS + 1);
  const memberships = [];
  let memId = 1;
  for (let org = 1; org <= ORGS; org++) {
    const size = org === 1 ? 45 : org <= 10 ? 22 : 6 + ((rnd() * 5) | 0);
    memStart[org] = memId;
    memCount[org] = size;
    const offset = (rnd() * USERS) | 0;
    for (let k = 0; k < size; k++) {
      memberships.push({
        id: memId++,
        userId: ((offset + k) % USERS) + 1,
        orgId: org,
        role: k === 0 || rnd() < 0.15 ? 'admin' : 'editor',
        created: orgBase - Math.floor(rnd() * 200 * DAY_MS),
      });
    }
  }

  return { orgs, users, memberships, memStart, memCount };
}

function planConversations() {
  const rnd = mulberry32(SEED + 2);
  const n = CONVERSATIONS;

  // Recency weighting. age = WINDOW * u^2.5 puts the median around 3.2 months
  // instead of the 9 a uniform spread would give.
  const created = new Float64Array(n);
  for (let i = 0; i < n; i++)
    created[i] = NOW - WINDOW_MS * Math.pow(rnd(), 2.5);
  created.sort();

  // Exact 40/40/20, then shuffled — not sampled, so the GROUP BY proof is exact
  // rather than exact-ish.
  const orgOf = new Int32Array(n);
  const whale = Math.round(n * 0.4);
  const mid = Math.round(n * 0.4);
  let at = 0;
  for (let k = 0; k < whale; k++) orgOf[at++] = 1;
  for (let k = 0; k < mid; k++) orgOf[at++] = 2 + (k % 9);
  for (let k = 0; at < n; k++) orgOf[at++] = 11 + (k % 190);
  shuffle(orgOf, rnd);

  // Exact bucket sizes: floor every bucket, then give the rounding residue to
  // the first one so the totals still land on exactly n.
  const sizes = MSG_BUCKETS.map((b) => Math.floor(n * b.frac));
  sizes[0] += n - sizes.reduce((s, x) => s + x, 0);

  const msgCount = new Uint8Array(n);
  at = 0;
  for (let b = 0; b < MSG_BUCKETS.length; b++) {
    for (let k = 0; k < sizes[b]; k++) msgCount[at++] = MSG_BUCKETS[b].count;
  }
  shuffle(msgCount, rnd);

  // Status correlates with age, and the shape matters more than the headline
  // percentage. A linear ramp closes half of the conversations created seconds
  // ago, which no support inbox does. Exponential decay in age gives ~27% closed
  // at zero age, ~73% by 36 days (1/CLOSE_RATE of the window) and ~99% past six
  // months, landing near 78% overall.
  //
  // Uniform status would flatter a partial index on status='open' later; so does
  // this, but for the reason production does — recent and open travel together.
  const CLOSE_RATE = 15;
  const OPEN_AT_ZERO = 0.73;
  const closed = new Uint8Array(n);
  const updated = new Float64Array(n);
  let messages = 0;
  for (let i = 0; i < n; i++) {
    const ageFrac = (NOW - created[i]) / WINDOW_MS;
    closed[i] =
      rnd() < 1 - OPEN_AT_ZERO * Math.exp(-ageFrac * CLOSE_RATE) ? 1 : 0;
    // updated_at is the last message's timestamp, so an inbox sorted by it is
    // sorted by real activity rather than by an unrelated number. Truncated to
    // the second on purpose: at ~80k of org 1's rows inside the last 24h, that
    // guarantees the sort-key ties drill 03's tiebreaker exists for.
    const span = Math.min(
      NOW - created[i],
      1.8e6 + Math.pow(rnd(), 2) * 14 * DAY_MS,
    );
    updated[i] = Math.max(
      Math.floor((created[i] + span) / 1000) * 1000,
      Math.floor(created[i]),
    );
    messages += msgCount[i];
  }

  return { created, updated, orgOf, msgCount, closed, messages };
}

// ---------------------------------------------------------------- generators
//
// Only the two big tables stream. Everything else is small enough to build as
// one string.
//
// A note for anyone about to speed these up: don't, without measuring first — and
// measure wall clock, not CPU. The pipeline is pull-based: Postgres ingests
// messages at ~121k rows/s while this side produces them well above that, so the
// generator spends most of the load suspended at its `yield`. Two rounds of
// micro-optimisation here were measured and reverted; see
// plans/2026-08-12_seed-simplification.md for what that cost in wall clock (~4s).

function* conversationLines(plan, memStart, memCount, uuidBuf) {
  const rnd = mulberry32(SEED + 3);
  const { created, updated, orgOf, closed } = plan;
  const batch = [];
  for (let i = 0; i < CONVERSATIONS; i++) {
    const org = orgOf[i];
    writeUuid(uuidBuf, i * 16, created[i], rnd);
    // One conversation in five is unassigned. An always-populated nullable
    // column hides exactly the bugs it exists to expose.
    const assignee =
      rnd() < 0.2
        ? '\\N'
        : String(memStart[org] + ((rnd() * memCount[org]) | 0));
    batch.push(
      `${uuidHex(uuidBuf, i * 16)}\t${org}\t${closed[i] ? 'closed' : 'open'}\t${assignee}\t${stamp(created[i])}\t${stampSecond(updated[i])}`,
    );
    if (batch.length === COPY_BATCH) {
      yield batch.join('\n') + '\n';
      batch.length = 0;
    }
  }
  if (batch.length) yield batch.join('\n') + '\n';
}

function* messageLines(plan, uuidBuf, corpus) {
  const rnd = mulberry32(SEED + 5);
  const { created, updated, orgOf, msgCount, closed } = plan;
  const batch = [];
  let id = 1;
  for (let i = 0; i < CONVERSATIONS; i++) {
    const count = msgCount[i];
    const org = orgOf[i];
    const isClosed = closed[i] === 1;
    // Hex once per conversation, not once per message.
    const convId = uuidHex(uuidBuf, i * 16);
    const start = created[i];
    const span = updated[i] - start;

    for (let k = 0; k < count; k++) {
      // Evenly spaced across the conversation's span with a little jitter, first
      // and last pinned to created_at and updated_at.
      const t =
        k === 0
          ? start
          : k === count - 1
            ? updated[i]
            : start + (span * (k + 0.6 * (rnd() - 0.5))) / (count - 1);
      const body = corpus.body(phaseFor(k, count, isClosed));
      const at = stamp(t);
      batch.push(`${id++}\t${convId}\t${org}\t${body}\t${at}\t${at}`);
      if (batch.length === COPY_BATCH) {
        yield batch.join('\n') + '\n';
        batch.length = 0;
      }
    }
  }
  if (batch.length) yield batch.join('\n') + '\n';
}

// --------------------------------------------------------------------- load

const client = new pg.Client({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? 'postgres',
  password: process.env.POSTGRES_PASSWORD ?? 'postgres',
  database: process.env.POSTGRES_DB ?? 'postgres',
});

async function copyInto(sql, iterator) {
  await pipeline(Readable.from(iterator), client.query(copyFrom(sql)));
}

const SECONDARY_INDEXES = [
  [
    'conversations_org_id_idx',
    'CREATE INDEX conversations_org_id_idx ON conversations (org_id)',
  ],
  [
    'conversations_assignee_id_idx',
    'CREATE INDEX conversations_assignee_id_idx ON conversations (assignee_id)',
  ],
  [
    'messages_conversation_id_idx',
    'CREATE INDEX messages_conversation_id_idx ON messages (conversation_id)',
  ],
];

async function main() {
  const startedAll = process.hrtime.bigint();
  await client.connect();

  console.log(`\nseed  scale=${SCALE}`);
  console.log(
    `      ${CONVERSATIONS.toLocaleString()} conversations planned\n`,
  );

  const structure = await phase('plan structure', () => planStructure());
  const plan = await phase('plan conversations', () => planConversations());
  const uuidBuf = Buffer.allocUnsafe(CONVERSATIONS * 16);

  const corpus = await phase('build corpus', () => {
    faker.seed(SEED + 7);
    return createCorpus(faker, mulberry32(SEED + 4));
  });

  // Session-level, not server-level: these are only wanted for the seed. 512MB is
  // sized from the biggest index build's actual sort (10M x ~24B = ~240MB), which
  // is the line between an in-memory quicksort and a disk-based external merge.
  await client.query(`SET maintenance_work_mem = '512MB'`);
  await client.query('SET synchronous_commit = off');

  // Everything from here to COMMIT is one transaction, which is what lets
  // wal_level=minimal skip the WAL for tables truncated inside it.
  await client.query('BEGIN');

  await phase('truncate', async () => {
    await client.query(
      'TRUNCATE messages, conversations, memberships, users, organizations RESTART IDENTITY',
    );
  });

  await phase('drop secondary indexes', async () => {
    for (const [name] of SECONDARY_INDEXES)
      await client.query(`DROP INDEX ${name}`);
  });

  // Worth 51.6s, the largest single lever: 10M immediate per-row trigger firings
  // against a 2.5M-row uuid index. Re-added below with the same guarantees.
  await phase('drop messages FK', () =>
    client.query(
      'ALTER TABLE messages DROP CONSTRAINT messages_conversation_id_fkey',
    ),
  );

  // Small enough to build as one string each — no batching, no streaming.
  for (const [name, rows, columns, format] of [
    [
      'organizations',
      structure.orgs,
      '(id, name, plan, created_at, updated_at)',
      (o) =>
        `${o.id}\t${o.name}\t${o.plan}\t${stamp(o.created)}\t${stamp(o.created)}`,
    ],
    [
      'users',
      structure.users,
      '(id, name, created_at, updated_at)',
      (u) => `${u.id}\t${u.name}\t${stamp(u.created)}\t${stamp(u.created)}`,
    ],
    [
      'memberships',
      structure.memberships,
      '(id, user_id, org_id, role, created_at, updated_at)',
      (m) =>
        `${m.id}\t${m.userId}\t${m.orgId}\t${m.role}\t${stamp(m.created)}\t${stamp(m.created)}`,
    ],
  ]) {
    await phase(
      `copy ${name}`,
      () =>
        copyInto(`COPY ${name} ${columns} FROM STDIN`, [
          rows.map(format).join('\n') + '\n',
        ]),
      rows.length,
    );
  }

  await phase(
    'copy conversations',
    () =>
      copyInto(
        'COPY conversations (id, org_id, status, assignee_id, created_at, updated_at) FROM STDIN',
        conversationLines(
          plan,
          structure.memStart,
          structure.memCount,
          uuidBuf,
        ),
      ),
    CONVERSATIONS,
  );

  await phase(
    'copy messages',
    () =>
      copyInto(
        'COPY messages (id, conversation_id, org_id, message, created_at, updated_at) FROM STDIN',
        messageLines(plan, uuidBuf, corpus),
      ),
    plan.messages,
  );

  // Also WAL-skipped, being inside the same transaction. Only worth dropping them
  // because maintenance_work_mem is raised: at the 64MB default the messages index
  // rebuild costs 17s and the drop is a net loss.
  for (const [name, sql] of SECONDARY_INDEXES) {
    await phase(`build ${name.replace(/_idx$/, '')}`, () => client.query(sql));
  }

  // NOT VALID takes the constraint without scanning; VALIDATE then scans without
  // holding the strong lock. The production move for adding an FK to a big table.
  // convalidated = t afterwards, so the end state is identical to never dropping it.
  await phase('re-add messages FK', async () => {
    await client.query(
      'ALTER TABLE messages ADD CONSTRAINT messages_conversation_id_fkey ' +
        'FOREIGN KEY (conversation_id) REFERENCES conversations (id) NOT VALID',
    );
    await client.query(
      'ALTER TABLE messages VALIDATE CONSTRAINT messages_conversation_id_fkey',
    );
  });

  // TRUNCATE ... RESTART IDENTITY zeroed the sequences and every id was
  // explicit, so without this the app's first INSERT dies on a duplicate key.
  await phase('setval sequences', async () => {
    await client.query(`SELECT setval('organizations_id_seq', $1)`, [ORGS]);
    await client.query(`SELECT setval('users_id_seq', $1)`, [USERS]);
    await client.query(`SELECT setval('memberships_id_seq', $1)`, [
      structure.memberships.length,
    ]);
    await client.query(`SELECT setval('messages_id_seq', $1)`, [plan.messages]);
  });

  await phase('commit', () => client.query('COMMIT'));

  await phase('analyze', () => client.query('ANALYZE'));

  const total = ms(process.hrtime.bigint() - startedAll) / 1000;
  console.log(`\n  ${'TOTAL'.padEnd(28)} ${total.toFixed(2).padStart(7)}s`);
  console.log(
    `  ${plan.messages.toLocaleString()} messages, ${CONVERSATIONS.toLocaleString()} conversations, ` +
      `${structure.memberships.length.toLocaleString()} memberships\n`,
  );

  await client.end();
}

main().catch(async (error) => {
  console.error(error);
  try {
    await client.end();
  } catch {}
  process.exit(1);
});
