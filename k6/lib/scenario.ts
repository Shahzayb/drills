import { check } from 'k6';
import http from 'k6/http';
import type { Options, Scenario, Threshold } from 'k6/options';

/**
 * The measurement method, shared by every script in k6/.
 *
 * A script in k6/ is a URL, a load shape, and one line of summary. What is
 * shared is the *method* — the discarded warm-up, the tagged sub-metrics, the
 * trend stats, the error assertion, throughput per measured second. What
 * belongs to the script is the shape of the load, which it hands to scenario().
 *
 * The split is the point. The method is what lets two runs be compared, so it
 * is not the script's to change. The shape is: a baseline wants constant-vus, a
 * soak wants ramping-vus, and welding one shape into this module made it serve
 * exactly one kind of experiment.
 *
 * The knobs below are defaulted HERE and declared again in the catalog in
 * scripts/load.ts, because a k6 script has to be runnable by hand. Two copies
 * of a default is the exact bug that branch was about, so scripts/check-arms.ts
 * fails when the two disagree.
 *
 * See plans/2026-08-13_drill-05-load-test-baseline.md before changing any of
 * them — a change here silently invalidates every recorded run in k6/reports/.
 *
 * Runs in the k6 CONTAINER. See plans/2026-08-30_instrument-hardening.md § 7,
 * and plans/2026-08-30_instrument-typescript.md for why the imports above carry
 * a `.ts` where the importing scripts name this file.
 */

export const BASE_URL = __ENV.BASE_URL || 'http://nest_server:3002';
// The arm of an A/B this run is, set by scripts/load.ts (which also puts it in
// the report directory name). Empty by default — it labels the output and
// changes nothing about the measurement.
export const NAME = __ENV.NAME || '';
export const ORG_ID = __ENV.ORG_ID || '1';
export const VUS = Number(__ENV.VUS || '10');
export const WARMUP = __ENV.WARMUP || '20s';
export const DURATION = __ENV.DURATION || '60s';
export const PAGE = Number(__ENV.PAGE || '1');
export const PAGE_SIZE = Number(__ENV.PAGE_SIZE || '20');
export const Q = __ENV.Q || 'export';

// Stretch goal / card 31: fails the run if the measured p95 goes past a stated
// number. Off unless set, because a failed threshold exits 99 and would abort a
// sweep halfway through — a pass/fail gate and a measurement run are two
// different jobs for the same script.
const P95_BUDGET_MS = __ENV.P95_BUDGET_MS;

// Set by scripts/load.ts to the run's own directory. Unset when the script is
// run by hand, and then the summary is printed and not written.
const SUMMARY_OUT = __ENV.SUMMARY_OUT;

// In k6 a tagged sub-metric is NOT computed unless a threshold names it, so the
// two entries below exist to *declare* the sub-metric, not to pass or fail —
// they cannot fail. Without them, data.metrics has no per-scenario breakdown
// and the warm-up cannot be excluded at all.
const MEASURED_DURATION = 'http_req_duration{scenario:measure}';
const MEASURED_REQS = 'http_reqs{scenario:measure}';
const MEASURED_FAILED = 'http_req_failed{scenario:measure}';

/**
 * What handleSummary is handed. @types/k6 types `Options` but not this, and the
 * three keys read below are the whole of what summary() needs — a wider type
 * would be a guess about k6's payload rather than a statement about this file.
 */
export interface SummaryData {
  metrics: Record<string, { values: Record<string, number> }>;
}

/** What handleSummary returns: stdout, plus a file per path. */
type SummaryOutput = Record<string, string>;

/**
 * A k6 duration to seconds. '60s', '1m', '2m30s', '1h' all parse.
 *
 * Not `Number(replace('s',''))`: k6 accepts every one of those spellings and
 * `--duration 1m` would have made this NaN, so the summary printed a correct
 * p99 next to `throughput NaN req/s` and put NaN in the RESULT row.
 */
const UNITS: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001 };
function seconds(d: string): number {
  const parts = [...String(d).matchAll(/(\d+(?:\.\d+)?)(ms|[hms])/g)];
  const total = parts.reduce((sum, [, n, u]) => sum + Number(n) * UNITS[u], 0);
  if (!parts.length || !total) throw new Error(`'${d}' is not a duration`);
  return total;
}

