// Card 09's instrument: EXPLAIN (ANALYZE, BUFFERS) on the list query, and the
// selectivity sweep that finds where the planner stops using the index.
//
//   pnpm db:explain plans     three captures: seq scan, index scan, index ignored
//   pnpm db:explain sweep     walk the date cutoff, print the chosen scan node
//   pnpm db:explain experiments  price the two indexes that were NOT shipped
//   pnpm db:explain stats     pg_stats for the filtered columns + index sizes
//   pnpm db:explain keyset    card 10: OFFSET at depth vs the cursor's row comparison
//
// Two things here are load-bearing and neither is obvious.
//
// 1. It connects as POSTGRES_APP_USER inside a `BEGIN` + `set_config` scope —
//    the same scope TenantDb.withOrg opens. As the owner, row-level security
//    does not apply and the plan you read is not the plan production runs. It
//    also means the query carries `org_id = $1` AND the policy's
//    `org_id = app_current_org()`: two predicates on one column, which is worth
//    watching in the row estimates.
//
// 2. The queries go through bind parameters, not string interpolation, because
//    that is how the application sends them. A one-shot unnamed statement
//    always gets a *custom* plan (generic plans need a named prepared statement
//    executed five times), so this is faithful and not a rehearsal.
//
// Full reasoning and the captured output: plans/2026-08-25_drill-09-index-selectivity.md.

import pg from 'pg';

const subcommand = process.argv[2];
const USAGE =
  'usage: node db/explain.mjs <plans|sweep|experiments|stats|keyset>';

if (
  !['plans', 'sweep', 'experiments', 'stats', 'keyset'].includes(subcommand)
) {
  console.error(USAGE);
  process.exit(1);
}

// Connects as the OWNER and then drops into the app role per transaction with
// `SET LOCAL ROLE`. Both halves are needed and neither is optional:
//
//   * the owner, because this script does DDL — building and dropping indexes
//     to compare them — and the app role owns nothing. It is also the only role
//     that can see `conversations` in **pg_stats**: that view hides every row
//     for an RLS-enabled table from non-owners, with no error, just an empty
//     result. Found the hard way.
//   * the app role, because RLS does not apply to a table's owner or to a
//     superuser. Measured as `postgres`, every plan here would be missing the
//     policy predicate the application actually runs with.
//
// `SET LOCAL ROLE` is transactional: it reverts at COMMIT/ROLLBACK, and at
// ROLLBACK TO SAVEPOINT it reverts to whatever was in effect at the savepoint.
const APP_USER = process.env.POSTGRES_APP_USER;

if (!APP_USER) {
  console.error('POSTGRES_APP_USER must be set');
  process.exit(1);
}

const client = new pg.Client({
  host: process.env.POSTGRES_HOST ?? 'localhost',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
});

// `||`, not `??`. The root script forwards these with `docker compose exec -e
// ORG_ID`, and an unset host variable arrives inside the container as the empty
// string rather than as absent — `??` would keep it and every query would run
// for org ''. Before the -e flags existed the variable never arrived at all:
// `ORG_ID=150 pnpm db:explain plans` silently measured org 1 for the whole of
// drill 09. A knob that quietly does nothing, again.
const ORG_ID = process.env.ORG_ID || '1';
const INDEX_NAME = 'conversations_org_updated_idx';
const PAGE_SIZE = 50;

// ---------------------------------------------------------------- the query

/**
 * The batched list query, verbatim from ConversationsService.listBatched —
 * joins included. Measuring a simplified version of the query would measure a
 * query nobody runs.
 */
const listQuery = (sortColumn) => `
  SELECT c.id, c.status, c.assignee_id, u.name AS assignee_name,
         c.created_at, c.updated_at
    FROM conversations c
    LEFT JOIN memberships m ON m.id = c.assignee_id
    LEFT JOIN users u       ON u.id = m.user_id
   WHERE c.org_id = $1 AND c.status = $2 AND c.updated_at >= $3::timestamptz
   ORDER BY c.${sortColumn} DESC, c.id DESC
   LIMIT ${PAGE_SIZE} OFFSET 0`;

/** The same page with no status filter — the query that decides whether
 *  org_id or status deserves the leading column. */
const unfilteredQuery = `
  SELECT c.id, c.status, c.assignee_id, u.name AS assignee_name,
         c.created_at, c.updated_at
    FROM conversations c
    LEFT JOIN memberships m ON m.id = c.assignee_id
    LEFT JOIN users u       ON u.id = m.user_id
   WHERE c.org_id = $1
   ORDER BY c.updated_at DESC, c.id DESC
   LIMIT ${PAGE_SIZE} OFFSET 0`;

// ------------------------------------------------------------------ helpers

/** The scan node on `conversations` — what the whole drill is about. */
function findScan(node) {
  if (node['Relation Name'] === 'conversations') return node;
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
  console.log(`\n--- ${label} ${'-'.repeat(Math.max(0, 68 - label.length))}`);
  for (const row of rows) console.log(row['QUERY PLAN']);
}

