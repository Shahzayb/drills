import type { ExplainResult, PlanNode } from './lib/run.mts';
import {
  client as pgClient,
  header,
  knob,
  knobList,
  record,
} from './lib/run.mts';

const subcommand = process.argv[2];
const USAGE =
  'usage: node db/explain.mts <plans|sweep|experiments|stats|keyset>';

if (
  !['plans', 'sweep', 'experiments', 'stats', 'keyset'].includes(subcommand)
) {
  console.error(USAGE);
  process.exit(1);
}

const APP_USER = process.env.POSTGRES_APP_USER;

if (!APP_USER) {
  console.error('POSTGRES_APP_USER must be set');
  process.exit(1);
}

const client = pgClient();

const ORG_ID = knob('ORG_ID', '1');
const STATUS = knob('STATUS', 'closed');
const SORT = knob(
  'SORT',
  subcommand === 'keyset' ? 'updated_at' : 'created_at',
);
const DAYS = knobList('DAYS', '548,365,270,180,120,90,60,45,30,21,14,7,3,1');
const DEPTHS = knobList('DEPTHS', '1,100,5000');
const INDEX_NAME = 'conversations_org_updated_idx';
const PAGE_SIZE = 50;

const listQuery = (sortColumn: string) => `
  SELECT c.id, c.status, c.assignee_id, u.name AS assignee_name,
         c.created_at, c.updated_at
    FROM conversations c
    LEFT JOIN memberships m ON m.id = c.assignee_id
    LEFT JOIN users u       ON u.id = m.user_id
   WHERE c.org_id = $1 AND c.status = $2 AND c.updated_at >= $3::timestamptz
   ORDER BY c.${sortColumn} DESC, c.id DESC
   LIMIT ${PAGE_SIZE} OFFSET 0`;

const unfilteredQuery = `
  SELECT c.id, c.status, c.assignee_id, u.name AS assignee_name,
         c.created_at, c.updated_at
    FROM conversations c
    LEFT JOIN memberships m ON m.id = c.assignee_id
    LEFT JOIN users u       ON u.id = m.user_id
   WHERE c.org_id = $1
   ORDER BY c.updated_at DESC, c.id DESC
   LIMIT ${PAGE_SIZE} OFFSET 0`;