/**
 * The measured stage, as this module needs to read it back.
 *
 * `Scenario` from k6/options is a union over every executor, and neither
 * `duration`, `vus` nor `stages` is on all of them — so the two shapes actually
 * supported here are named rather than narrowed out of the union at each use.
 */
type Stage = { duration: string; target: number };
type MeasureScenario = Scenario & {
  duration?: string;
  vus?: number;
  stages?: Stage[];
};

/** The default shape: flat concurrency for a fixed window. */
const flat = (): MeasureScenario =>
  ({
    executor: 'constant-vus',
    vus: VUS,
    duration: DURATION,
  }) as MeasureScenario;

/**
 * What the run will actually do, read off the script's own measured stage
 * rather than off the knobs.
 *
 * A script that declares its own stages does not read VUS or DURATION, and
 * labelling the summary from them anyway would print `vus=10 measured=60s`
 * over a run that ramped to 200 for five minutes — a summary that looks right
 * and is not, which is the defect this whole harness exists to prevent.
 */
function shapeOf(measure: MeasureScenario) {
  if (measure.stages) {
    const total = measure.stages.reduce((s, st) => s + seconds(st.duration), 0);
    return {
      seconds: total,
      duration: `${total}s`,
      vus: Math.max(...measure.stages.map((s) => s.target)),
    };
  }
  if (!measure.duration) {
    throw new Error(
      `the measure scenario needs a duration or stages — throughput is ` +
        `reported per measured second and there is nothing to divide by`,
    );
  }
  return {
    seconds: seconds(measure.duration),
    duration: measure.duration,
    vus: measure.vus ?? VUS,
  };
}

/** The warm-up mirrors the measured stage, shortened and thrown away. */
function warmupFor(measure: MeasureScenario): MeasureScenario {
  // A stages executor has no single duration, so its warm-up is a flat hold at
  // the peak the run will reach — enough to open the pool and warm the JIT.
  if (measure.stages) {
    return {
      executor: 'constant-vus',
      vus: Math.max(...measure.stages.map((s) => s.target)),
      duration: WARMUP,
      gracefulStop: '0s',
    } as MeasureScenario;
  }
  return { ...measure, duration: WARMUP, gracefulStop: '0s' };
}

// Set by scenario() at init and read by summary(). Module state rather than an
// argument, because the alternative is every script passing its shape twice —
// once to build the options and once to report them — and getting to disagree
// with itself.
let SHAPE: ReturnType<typeof shapeOf> | null = null;

/**
 * The run's options, wrapped around one script's measured stage.
 *
 * `scenario()` with no argument is the flat baseline, byte for byte what every
 * recorded run in k6/reports/ used. A script wanting another shape passes it:
 *
 *   export const options = scenario({
 *     measure: { executor: 'ramping-vus', stages: [
 *       { duration: '2m', target: 50 },
 *       { duration: '5m', target: 200 },
 *     ] },
 *   });
 *
 * `warmup` defaults to the measured stage shortened to WARMUP. `thresholds`
 * may replace the error rate — a stress test is looking for the errors a
 * baseline refuses — and may add to the duration budget, but cannot remove the
 * two sub-metric declarations, which summary() reads back by name.
 *
 * A script that shapes its own stages stops reading VUS and DURATION. Drop
 * `--vus` and `--duration` from its entry in scripts/load.ts when that
 * happens, or the catalog advertises knobs that do nothing — the bug the
 * instrument-hardening branch exists to make impossible.
 */