/** The org's newest updated_at. Every date cutoff is anchored to the data, not
 *  to now(): the seed's clock is fixed at 2026-08-11, so `now() - 7 days`
 *  selects nothing at all and would look like a very selective filter. */
async function anchor() {
  const { rows } = await client.query(
    `SELECT max(updated_at) AS at FROM conversations WHERE org_id = $1`,
    [ORG_ID],
  );
  return rows[0].at;
}

const daysBefore = (at, days) =>
  new Date(at.getTime() - days * 86_400_000).toISOString();

async function countRows(status, cutoff) {
  const { rows } = await client.query(
    `SELECT count(*) AS n FROM conversations
      WHERE org_id = $1 AND status = $2 AND updated_at >= $3::timestamptz`,
    [ORG_ID, status, cutoff],
  );
  return Number(rows[0].n);
}

// ------------------------------------------------------------------- scopes

/** BEGIN + the app role + the transaction-local GUC the policies read.
 *  Everything after this runs as the application does, so every plan includes
 *  the RLS predicate. */
async function openScope() {
  await client.query('BEGIN');
  await client.query(`SET LOCAL ROLE ${APP_USER}`);
  await client.query('SELECT set_config($1, $2, true)', ['app.org_id', ORG_ID]);
}

/**
 * Runs `fn` with the composite index dropped, then puts it back by rolling
 * back to a savepoint — DDL is transactional in Postgres, which is what makes
 * the "before" plan reproducible long after the migration landed.
 *
 * The savepoint rather than a plain ROLLBACK is because the enclosing
 * transaction is carrying `app.org_id`, and rolling that away would send every
 * policy predicate to NULL. Takes ACCESS EXCLUSIVE on conversations for the
 * duration: fine on a laptop, never on production.
 */
async function withoutIndex(fn) {
  await client.query('SAVEPOINT no_index');
  try {
    // Back to the owner to do the DDL — the app role owns no index and gets
    // "must be owner of index" — then straight back into the app role so the
    // plan still carries the policy.
    await client.query('SET LOCAL ROLE NONE');
    await client.query(`DROP INDEX ${INDEX_NAME}`);
    await client.query(`SET LOCAL ROLE ${APP_USER}`);
    await fn();
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT no_index');
  }
}

/**
 * Builds an index, runs `fn` against it, and rolls the whole thing away — the
 * way to price an index *before* committing to a migration. Same savepoint
 * dance as above. Plain CREATE INDEX, not CONCURRENTLY: CONCURRENTLY cannot run
 * inside a transaction, which is exactly what makes this trick possible.
 */
