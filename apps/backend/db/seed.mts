import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import pg from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { faker } from '@faker-js/faker';
import type { Corpus, Rng } from './lib/corpus.mts';
import { createCorpus, mulberry32, phaseFor } from './lib/corpus.mts';

const SEED = 20260811;

const scaleArg = process.argv.slice(2).find((a) => a.startsWith('--scale='));
const SCALE = scaleArg ? Number(scaleArg.split('=')[1]) : 1;

if (!Number.isFinite(SCALE) || SCALE <= 0) {
  throw new Error(`--scale must be a positive number, got ${SCALE}`);
}

const ORGS = 200;
const USERS = 1200;
const CONVERSATIONS = Math.round(2_500_000 * SCALE);

const DAY_MS = 86_400_000;
const WINDOW_MS = 548 * DAY_MS;
const NOW = Date.UTC(2026, 7, 11, 0, 0, 0);

const MSG_BUCKETS = [
  { frac: 0.46, count: 2 },
  { frac: 0.25, count: 3 },
  { frac: 0.17, count: 5 },
  { frac: 0.09, count: 8 },
  { frac: 0.026, count: 20 },
  { frac: 0.004, count: 60 },
];

const TAG_NAMES = [
  'bug',
  'billing',
  'feature-request',
  'urgent',
  'churn-risk',
  'onboarding',
  'integration',
  'performance',
  'refund',
  'docs',
  'mobile',
  'api',
  'security',
  'ux',
  'enterprise',
  'follow-up',
];

const TAG_BUCKETS = [
  { frac: 0.18, count: 0 },
  { frac: 0.42, count: 1 },
  { frac: 0.28, count: 2 },
  { frac: 0.12, count: 3 },
];

const COPY_BATCH = 10_000;

const ms = (ns: bigint) => Number(ns) / 1e6;