function findScan(node: PlanNode): PlanNode | null {
  if (node['Relation Name'] === 'conversations') return node;
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

async function explainText(label: string, sql: string, params: unknown[]) {
  const { rows } = await client.query(
    `EXPLAIN (ANALYZE, BUFFERS) ${sql}`,
    params,
  );
  console.log(`\n--- ${label} ${'-'.repeat(Math.max(0, 68 - label.length))}`);
  for (const row of rows) console.log(row['QUERY PLAN']);
}

async function anchor(): Promise<Date> {
  const { rows } = await client.query(
    `SELECT max(updated_at) AS at FROM conversations WHERE org_id = $1`,
    [ORG_ID],
  );
  return rows[0].at;
}

const daysBefore = (at: Date, days: number) =>
  new Date(at.getTime() - days * 86_400_000).toISOString();

async function countRows(status: string, cutoff: string) {
  const { rows } = await client.query(
    `SELECT count(*) AS n FROM conversations
      WHERE org_id = $1 AND status = $2 AND updated_at >= $3::timestamptz`,
    [ORG_ID, status, cutoff],
  );
  return Number(rows[0].n);
}

async function openScope() {
  await client.query('BEGIN');
  await client.query(`SET LOCAL ROLE ${APP_USER}`);
  await client.query('SELECT set_config($1, $2, true)', ['app.org_id', ORG_ID]);
}

async function withoutIndex(fn: () => Promise<void>) {
  await client.query('SAVEPOINT no_index');
  try {
    await client.query('SET LOCAL ROLE NONE');
    await client.query(`DROP INDEX ${INDEX_NAME}`);
    await client.query(`SET LOCAL ROLE ${APP_USER}`);
    await fn();
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT no_index');
  }
}

async function withIndex(
  name: string,
  definition: string,
  fn: (size: { size: string; bytes: string }) => Promise<void>,
) {
  await client.query('SAVEPOINT trial');
  try {
    await client.query('SET LOCAL ROLE NONE');
    await client.query(`CREATE INDEX ${name} ON conversations ${definition}`);
    const { rows } = await client.query(
      `SELECT pg_size_pretty(pg_relation_size($1::regclass)) AS size,
              pg_relation_size($1::regclass) AS bytes`,
      [name],
    );
    await client.query(`SET LOCAL ROLE ${APP_USER}`);
    await fn(rows[0]);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT trial');
  }
}

async function plans() {
  await openScope();

  const at = await anchor();
  const wide = daysBefore(at, 548);
  const recent = daysBefore(at, 7);

  const indexed = await hasIndex();
  console.log(`org ${ORG_ID}  newest updated_at ${at.toISOString()}`);
  console.log(`${INDEX_NAME}: ${indexed ? 'present' : 'ABSENT'}`);

  const openWide = await countRows('open', wide);
  const openRecent = await countRows('open', recent);
  const closedWide = await countRows('closed', wide);
  const total = openWide + closedWide;
  console.log(
    `org rows ${total.toLocaleString()}  ` +
      `open/wide ${openWide.toLocaleString()}  ` +
      `open/7d ${openRecent.toLocaleString()}  ` +
      `closed/wide ${closedWide.toLocaleString()}`,
  );

  const capture = async () => {
    await explainText(
      'B  index scan  (status=open, last 7 days, sort=updated_at)',
      listQuery('updated_at'),
      [ORG_ID, 'open', recent],
    );

    await explainText(
      'C  index ignored?  (status=closed, whole window, sort=created_at)',
      listQuery('created_at'),
      [ORG_ID, 'closed', wide],
    );
  };

  if (indexed) {
    await withoutIndex(async () => {
      await explainText(
        'A  no index  (status=closed, whole window, sort=updated_at)',
        listQuery('updated_at'),
        [ORG_ID, 'closed', wide],
      );
    });
    await capture();
  } else {
    await explainText(
      'A  no index  (status=closed, whole window, sort=updated_at)',
      listQuery('updated_at'),
      [ORG_ID, 'closed', wide],
    );
    console.log('\n(index absent — B and C need the migration applied)');
  }

  await client.query('COMMIT');
}

async function hasIndex() {
  const { rows } = await client.query(
    `SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)`,
    [INDEX_NAME],
  );
  return rows.length > 0 && rows[0].indisvalid;
}

async function sweep() {
  await openScope();

  const status = STATUS;
  const sortColumn = SORT;
  const at = await anchor();

  const { rows: totalRows } = await client.query(
    `SELECT count(*) AS n FROM conversations WHERE org_id = $1`,
    [ORG_ID],
  );
  const orgTotal = Number(totalRows[0].n);

  console.log(
    `org ${ORG_ID}  status=${status}  sort=${sortColumn}  ` +
      `org rows ${orgTotal.toLocaleString()}  anchor ${at.toISOString()}`,
  );
  console.log(
    '\n  cutoff       matching   of org   of table  node                      ' +
      'est rows   act rows      ms   shared hit/read',
  );

  await openScope();

  const ladder = DAYS;

  const sql = listQuery(sortColumn);
  for (const days of ladder) {
    const cutoff = daysBefore(at, days);
    const matching = await countRows(status, cutoff);
    const plan = await explainJson(sql, [ORG_ID, status, cutoff]);
    const scan = findScan(plan.Plan) ?? plan.Plan;

    const row = [
      `${String(days).padStart(4)}d back`.padEnd(12),
      matching.toLocaleString().padStart(9),
      `${((matching / orgTotal) * 100).toFixed(1)}%`.padStart(7),
      `${((matching / 2_500_000) * 100).toFixed(1)}%`.padStart(9),
      `  ${scan['Node Type']}`.padEnd(26),
      String(Math.round(scan['Plan Rows'])).padStart(9),
      String(scan['Actual Rows']).padStart(10),
      plan['Execution Time'].toFixed(1).padStart(8),
      `   ${scan['Shared Hit Blocks']}/${scan['Shared Read Blocks']}`,
    ];
    console.log('  ' + row.join(' '));
  }

  await client.query('COMMIT');
}

async function experiments() {
  await openScope();

  const at = await anchor();
  const wide = daysBefore(at, 548);
  const recent = daysBefore(at, 7);

  const summarise = async (label: string, sql: string, params: unknown[]) => {
    const plan = await explainJson(sql, params);
    const scan = findScan(plan.Plan) ?? plan.Plan;
    console.log(
      `    ${label.padEnd(42)} ${scan['Node Type'].padEnd(18)} ` +
        `${plan['Execution Time'].toFixed(2).padStart(8)} ms  ` +
        `buffers ${scan['Shared Hit Blocks']}/${scan['Shared Read Blocks']}`,
    );
  };

  const arms = async () => {
    await summarise('filtered   status=open, 7d, sort=updated_at', listQuery('updated_at'), [ORG_ID, 'open', recent]); // prettier-ignore
    await summarise('filtered   status=closed, wide, sort=updated_at', listQuery('updated_at'), [ORG_ID, 'closed', wide]); // prettier-ignore
    await summarise('unfiltered no status, sort=updated_at', unfilteredQuery, [ORG_ID]); // prettier-ignore
  };

  console.log('\n  shipped     (org_id, updated_at DESC, id DESC)');
  await arms();

  await withoutIndex(async () => {
    console.log('\n  none        (index dropped)');
    await arms();

    await withIndex(
      'trial_with_status_idx',
      '(org_id, status, updated_at DESC, id DESC)',
      async (size) => {
        console.log(`\n  with-status (org_id, status, updated_at DESC, id DESC)  ${size.size}`); // prettier-ignore
        await arms();
      },
    );

    await withIndex(
      'trial_swapped_idx',
      '(status, org_id, updated_at DESC, id DESC)',
      async (size) => {
        console.log(`\n  swapped     (status, org_id, updated_at DESC, id DESC)  ${size.size}`); // prettier-ignore
        await arms();
      },
    );

    await withIndex(
      'trial_partial_idx',
      "(org_id, updated_at DESC, id DESC) WHERE status = 'open'",
      async (size) => {
        console.log(`\n  partial     (org_id, updated_at DESC, id DESC) WHERE status='open'  ${size.size}`); // prettier-ignore
        await arms();
      },
    );
  });

  await client.query('COMMIT');
}

async function stats() {
  const { rows: columns } = await client.query(`
    SELECT attname, n_distinct,
           most_common_vals::text AS common_vals,
           (SELECT array_agg(round(f::numeric, 4))
              FROM unnest(most_common_freqs) AS f)::text AS common_freqs,
           round(correlation::numeric, 4) AS correlation
      FROM pg_stats
     WHERE schemaname = 'public' AND tablename = 'conversations'
       AND attname IN ('org_id', 'status', 'updated_at', 'created_at')
     ORDER BY attname
  `);
  console.log('pg_stats — conversations\n');
  for (const c of columns) {
    console.log(`  ${c.attname}`);
    console.log(`    n_distinct   ${c.n_distinct}`);
    console.log(`    correlation  ${c.correlation}`);
    if (c.common_vals) {
      console.log(`    mcv          ${c.common_vals}`);
      console.log(`    mcf          ${c.common_freqs}`);
    }
  }

  const { rows: indexes } = await client.query(`
    SELECT i.indexrelid::regclass::text AS name,
           i.indisvalid,
           pg_size_pretty(pg_relation_size(i.indexrelid)) AS size,
           pg_relation_size(i.indexrelid) AS bytes,
           pg_get_indexdef(i.indexrelid) AS def
      FROM pg_index i
     WHERE i.indrelid = 'conversations'::regclass
     ORDER BY pg_relation_size(i.indexrelid) DESC
  `);
  const { rows: heap } = await client.query(
    `SELECT pg_size_pretty(pg_relation_size('conversations')) AS size,
            pg_relation_size('conversations') AS bytes`,
  );

  console.log(`\nheap  ${heap[0].size}\n`);
  console.log('indexes on conversations\n');
  for (const idx of indexes) {
    const share = ((Number(idx.bytes) / Number(heap[0].bytes)) * 100).toFixed(
      1,
    );
    console.log(
      `  ${idx.size.padStart(8)}  ${String(share).padStart(5)}% of heap  ` +
        `${idx.indisvalid ? '  valid' : 'INVALID'}  ${idx.name}`,
    );
    console.log(`            ${idx.def}`);
  }
}

const keysetQuery = (sortColumn: string) => `
  SELECT c.id, c.status, c.assignee_id, u.name AS assignee_name,
         c.created_at, c.updated_at
    FROM conversations c
    LEFT JOIN memberships m ON m.id = c.assignee_id
    LEFT JOIN users u       ON u.id = m.user_id
   WHERE c.org_id = $1 AND (c.${sortColumn}, c.id) < ($2::timestamptz, $3::uuid)
   ORDER BY c.${sortColumn} DESC, c.id DESC
   LIMIT ${PAGE_SIZE}`;

const keysetOrQuery = (sortColumn: string) => `
  SELECT c.id, c.status, c.assignee_id, u.name AS assignee_name,
         c.created_at, c.updated_at
    FROM conversations c
    LEFT JOIN memberships m ON m.id = c.assignee_id
    LEFT JOIN users u       ON u.id = m.user_id
   WHERE c.org_id = $1
     AND (c.${sortColumn} < $2::timestamptz
          OR (c.${sortColumn} = $2::timestamptz AND c.id < $3::uuid))
   ORDER BY c.${sortColumn} DESC, c.id DESC
   LIMIT ${PAGE_SIZE}`;

const offsetQuery = (sortColumn: string, offset: number) => `
  SELECT c.id, c.status, c.assignee_id, u.name AS assignee_name,
         c.created_at, c.updated_at
    FROM conversations c
    LEFT JOIN memberships m ON m.id = c.assignee_id
    LEFT JOIN users u       ON u.id = m.user_id
   WHERE c.org_id = $1
   ORDER BY c.${sortColumn} DESC, c.id DESC
   LIMIT ${PAGE_SIZE} OFFSET ${offset}`;

async function cursorAt(sortColumn: string, depth: number) {
  const { rows } = await client.query(
    `SELECT to_char(${sortColumn} AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS k, id
       FROM conversations
      WHERE org_id = $1
      ORDER BY ${sortColumn} DESC, id DESC
      LIMIT 1 OFFSET ${(depth - 1) * PAGE_SIZE}`,
    [ORG_ID],
  );
  return rows[0];
}

async function keyset() {
  await openScope();

  const sortColumn = SORT;
  const depths = DEPTHS;

  console.log(
    `org ${ORG_ID}  sort=${sortColumn}  pageSize=${PAGE_SIZE}  ` +
      `index ${(await hasIndex()) ? 'present' : 'ABSENT'}`,
  );
  console.log(
    '\n  depth      arm            node                       ' +
      'rows below Limit      ms   shared hit/read',
  );

  const belowLimit = (plan: ExplainResult) => {
    const limit = (function find(node: PlanNode): PlanNode | null {
      if (node['Node Type'] === 'Limit') return node;
      for (const child of node.Plans ?? []) {
        const found = find(child);
        if (found) return found;
      }
      return null;
    })(plan.Plan);
    const child = limit?.Plans?.[0] ?? plan.Plan;
    return child['Actual Rows'] * (child['Actual Loops'] ?? 1);
  };

  const row = async (
    depth: number,
    arm: string,
    sql: string,
    params: unknown[],
  ) => {
    const plan = await explainJson(sql, params);
    const scan = findScan(plan.Plan) ?? plan.Plan;
    console.log(
      `  ${String(depth).padStart(5)}      ${arm.padEnd(14)} ` +
        `${scan['Node Type'].padEnd(26)} ${String(belowLimit(plan)).padStart(10)}` +
        `      ${plan['Execution Time'].toFixed(2).padStart(8)}   ` +
        `${scan['Shared Hit Blocks']}/${scan['Shared Read Blocks']}`,
    );
  };

  for (const depth of depths) {
    const at = await cursorAt(sortColumn, depth);
    await row(depth, 'offset', offsetQuery(sortColumn, (depth - 1) * PAGE_SIZE), [ORG_ID]); // prettier-ignore
    await row(depth, 'keyset row', keysetQuery(sortColumn), [ORG_ID, at.k, at.id]); // prettier-ignore
    await row(depth, 'keyset OR', keysetOrQuery(sortColumn), [ORG_ID, at.k, at.id]); // prettier-ignore
  }

  const at = await cursorAt(sortColumn, 100);
  await explainText(
    'row comparison — is it an Index Cond?',
    keysetQuery(sortColumn),
    [ORG_ID, at.k, at.id],
  );
  await explainText('the OR form, same position', keysetOrQuery(sortColumn), [
    ORG_ID,
    at.k,
    at.id,
  ]);

  await client.query('COMMIT');
}

header(`explain ${subcommand}`);

await client.connect();
try {
  if (subcommand === 'plans') await plans();
  else if (subcommand === 'sweep') await sweep();
  else if (subcommand === 'experiments') await experiments();
  else if (subcommand === 'keyset') await keyset();
  else await stats();
} finally {
  await client.end();
}

record('explain', subcommand, {});
