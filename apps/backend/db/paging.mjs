// Card 10's instrument: what page depth costs, over HTTP, against the endpoint
// a client actually calls.
//
//   pnpm db:paging depths      latency vs page depth, both arms — the chart
//   pnpm db:paging walk        the export tool: cumulative cost of walking pages
//   pnpm db:paging concurrent  a row inserted (and moved) mid-pagination
//
// Why HTTP and not EXPLAIN. `pnpm db:explain keyset` answers "which plan", and
// it is the better instrument for that — no HTTP, no JSON, no noise. This one
// answers "what does the caller feel", which is the question the card asks, and
// includes the two joins, the tag query, RLS's BEGIN/COMMIT and serialisation.
// The two disagree by roughly a millisecond of fixed cost, and that gap is
// itself worth seeing.
//
// Method, inherited from drill 05 and not negotiable:
//   * VACUUM (ANALYZE) first, or the numbers describe a table that has never
//     been vacuumed rather than the query.
//   * Arms INTERLEAVED within each depth, in one sitting. This laptop drifts
//     ~4% slower over 90 minutes; two arms run one after the other are not
//     comparable, two arms run alternately are.
//   * Median of ROUNDS, not mean. One GC pause should not own the number.
//   * Nothing under ~15% is a result.
//
// Full reasoning and the captured output:
// plans/2026-08-26_drill-10-keyset-pagination.md.

import {
  client as pgClient,
  header,
  knob,
  knobList,
  knobNumber,
  median,
  record,
  serverArms,
} from './lib/run.mjs';

const subcommand = process.argv[2];
const USAGE = 'usage: node db/paging.mjs <depths|walk|concurrent>';

if (!['depths', 'walk', 'concurrent'].includes(subcommand)) {
  console.error(USAGE);
  process.exit(1);
}

// `||` and not `??` throughout: the root script forwards these with
// `docker compose exec -e ORG_ID`, and an unset host variable arrives as the
// empty string, not as absent.
const API = process.env.BACKEND_INTERNAL_URL || 'http://nest_server:3002';
const ORG_ID = knob('ORG_ID', '1');
const PAGE_SIZE = knobNumber('PAGE_SIZE', 50);
const ROUNDS = knobNumber('ROUNDS', 3);
// The card's five. Overridable so a slow box can stop at 1000.
const DEPTHS = knobList('DEPTHS', '1,10,100,1000,5000');
// How far `walk` goes before extrapolating. 400 is the card's own example, and
// on the whale the offset arm alone takes minutes past it.
const MAX_PAGES = knobNumber('MAX_PAGES', 400);

// ------------------------------------------------------------------ requests