async function phase<T>(
  name: string,
  fn: () => T | Promise<T>,
  rows: number | null = null,
): Promise<T> {
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

const stamp = (msEpoch: number) => new Date(Math.floor(msEpoch)).toISOString();

const stampSecond = (msEpoch: number) =>
  new Date(Math.floor(msEpoch / 1000) * 1000).toISOString();

function writeUuid(buf: Buffer, off: number, msEpoch: number, rnd: Rng): void {
  buf.writeUIntBE(Math.floor(msEpoch), off, 6);
  buf.writeUInt16BE(0x7000 | ((rnd() * 0x1000) | 0), off + 6);
  const hi = (rnd() * 0x100000000) >>> 0;
  buf.writeUInt32BE((0x80000000 | (hi & 0x3fffffff)) >>> 0, off + 8);
  buf.writeUInt32BE((rnd() * 0x100000000) >>> 0, off + 12);
}

function uuidHex(buf: Buffer, off: number): string {
  const h = buf.toString('hex', off, off + 16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

interface Indexed<T> {
  length: number;
  [i: number]: T;
}

function shuffle<T>(arr: Indexed<T>, rnd: Rng): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
}

const sanitise = (s: unknown): string =>
  String(s)
    .replace(/[\\\t\n\r]+/g, ' ')
    .trim();

interface Structure {
  orgs: { id: number; name: string; plan: string; created: number }[];
  users: { id: number; name: string; created: number }[];
  memberships: {
    id: number;
    userId: number;
    orgId: number;
    role: string;
    created: number;
  }[];
  memStart: Int32Array;
  memCount: Int32Array;
  tags: { id: number; orgId: number; name: string; created: number }[];
  tagStart: Int32Array;
  tagCount: Int32Array;
}

interface ConversationPlan {
  created: Float64Array;
  updated: Float64Array;
  orgOf: Int32Array;
  msgCount: Uint8Array;
  closed: Uint8Array;
  messages: number;
  numTags: Uint8Array;
  conversationTags: number;
}

function planStructure(): Structure {
  faker.seed(SEED);
  const rnd = mulberry32(SEED + 1);

  const orgBase = NOW - WINDOW_MS - 60 * DAY_MS;

  const orgs: Structure['orgs'] = [];
  for (let i = 1; i <= ORGS; i++) {
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

  const users: Structure['users'] = [];
  for (let i = 1; i <= USERS; i++) {
    users.push({
      id: i,
      name: sanitise(faker.person.fullName()),
      created: orgBase - Math.floor(rnd() * 280 * DAY_MS),
    });
  }

  const memStart = new Int32Array(ORGS + 1);
  const memCount = new Int32Array(ORGS + 1);
  const memberships: Structure['memberships'] = [];
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

  const tagRnd = mulberry32(SEED + 6);
  const tagStart = new Int32Array(ORGS + 1);
  const tagCount = new Int32Array(ORGS + 1);
  const tags: Structure['tags'] = [];
  let tagId = 1;
  for (let org = 1; org <= ORGS; org++) {
    const size = org === 1 ? 12 : org <= 10 ? 9 : 4 + ((tagRnd() * 3) | 0);
    tagStart[org] = tagId;
    tagCount[org] = size;
    const names = TAG_NAMES.slice();
    shuffle(names, tagRnd);
    for (let k = 0; k < size; k++) {
      tags.push({
        id: tagId++,
        orgId: org,
        name: names[k],
        created: orgBase - Math.floor(tagRnd() * 200 * DAY_MS),
      });
    }
  }

  return {
    orgs,
    users,
    memberships,
    memStart,
    memCount,
    tags,
    tagStart,
    tagCount,
  };
}

function planConversations(): ConversationPlan {
  const rnd = mulberry32(SEED + 2);
  const n = CONVERSATIONS;

  const created = new Float64Array(n);
  for (let i = 0; i < n; i++)
    created[i] = NOW - WINDOW_MS * Math.pow(rnd(), 2.5);
  created.sort();

  const orgOf = new Int32Array(n);
  const whale = Math.round(n * 0.4);
  const mid = Math.round(n * 0.4);
  let at = 0;
  for (let k = 0; k < whale; k++) orgOf[at++] = 1;
  for (let k = 0; k < mid; k++) orgOf[at++] = 2 + (k % 9);
  for (let k = 0; at < n; k++) orgOf[at++] = 11 + (k % 190);
  shuffle(orgOf, rnd);

  const sizes = MSG_BUCKETS.map((b) => Math.floor(n * b.frac));
  sizes[0] += n - sizes.reduce((s, x) => s + x, 0);

  const msgCount = new Uint8Array(n);
  at = 0;
  for (let b = 0; b < MSG_BUCKETS.length; b++) {
    for (let k = 0; k < sizes[b]; k++) msgCount[at++] = MSG_BUCKETS[b].count;
  }
  shuffle(msgCount, rnd);

  const CLOSE_RATE = 15;
  const OPEN_AT_ZERO = 0.73;
  const closed = new Uint8Array(n);
  const updated = new Float64Array(n);
  let messages = 0;
  for (let i = 0; i < n; i++) {
    const ageFrac = (NOW - created[i]) / WINDOW_MS;
    closed[i] =
      rnd() < 1 - OPEN_AT_ZERO * Math.exp(-ageFrac * CLOSE_RATE) ? 1 : 0;
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

  const tagCountRnd = mulberry32(SEED + 8);
  const tagSizes = TAG_BUCKETS.map((b) => Math.floor(n * b.frac));
  tagSizes[0] += n - tagSizes.reduce((s, x) => s + x, 0);
  const numTags = new Uint8Array(n);
  at = 0;
  for (let b = 0; b < TAG_BUCKETS.length; b++) {
    for (let k = 0; k < tagSizes[b]; k++) numTags[at++] = TAG_BUCKETS[b].count;
  }
  shuffle(numTags, tagCountRnd);
  const conversationTags = numTags.reduce((sum, x) => sum + x, 0);

  return {
    created,
    updated,
    orgOf,
    msgCount,
    closed,
    messages,
    numTags,
    conversationTags,
  };
}

function* conversationLines(
  plan: ConversationPlan,
  memStart: Int32Array,
  memCount: Int32Array,
  uuidBuf: Buffer,
): Generator<string> {
  const rnd = mulberry32(SEED + 3);
  const { created, updated, orgOf, closed } = plan;
  const batch: string[] = [];
  for (let i = 0; i < CONVERSATIONS; i++) {
    const org = orgOf[i];
    writeUuid(uuidBuf, i * 16, created[i], rnd);
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

function* messageLines(
  plan: ConversationPlan,
  uuidBuf: Buffer,
  corpus: Corpus,
): Generator<string> {
  const rnd = mulberry32(SEED + 5);
  const { created, updated, orgOf, msgCount, closed } = plan;
  const batch: string[] = [];
  let id = 1;
  for (let i = 0; i < CONVERSATIONS; i++) {
    const count = msgCount[i];
    const org = orgOf[i];
    const isClosed = closed[i] === 1;
    const convId = uuidHex(uuidBuf, i * 16);
    const start = created[i];
    const span = updated[i] - start;

    for (let k = 0; k < count; k++) {
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

function* conversationTagLines(
  plan: ConversationPlan,
  structure: Structure,
  uuidBuf: Buffer,
): Generator<string> {
  const rnd = mulberry32(SEED + 9);
  const { orgOf, numTags, created } = plan;
  const { tagStart, tagCount } = structure;
  const batch: string[] = [];
  const picked = new Int32Array(3);

  for (let i = 0; i < CONVERSATIONS; i++) {
    const need = numTags[i];
    if (need === 0) continue;

    const org = orgOf[i];
    const size = tagCount[org];
    const start = tagStart[org];
    const convId = uuidHex(uuidBuf, i * 16);
    const at = stamp(created[i]);

    for (let k = 0; k < need; k++) {
      let offset;
      let dup;
      do {
        offset = (rnd() * size) | 0;
        dup = false;
        for (let m = 0; m < k; m++) {
          if (picked[m] === offset) {
            dup = true;
            break;
          }
        }
      } while (dup);
      picked[k] = offset;
      batch.push(`${convId}\t${start + offset}\t${org}\t${at}`);
    }

    if (batch.length >= COPY_BATCH) {
      yield batch.join('\n') + '\n';
      batch.length = 0;
    }
  }
  if (batch.length) yield batch.join('\n') + '\n';
}

const client = new pg.Client({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER ?? 'postgres',
  password: process.env.POSTGRES_PASSWORD ?? 'postgres',
  database: process.env.POSTGRES_DB ?? 'postgres',
});

async function copyInto(sql: string, iterator: Iterable<string>) {
  await pipeline(Readable.from(iterator), client.query(copyFrom(sql)));
}

const SECONDARY_INDEXES: [name: string, sql: string][] = [
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
  [
    'messages_org_tsv_idx',
    'CREATE INDEX messages_org_tsv_idx ON messages USING gin (org_id, tsv)',
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

  await client.query(`SET maintenance_work_mem = '512MB'`);
  await client.query('SET synchronous_commit = off');

  await client.query('BEGIN');

  await phase('truncate', async () => {
    await client.query(
      'TRUNCATE messages, conversations, memberships, users, organizations, ' +
        'tags, conversation_tags RESTART IDENTITY',
    );
  });

  await phase('drop secondary indexes', async () => {
    for (const [name] of SECONDARY_INDEXES)
      await client.query(`DROP INDEX ${name}`);
  });

  await phase('drop messages FK', () =>
    client.query(
      'ALTER TABLE messages DROP CONSTRAINT messages_conversation_id_fkey',
    ),
  );

  await phase('drop conversation_tags FK', () =>
    client.query(
      'ALTER TABLE conversation_tags ' +
        'DROP CONSTRAINT conversation_tags_conversation_id_fkey',
    ),
  );

  const small: [
    name: string,
    rows: { length: number },
    columns: string,
    format: (row: never) => string,
  ][] = [
    [
      'organizations',
      structure.orgs,
      '(id, name, plan, created_at, updated_at)',
      (o: Structure['orgs'][number]) =>
        `${o.id}\t${o.name}\t${o.plan}\t${stamp(o.created)}\t${stamp(o.created)}`,
    ],
    [
      'users',
      structure.users,
      '(id, name, created_at, updated_at)',
      (u: Structure['users'][number]) =>
        `${u.id}\t${u.name}\t${stamp(u.created)}\t${stamp(u.created)}`,
    ],
    [
      'memberships',
      structure.memberships,
      '(id, user_id, org_id, role, created_at, updated_at)',
      (m: Structure['memberships'][number]) =>
        `${m.id}\t${m.userId}\t${m.orgId}\t${m.role}\t${stamp(m.created)}\t${stamp(m.created)}`,
    ],
    [
      'tags',
      structure.tags,
      '(id, org_id, name, created_at, updated_at)',
      (t: Structure['tags'][number]) =>
        `${t.id}\t${t.orgId}\t${t.name}\t${stamp(t.created)}\t${stamp(t.created)}`,
    ],
  ];

  for (const [name, rows, columns, format] of small) {
    await phase(
      `copy ${name}`,
      () =>
        copyInto(`COPY ${name} ${columns} FROM STDIN`, [
          (rows as never[]).map(format).join('\n') + '\n',
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

  await phase(
    'copy conversation_tags',
    () =>
      copyInto(
        'COPY conversation_tags (conversation_id, tag_id, org_id, created_at) FROM STDIN',
        conversationTagLines(plan, structure, uuidBuf),
      ),
    plan.conversationTags,
  );

  for (const [name, sql] of SECONDARY_INDEXES) {
    await phase(`build ${name.replace(/_idx$/, '')}`, () => client.query(sql));
  }

  await phase('re-add messages FK', async () => {
    await client.query(
      'ALTER TABLE messages ADD CONSTRAINT messages_conversation_id_fkey ' +
        'FOREIGN KEY (conversation_id) REFERENCES conversations (id) NOT VALID',
    );
    await client.query(
      'ALTER TABLE messages VALIDATE CONSTRAINT messages_conversation_id_fkey',
    );
  });

  await phase('re-add conversation_tags FK', async () => {
    await client.query(
      'ALTER TABLE conversation_tags ' +
        'ADD CONSTRAINT conversation_tags_conversation_id_fkey ' +
        'FOREIGN KEY (conversation_id) REFERENCES conversations (id) NOT VALID',
    );
    await client.query(
      'ALTER TABLE conversation_tags ' +
        'VALIDATE CONSTRAINT conversation_tags_conversation_id_fkey',
    );
  });

  await phase('setval sequences', async () => {
    await client.query(`SELECT setval('organizations_id_seq', $1)`, [ORGS]);
    await client.query(`SELECT setval('users_id_seq', $1)`, [USERS]);
    await client.query(`SELECT setval('memberships_id_seq', $1)`, [
      structure.memberships.length,
    ]);
    await client.query(`SELECT setval('messages_id_seq', $1)`, [plan.messages]);
    await client.query(`SELECT setval('tags_id_seq', $1)`, [
      structure.tags.length,
    ]);
  });

  await phase('commit', () => client.query('COMMIT'));

  await phase('analyze', () => client.query('ANALYZE'));

  const total = ms(process.hrtime.bigint() - startedAll) / 1000;
  console.log(`\n  ${'TOTAL'.padEnd(28)} ${total.toFixed(2).padStart(7)}s`);
  console.log(
    `  ${plan.messages.toLocaleString()} messages, ${CONVERSATIONS.toLocaleString()} conversations, ` +
      `${structure.memberships.length.toLocaleString()} memberships, ` +
      `${structure.tags.length.toLocaleString()} tags, ` +
      `${plan.conversationTags.toLocaleString()} conversation_tags\n`,
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