export function scenario({
  measure = flat(),
  warmup,
  thresholds,
}: {
  measure?: MeasureScenario;
  warmup?: MeasureScenario;
  thresholds?: Record<string, Threshold[]>;
} = {}): Options {
  SHAPE = shapeOf(measure);

  const durationThresholds: Threshold[] = ['max>=0'];
  if (P95_BUDGET_MS) durationThresholds.push(`p(95)<${P95_BUDGET_MS}`);

  return {
    // Warm-up runs first and its metrics are thrown away: JIT warm-up, the pg
    // pool opening its 10 connections, and Postgres pulling pages into
    // shared_buffers all happen once and would otherwise land in run 1's p99.
    //
    // gracefulStop: '0s' on warmup makes the two scenarios strictly
    // non-overlapping, so k6 allocates 10 VUs rather than 20. It cuts off at
    // most 10 in-flight warm-up requests, which are tagged scenario:warmup and
    // excluded from every reported number regardless.
    scenarios: {
      warmup: warmup ?? warmupFor(measure),
      measure: { ...measure, startTime: WARMUP },
    },

    // k6's default summary stops at p(95). This line is the only reason p99 —
    // the number the cards are actually about — appears anywhere. Not the
    // script's to change: summary() reads these keys back by name.
    summaryTrendStats: [
      'min',
      'med',
      'p(90)',
      'p(95)',
      'p(99)',
      'max',
      'avg',
      'count',
    ],

    thresholds: {
      // Policy, so the script owns it. A run containing errors is not a
      // baseline — and is exactly what a stress test is looking for. A crossed
      // threshold exits 99 and scripts/load.ts propagates it, so a stress run
      // that could not loosen this would report success as a failed command.
      [MEASURED_FAILED]: ['rate<0.01'],
      ...thresholds,
      // Declarations, not assertions: k6 does not compute a tagged sub-metric
      // unless a threshold names it, and summary() reads both back by name. A
      // script may ADD to the duration budget and may not remove either entry.
      [MEASURED_DURATION]: [
        ...durationThresholds,
        ...(thresholds?.[MEASURED_DURATION] ?? []),
      ],
      [MEASURED_REQS]: ['count>0'],
    },
  };
}

/**
 * One request, checked. No sleep(): closed-loop, each VU sending the next
 * request the instant the last returns. That measures saturation throughput and
 * puts queueing delay in the p99, which is what a *baseline* should capture.
 */
export function request(url: string): void {
  const res = http.get(url, { headers: { 'x-org-id': ORG_ID } });
  check(res, { 'status is 200': (r) => r.status === 200 });
}

/**
 * The summary block, byte-identical to what the run printed — a summary built
 * twice is a summary that can disagree with the terminal.
 *
 * `params` is the script's own tail of the parameter line, and `columns` its
 * own middle columns of the RESULT row. Everything else is fixed, so rows from
 * different scripts line up as far as they can and the report directory name
 * says which script produced them.
 */
export function summary(
  data: SummaryData,
  { params, columns }: { params: string; columns: (string | number)[] },
): SummaryOutput {
  if (!SHAPE) {
    throw new Error(
      'scenario() must be called at init — summary() reports the window it ' +
        'resolved, and there is nothing to report',
    );
  }

  const v = data.metrics[MEASURED_DURATION].values;
  const count = data.metrics[MEASURED_REQS].values.count;
  const overall = data.metrics.http_req_duration.values;

  // NOT the counter's own rate. k6 divides a counter's rate by the *whole* run
  // duration, warm-up included — 80s here, not 60s — which understates the
  // measured phase by 25%. Throughput is per measured second or it is wrong.
  const rps = count / SHAPE.seconds;

  const n = (x: number) => x.toFixed(2);

  const report = [
    '',
    `  ${NAME ? `name=${NAME} ` : ''}org=${ORG_ID} vus=${SHAPE.vus} warmup=${WARMUP} measured=${SHAPE.duration} ${params}`,
    `  measured requests : ${count}`,
    `  p50 / p95 / p99   : ${n(v.med)} / ${n(v['p(95)'])} / ${n(v['p(99)'])} ms`,
    `  min / avg / max   : ${n(v.min)} / ${n(v.avg)} / ${n(v.max)} ms`,
    `  throughput        : ${n(rps)} req/s`,
    // Printed side by side so warm-up exclusion is visible rather than claimed.
    // If these two lines are identical, the exclusion is not working.
    `  (incl. warm-up)   : p50 ${n(overall.med)}  p95 ${n(overall['p(95)'])}  p99 ${n(overall['p(99)'])} ms`,
    '',
    // Machine-readable row, for wherever the table is being kept. NAME leads —
    // an empty leading field keeps every other column where it was. Rows
    // recorded before PAGE/PAGE_SIZE existed have two fewer columns.
    `RESULT,${NAME},${ORG_ID},${SHAPE.vus},${columns.join(',')},${n(v.med)},${n(v['p(95)'])},${n(v['p(99)'])},${n(rps)},${count}`,
    '',
  ].join('\n');

  return SUMMARY_OUT
    ? { stdout: report, [SUMMARY_OUT]: report }
    : { stdout: report };
}
