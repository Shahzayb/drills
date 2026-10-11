// Drill 24's instrument: did each usage-rollup slot run exactly once? Runs in the container as the owner.
// `pnpm db:jobs report --since 10`. See plans/2026-10-12_drill-24-three-replicas.md.
//
//   report   one line per slot in the last SINCE minutes: the ledger's sum against the rollups' sum,
//            the most copies of any (org, metric) row, the writers and terms, and the job_runs claim

import {
  client as pgClient,
  header,
  knob,
  knobNumber,
  record,
  serverArms,
} from './lib/run.mts';

const subcommand = process.argv[2];
if (subcommand !== 'report') {
  console.error('usage: node db/jobs.mts report');
  process.exit(1);
}

const API = knob(
  'API',
  process.env.BACKEND_INTERNAL_URL || 'http://nest_server:3002',
);
const SINCE = knobNumber('SINCE', 10);
const arms = await serverArms(API);
const SLOT_S = knobNumber('SLOT_S', Number(arms?.jobSlotS || 60));
const GRACE_S = 5;

const db = pgClient();
await db.connect();

const slotMs = SLOT_S * 1000;
const now = Date.now();
const to = Math.floor((now - GRACE_S * 1000) / slotMs) * slotMs;
const from = to - Math.ceil((SINCE * 60_000) / slotMs) * slotMs;
const interval = `${SLOT_S} seconds`;
const window = [new Date(from), new Date(to)];

const [ledger, rollups, claims] = await Promise.all([
  db.query<{ slot: Date; quantity: number }>(
    `SELECT date_bin($1::interval, occurred_at, 'epoch'::timestamptz) AS slot,
            sum(quantity)::int AS quantity
       FROM usage_events
      WHERE occurred_at >= $2 AND occurred_at < $3
      GROUP BY 1`,
    [interval, ...window],
  ),
  db.query<{
    slot: Date;
    quantity: number;
    copies: number;
    holders: string[];
    terms: string[];
  }>(
    `SELECT slot_start AS slot, sum(quantity)::int AS quantity,
            (SELECT max(n) FROM (SELECT count(*) AS n FROM usage_rollups c
                                  WHERE c.slot_start = r.slot_start
                                  GROUP BY org_id, metric) per_org)::int AS copies,
            array_agg(DISTINCT holder) AS holders, array_agg(DISTINCT term::text) AS terms
       FROM usage_rollups r
      WHERE slot_start >= $1 AND slot_start < $2
      GROUP BY slot_start`,
    window,
  ),
  db.query<{ slot: Date; holder: string; term: string }>(
    `SELECT slot_start AS slot, holder, term::text FROM job_runs
      WHERE job = 'usage-rollup' AND slot_start >= $1 AND slot_start < $2`,
    window,
  ),
]);
await db.end();

const bySlot = <T extends { slot: Date }>(rows: T[]) =>
  new Map(rows.map((row) => [row.slot.getTime(), row]));
const ledgerBy = bySlot(ledger.rows);
const rollupBy = bySlot(rollups.rows);
const claimBy = bySlot(claims.rows);
// The container id is the hostname; pid and suffix only tell apps in one process apart.
const host = (holder: string) => holder.split(':')[0];

header(`jobs report  last ${SINCE} min  slot ${SLOT_S}s  api ${API}`);
console.log(`  server arm  scheduler=${arms?.scheduler ?? '?'}\n`);
console.log(
  '  slot (UTC)   ledger  rollups  copies  verdict   writers               terms  claim',
);

const rows: Record<string, unknown>[] = [];
const tally: Record<string, number> = {};
let ledgerTotal = 0;
let rollupTotal = 0;
for (let slot = from; slot < to; slot += slotMs) {
  const expected = ledgerBy.get(slot)?.quantity ?? 0;
  const rollup = rollupBy.get(slot);
  const claim = claimBy.get(slot);
  const got = rollup?.quantity ?? 0;
  const copies = rollup?.copies ?? 0;
  ledgerTotal += expected;
  rollupTotal += got;

  const verdict =
    expected === 0 && !rollup
      ? 'empty'
      : copies > 1
        ? `x${copies}`
        : !rollup
          ? 'missing'
          : got === expected
            ? 'once'
            : 'partial';
  tally[verdict] = (tally[verdict] ?? 0) + 1;

  const writers = [...new Set((rollup?.holders ?? []).map(host))];
  const row = {
    slot: new Date(slot).toISOString(),
    ledger: expected,
    rollups: got,
    copies,
    verdict,
    writers,
    terms: rollup?.terms ?? [],
    claim: claim ? { holder: host(claim.holder), term: claim.term } : null,
  };
  rows.push(row);
  console.log(
    `  ${row.slot.slice(11, 19)}   ${String(expected).padStart(6)}  ${String(got).padStart(7)}  ${String(copies).padStart(6)}  ${verdict.padEnd(8)}  ${writers.join(',').padEnd(20)}  ${row.terms.join(',').padStart(5)}  ${claim ? `${host(claim.holder)} t${claim.term}` : '-'}`,
  );
}

console.log(
  `\n  slots ${rows.length}  ${Object.entries(tally)
    .map(([verdict, n]) => `${verdict} ${n}`)
    .join(
      '  ',
    )}  ledger ${ledgerTotal}  rollups ${rollupTotal}  ratio ${ledgerTotal ? (rollupTotal / ledgerTotal).toFixed(2) : '-'}`,
);

record('jobs', subcommand, { rows, arms });
