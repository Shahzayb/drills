import {
  client as pgClient,
  header,
  knob,
  knobList,
  knobNumber,
  median,
  record,
  serverArms,
} from './lib/run.mts';

const subcommand = process.argv[2];
const USAGE = 'usage: node db/paging.mts <depths|walk|concurrent>';

if (!['depths', 'walk', 'concurrent'].includes(subcommand)) {
  console.error(USAGE);
  process.exit(1);
}

const API = process.env.BACKEND_INTERNAL_URL || 'http://nest_server:3002';
const ORG_ID = knob('ORG_ID', '1');
const PAGE_SIZE = knobNumber('PAGE_SIZE', 50);
const ROUNDS = knobNumber('ROUNDS', 3);
const DEPTHS = knobList('DEPTHS', '1,10,100,1000,5000');
const MAX_PAGES = knobNumber('MAX_PAGES', 400);

interface Page {
  items: { id: string }[];
  nextCursor?: string | null;
  hasMore?: boolean;
}

async function get(params: Record<string, string>) {
  const url = `${API}/conversations?${new URLSearchParams({
    pageSize: String(PAGE_SIZE),
    ...params,
  })}`;

  const startedAt = performance.now();
  const response = await fetch(url, { headers: { 'x-org-id': ORG_ID } });
  const body = (await response.json()) as Page;
  const ms = performance.now() - startedAt;

  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(body)}`);
  }
  return { body, ms };
}

type Extra = Record<string, string>;

const offsetPage = (page: number, extra: Extra = {}) =>
  get({ page: String(page), ...extra });

const keysetPage = (cursor: string | null, extra: Extra = {}) =>
  get({ paging: 'keyset', ...(cursor ? { cursor } : {}), ...extra });

async function keysetAtDepth(depth: number, extra: Extra = {}) {
  let cursor: string | null = null;
  let last: Awaited<ReturnType<typeof get>> | null = null;
  for (let page = 1; page <= depth; page++) {
    last = await keysetPage(cursor, extra);
    cursor = last.body.nextCursor ?? null;
    if (!cursor && page < depth) return null;
  }
  return last;
}

function bars(rows: { label: string; ms: number }[]) {
  const max = Math.max(...rows.map((r) => Math.log10(Math.max(r.ms, 0.01))));
  const min = Math.log10(0.1);
  console.log('\n  log10 scale — each block is roughly a factor of 1.3\n');
  for (const row of rows) {
    const scaled = (Math.log10(Math.max(row.ms, 0.01)) - min) / (max - min);
    const width = Math.max(1, Math.round(scaled * 46));
    console.log(
      `  ${row.label.padEnd(18)} ${'█'.repeat(width).padEnd(48)}` +
        `${row.ms.toFixed(2).padStart(9)} ms`,
    );
  }
}

async function depths() {
  const results = new Map<number, { offset: number[]; keyset: number[] }>();
  for (const depth of DEPTHS) results.set(depth, { offset: [], keyset: [] });

  for (let round = 1; round <= ROUNDS; round++) {
    for (const depth of DEPTHS) {
      const cell = results.get(depth)!;

      const offset = await offsetPage(depth).catch(() => null);
      if (offset) cell.offset.push(offset.ms);

      const keyset = await keysetAtDepth(depth).catch(() => null);
      if (keyset) cell.keyset.push(keyset.ms);

      process.stderr.write(`  round ${round} depth ${depth} done\n`);
    }
  }

  console.log('  depth      row       offset ms    keyset ms   offset/keyset');
  const csv = ['depth,rows_skipped,offset_ms,keyset_ms'];
  const chart: { label: string; ms: number }[] = [];
  const table = [];
  for (const depth of DEPTHS) {
    const cell = results.get(depth)!;
    if (!cell.offset.length || !cell.keyset.length) {
      console.log(
        `  ${String(depth).padStart(5)}      (past the end of the org)`,
      );
      continue;
    }
    const o = median(cell.offset);
    const k = median(cell.keyset);
    const skipped = (depth - 1) * PAGE_SIZE;
    console.log(
      `  ${String(depth).padStart(5)}  ${skipped.toLocaleString().padStart(9)}   ` +
        `${o.toFixed(2).padStart(10)}   ${k.toFixed(2).padStart(10)}   ` +
        `${(o / k).toFixed(1).padStart(8)}x`,
    );
    csv.push(`${depth},${skipped},${o.toFixed(2)},${k.toFixed(2)}`);
    table.push({ depth, rowsSkipped: skipped, offsetMs: o, keysetMs: k });
    chart.push({ label: `offset p${depth}`, ms: o });
    chart.push({ label: `keyset p${depth}`, ms: k });
  }

  bars(chart);
  console.log('\n' + csv.join('\n'));
  return table;
}

async function walk() {
  const arms: Record<string, { ms: number; pages: number; rows: number }> = {};

  {
    const startedAt = performance.now();
    let rows = 0;
    let page = 1;
    for (; page <= MAX_PAGES; page++) {
      const { body } = await offsetPage(page);
      rows += body.items.length;
      if (body.items.length < PAGE_SIZE) break;
    }
    arms.offset = { ms: performance.now() - startedAt, pages: page, rows };
  }

  {
    const startedAt = performance.now();
    let rows = 0;
    let cursor: string | null = null;
    let page = 1;
    for (; page <= MAX_PAGES; page++) {
      const { body } = await keysetPage(cursor);
      rows += body.items.length;
      cursor = body.nextCursor ?? null;
      if (!body.hasMore) break;
    }
    arms.keyset = { ms: performance.now() - startedAt, pages: page, rows };
  }

  console.log('  arm       pages      rows        total       per page');
  for (const [name, arm] of Object.entries(arms)) {
    console.log(
      `  ${name.padEnd(9)} ${String(arm.pages).padStart(5)} ` +
        `${arm.rows.toLocaleString().padStart(9)}  ` +
        `${(arm.ms / 1000).toFixed(2).padStart(9)} s  ` +
        `${(arm.ms / arm.pages).toFixed(2).padStart(9)} ms`,
    );
  }

  const { rows: total } = await client.query(
    `SELECT count(*) AS n FROM conversations WHERE org_id = $1`,
    [ORG_ID],
  );
  const allPages = Math.ceil(Number(total[0].n) / PAGE_SIZE);
  console.log(
    `\n  org holds ${Number(total[0].n).toLocaleString()} rows = ` +
      `${allPages.toLocaleString()} pages`,
  );
  for (const [name, arm] of Object.entries(arms)) {
    const perPage = arm.ms / arm.pages;
    console.log(
      `  ${name.padEnd(9)} full walk >= ` +
        `${((perPage * allPages) / 60000).toFixed(1)} min ` +
        `(linear from ${arm.pages} pages — a floor for offset, ` +
        `close to exact for keyset)`,
    );
  }

  return arms;
}

async function concurrent() {
  const scratch = await client.query(
    `INSERT INTO organizations (name, plan) VALUES ($1, 'free') RETURNING id`,
    [`paging-concurrent-${Date.now()}`],
  );
  const org = scratch.rows[0].id;

  const seed = await client.query(
    `INSERT INTO conversations (org_id, status, created_at, updated_at)
     SELECT $1::bigint, 'open',
            now() - make_interval(mins => n),
            now() - make_interval(mins => n)
       FROM generate_series(1, 9) AS n
     RETURNING id`,
    [org],
  );

  const previousOrg = process.env.ORG_ID;
  process.env.ORG_ID = String(org);
  const short = (id: string) => id.slice(-6);

  try {
    const headers = { 'x-org-id': String(org) };
    const call = async (params: Record<string, string>): Promise<Page> => {
      const url = `${API}/conversations?${new URLSearchParams({
        pageSize: '3',
        ...params,
      })}`;
      const response = await fetch(url, { headers });
      return response.json() as Promise<Page>;
    };

    const offset1 = await call({ page: '1' });
    const keyset1 = await call({ paging: 'keyset' });
    const cursor = keyset1.nextCursor;
    if (!cursor) {
      throw new Error(`scratch org ${org} returned no cursor on page 1`);
    }

    console.log(`scratch org ${org}, 9 conversations, pageSize=3\n`);
    console.log(`  page 1 (both arms agree)  ${offset1.items.map((i) => short(i.id)).join(' ')}`); // prettier-ignore

    const inserted = await client.query(
      `INSERT INTO conversations (org_id, status, created_at, updated_at)
       VALUES ($1::bigint, 'open', now(), now() + interval '1 hour')
       RETURNING id`,
      [org],
    );
    console.log(`\n  --- a row is inserted at the TOP: ${short(inserted.rows[0].id)}\n`); // prettier-ignore

    const offset2 = await call({ page: '2' });
    const keyset2 = await call({ paging: 'keyset', cursor });

    const seen = new Set(offset1.items.map((i) => i.id));
    const mark = (items: Page['items']) =>
      items
        .map((i) =>
          seen.has(i.id) ? `${short(i.id)} <-- SEEN AGAIN` : short(i.id),
        )
        .join('  ');

    console.log(`  offset page 2   ${mark(offset2.items)}`);
    console.log(`  keyset page 2   ${mark(keyset2.items)}`);
    console.log(
      `\n  offset repeated ${offset2.items.filter((i) => seen.has(i.id)).length} row(s); ` +
        `keyset repeated ${keyset2.items.filter((i) => seen.has(i.id)).length}.`,
    );

    const below = seed.rows[seed.rows.length - 1].id;
    await client.query(
      `UPDATE conversations SET updated_at = now() + interval '2 hours'
        WHERE id = $1`,
      [below],
    );
    console.log(`\n  --- a row still UNREAD (${short(below)}) is updated, jumping above the cursor\n`); // prettier-ignore

    const rest: string[] = [];
    let next: string | null = cursor;
    for (let page = 0; page < 6 && next; page++) {
      const body = await call({ paging: 'keyset', cursor: next });
      rest.push(...body.items.map((i) => i.id));
      next = body.nextCursor ?? null;
    }
    console.log(
      `  keyset pages 2..n now return ${rest.length} rows; ` +
        `${short(below)} is ${rest.includes(below) ? 'present' : 'MISSING — skipped'}.`,
    );
    console.log(
      '\n  Keyset is immune to insert-shift and is NOT immune to a moving sort key.',
    );
  } finally {
    process.env.ORG_ID = previousOrg;
    await client.query(`DELETE FROM conversations WHERE org_id = $1::bigint`, [
      org,
    ]);
    await client.query(`DELETE FROM organizations WHERE id = $1::bigint`, [
      org,
    ]);
  }
}

const client = pgClient();

const armState = await serverArms(API);

header(`paging ${subcommand}  api ${API}`);
if (armState) console.log(`  server arms  ${JSON.stringify(armState)}\n`);

await client.connect();
let rows: unknown = null;
try {
  if (subcommand === 'depths') rows = await depths();
  else if (subcommand === 'walk') rows = await walk();
  else await concurrent();
} finally {
  await client.end();
}

record('paging', subcommand, { rows, arms: armState });