/** One request, timed the way a client experiences it: connect-to-parsed. */
async function get(params) {
  const url = `${API}/conversations?${new URLSearchParams({
    pageSize: String(PAGE_SIZE),
    ...params,
  })}`;

  const startedAt = performance.now();
  const response = await fetch(url, { headers: { 'x-org-id': ORG_ID } });
  const body = await response.json();
  const ms = performance.now() - startedAt;

  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(body)}`);
  }
  return { body, ms };
}

const offsetPage = (page, extra = {}) => get({ page: String(page), ...extra });

const keysetPage = (cursor, extra = {}) =>
  get({ paging: 'keyset', ...(cursor ? { cursor } : {}), ...extra });

/**
 * Walk the cursor forward to page `depth` and time ONLY the last request.
 *
 * The asymmetry this creates has to be said out loud rather than buried: the
 * offset arm reaches page 5,000 in one request, the keyset arm reaches it in
 * 5,000 — and those 4,999 requests warm exactly the pages the timed one reads.
 * The comparison flatters keyset. It is still the honest comparison, because
 * "jump to page 5,000" is not a thing a keyset client can do at all, and the
 * shape a real client has is precisely this walk. `walk` prices the whole thing
 * instead of one request, which is the number that actually matters for an
 * export.
 */
async function keysetAtDepth(depth, extra = {}) {
  let cursor = null;
  let last = null;
  for (let page = 1; page <= depth; page++) {
    last = await keysetPage(cursor, extra);
    cursor = last.body.nextCursor;
    if (!cursor && page < depth) return null; // the org is shorter than that
  }
  return last;
}

// ------------------------------------------------------------------ reporting

/** Log-scaled, because a linear bar chart of 0.3ms next to 900ms is one bar
 *  and one invisible line. The linear version is the one in the plan file —
 *  there the flatness IS the picture; here you want to read both numbers. */
function bars(rows) {
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

// --------------------------------------------------------------------- depths

async function depths() {
  const results = new Map();
  for (const depth of DEPTHS) results.set(depth, { offset: [], keyset: [] });

  // Interleaved: both arms of a depth in the same few seconds, then the next
  // depth. Rounds on the outside so a slow minute lands on every cell, not on
  // the arm that happened to run during it.
  for (let round = 1; round <= ROUNDS; round++) {
    for (const depth of DEPTHS) {
      const cell = results.get(depth);

      const offset = await offsetPage(depth).catch(() => null);
      if (offset) cell.offset.push(offset.ms);

      const keyset = await keysetAtDepth(depth).catch(() => null);
      if (keyset) cell.keyset.push(keyset.ms);

      process.stderr.write(`  round ${round} depth ${depth} done\n`);
    }
  }

  console.log('  depth      row       offset ms    keyset ms   offset/keyset');
  const csv = ['depth,rows_skipped,offset_ms,keyset_ms'];
  const chart = [];
  const table = [];
  for (const depth of DEPTHS) {
    const cell = results.get(depth);
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

// ----------------------------------------------------------------------- walk

/**
 * The export tool. Not "how slow is one deep page" but "how long does reading
 * the whole list take", which is the cost nobody is watching.
 */
async function walk() {
  const arms = {};

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
    let cursor = null;
    let page = 1;
    for (; page <= MAX_PAGES; page++) {
      const { body } = await keysetPage(cursor);
      rows += body.items.length;
      cursor = body.nextCursor;
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

  // The extrapolation is labelled as one. Offset's per-page cost grows with
  // depth, so a linear projection from the first N pages is a LOWER bound —
  // the real number is worse, and saying so is the point.
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

// ----------------------------------------------------------------- concurrent

/**
 * The card's last question, shown rather than argued.
 *
 * Two mutations, because they break differently:
 *
 *   insert at the top   — every later row shifts down one *position*. OFFSET
 *                         counts positions, so page 2 repeats the last row of
 *                         page 1. The cursor names a row, so it does not.
 *   move a row upward   — a row already read gets a newer updated_at and jumps
 *                         above the cursor. NEITHER arm sees it twice; both
 *                         show it once, at its old place. But a row moved the
 *                         other way — from above the cursor to below it — is
 *                         skipped by keyset, and that is keyset's own anomaly.
 *                         `updated_at` here is bumped by every status change,
 *                         so this is a real failure mode, not a thought
 *                         experiment.
 */
async function concurrent() {
  const scratch = await client.query(
    `INSERT INTO organizations (name, plan) VALUES ($1, 'free') RETURNING id`,
    [`paging-concurrent-${Date.now()}`],
  );
  const org = scratch.rows[0].id;

  // Runs as the owner, which RLS does not apply to — the same reason
  // db/seed.mjs can write across tenants. See migration 003.
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
  process.env.ORG_ID = org;
  const short = (id) => id.slice(-6);

  try {
    const headers = { 'x-org-id': String(org) };
    const call = async (params) => {
      const url = `${API}/conversations?${new URLSearchParams({
        pageSize: '3',
        ...params,
      })}`;
      const response = await fetch(url, { headers });
      return response.json();
    };

    const offset1 = await call({ page: '1' });
    const keyset1 = await call({ paging: 'keyset' });
    const cursor = keyset1.nextCursor;

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
    const mark = (items) =>
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

    // Now keyset's own anomaly: a row BELOW the cursor is touched, which moves
    // it above the cursor. Both arms lose it — offset by shifting, keyset by
    // the predicate. This is the honest half.
    const below = seed.rows[seed.rows.length - 1].id;
    await client.query(
      `UPDATE conversations SET updated_at = now() + interval '2 hours'
        WHERE id = $1`,
      [below],
    );
    console.log(`\n  --- a row still UNREAD (${short(below)}) is updated, jumping above the cursor\n`); // prettier-ignore

    const rest = [];
    let next = cursor;
    for (let page = 0; page < 6 && next; page++) {
      const body = await call({ paging: 'keyset', cursor: next });
      rest.push(...body.items.map((i) => i.id));
      next = body.nextCursor;
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

// --------------------------------------------------------------------- main

const client = pgClient();

// Before the first measurement, so a stale container is visible up front, and
// outside every timed region.
const armState = await serverArms(API);

header(`paging ${subcommand}  api ${API}`);
if (armState) console.log(`  server arms  ${JSON.stringify(armState)}\n`);

await client.connect();
let rows = null;
try {
  if (subcommand === 'depths') rows = await depths();
  else if (subcommand === 'walk') rows = await walk();
  else await concurrent();
} finally {
  await client.end();
}

record('paging', subcommand, { rows, arms: armState });