async function withIndex(name, definition, fn) {
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

// ---------------------------------------------------------------- plans

async function plans() {
  // The scope opens before the first read, not just before the EXPLAINs: this
  // connects as the app role, so outside a tenant scope `app_current_org()` is
  // NULL and every policy predicate filters every row away. `max(updated_at)`
  // came back NULL the first time this ran, which is the mechanism working.
  await openScope();

  const at = await anchor();
  const wide = daysBefore(at, 548); // the whole 18-month seed window
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
    // B: the index doing its job — equality, equality, range, and the sort all
    // served by one walk down the btree.
    await explainText(
      'B  index scan  (status=open, last 7 days, sort=updated_at)',
      listQuery('updated_at'),
      [ORG_ID, 'open', recent],
    );

    // C: same endpoint, one query parameter different. The index still answers
    // the whole WHERE — it cannot answer ORDER BY created_at, which is not in
    // it — so at this selectivity the planner should refuse it.
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

// ----------------------------------------------------------------- sweep

/**
 * Hold the query shape fixed and walk the date cutoff from "everything" down to
 * "the last few hours", printing what the planner chose at each step. The flip
 * point is wherever the Node Type column changes.
 *
 * STATUS and SORT are env vars because the interesting sweep is the one where
 * the index cannot serve the ORDER BY (sort=created_at) — but the same ladder
 * over sort=updated_at is the control that shows why.
 */
async function sweep() {
  // Same reason as plans(): the app role sees nothing until the scope is open.
  await openScope();

  const status = process.env.STATUS || 'closed';
  const sortColumn = process.env.SORT || 'created_at';
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

  // DAYS overrides the ladder, so the flip found by the coarse pass can be
  // bisected without editing the file: DAYS=90,85,80,75,70 pnpm db:explain sweep
  const ladder = process.env.DAYS
    ? process.env.DAYS.split(',').map(Number)
    : [548, 365, 270, 180, 120, 90, 60, 45, 30, 21, 14, 7, 3, 1];

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

// ------------------------------------------------------------ experiments

/**
 * The two indexes that were considered and not shipped, priced rather than
 * argued about. Both are built inside a transaction and rolled away — nothing
 * here reaches a migration.
 *
 *   swap    (status, org_id, ...) instead of (org_id, status, ...)
 *   partial (org_id, updated_at DESC, id DESC) WHERE status = 'open'
 *
 * Each runs with the real composite index dropped, or the planner would simply
 * pick the real one and the comparison would measure nothing.
 */
async function experiments() {
  await openScope();

  const at = await anchor();
  const wide = daysBefore(at, 548);
  const recent = daysBefore(at, 7);

  const summarise = async (label, sql, params) => {
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

    // The design reasoned out BEFORE measuring: "equality before range" put the
    // optional status column second. It wins nothing on the filtered arms and
    // loses the unfiltered page outright.
    await withIndex(
      'trial_with_status_idx',
      '(org_id, status, updated_at DESC, id DESC)',
      async (size) => {
        console.log(`\n  with-status (org_id, status, updated_at DESC, id DESC)  ${size.size}`); // prettier-ignore
        await arms();
      },
    );

    // The card's "what if you swap the first two?".
    await withIndex(
      'trial_swapped_idx',
      '(status, org_id, updated_at DESC, id DESC)',
      async (size) => {
        console.log(`\n  swapped     (status, org_id, updated_at DESC, id DESC)  ${size.size}`); // prettier-ignore
        await arms();
      },
    );

    // The stretch goal: does a partial index earn its maintenance?
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

// ----------------------------------------------------------------- stats

async function stats() {
  // n_distinct: positive is a count, NEGATIVE is a ratio of the row count —
  // -1 means every value is unique. That sign flip is the single most
  // misread number in pg_stats.
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

// ---------------------------------------------------------------- keyset

/**
 * Card 10. The same page, reached two ways, at the same depth.
 *
 * The number to read is NOT the milliseconds — it is `Actual Rows` on the node
 * *below* the Limit. OFFSET is a Limit-node parameter: the scan still produces
 * every row up to the offset and the Limit throws them away one at a time. The
 * cursor is a WHERE clause, so the scan starts where the last page stopped and
 * produces `pageSize` rows however deep the page is.
 *
 * See plans/2026-08-26_drill-10-keyset-pagination.md.
 */
const keysetQuery = (sortColumn) => `
  SELECT c.id, c.status, c.assignee_id, u.name AS assignee_name,
         c.created_at, c.updated_at
    FROM conversations c
    LEFT JOIN memberships m ON m.id = c.assignee_id
    LEFT JOIN users u       ON u.id = m.user_id
   WHERE c.org_id = $1 AND (c.${sortColumn}, c.id) < ($2::timestamptz, $3::uuid)
   ORDER BY c.${sortColumn} DESC, c.id DESC
   LIMIT ${PAGE_SIZE}`;

/** The hand-expanded OR form the row comparison replaces. Logically identical,
 *  and the whole question is whether the planner treats it that way. */
const keysetOrQuery = (sortColumn) => `
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

const offsetQuery = (sortColumn, offset) => `
  SELECT c.id, c.status, c.assignee_id, u.name AS assignee_name,
         c.created_at, c.updated_at
    FROM conversations c
    LEFT JOIN memberships m ON m.id = c.assignee_id
    LEFT JOIN users u       ON u.id = m.user_id
   WHERE c.org_id = $1
   ORDER BY c.${sortColumn} DESC, c.id DESC
   LIMIT ${PAGE_SIZE} OFFSET ${offset}`;

/**
 * Where page `depth` starts, as the pair a cursor carries.
 *
 * Found with an OFFSET, which is the joke: the only way to *jump* to the
 * cursor for page 5,000 is the mechanism the cursor exists to replace. A real
 * client never does this — it walks. Here it is scaffolding, run outside every
 * EXPLAIN so it costs nothing that gets reported.
 *
 * `to_char` and not a JS Date round trip: timestamptz holds microseconds and a
 * JS Date holds milliseconds, and the truncated value names a different row.
 */
async function cursorAt(sortColumn, depth) {
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

  const sortColumn = process.env.SORT || 'updated_at';
  const depths = (process.env.DEPTHS || '1,100,5000').split(',').map(Number);

  console.log(
    `org ${ORG_ID}  sort=${sortColumn}  pageSize=${PAGE_SIZE}  ` +
      `index ${(await hasIndex()) ? 'present' : 'ABSENT'}`,
  );
  console.log(
    '\n  depth      arm            node                       ' +
      'rows below Limit      ms   shared hit/read',
  );

  /** Actual Rows on the node directly under the Limit — the discarded work. */
  const belowLimit = (plan) => {
    const limit = (function find(node) {
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

  const row = async (depth, arm, sql, params) => {
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

  // The claim the whole predicate choice rests on, printed rather than argued:
  // does `(a, b) < (x, y)` reach the index as ONE Index Cond?
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

// -------------------------------------------------------------------- main

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
