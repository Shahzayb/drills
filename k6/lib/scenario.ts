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
// Drill 16. Requests per second a constant-arrival-rate script offers,
// independent of how long any of them takes. VUS still bounds how many can be
// in flight; a script using this one declares its own preAllocatedVUs/maxVUs.
export const RATE = Number(__ENV.RATE || '50');
export const WARMUP = __ENV.WARMUP || '20s';
export const DURATION = __ENV.DURATION || '60s';
export const PAGE = Number(__ENV.PAGE || '1');
export const PAGE_SIZE = Number(__ENV.PAGE_SIZE || '20');
export const Q = __ENV.Q || 'export';
// Drill 12. The key is minted out of band (`pnpm db:storm key`) and passed in,
// because a k6 script has no database. UNIQUE is how many distinct events the
// run cycles through: the duplicate ratio is VUS x iterations / UNIQUE, and at
// UNIQUE=1 every request in the run is a duplicate of the same event.
export const API_KEY = __ENV.API_KEY || '';
export const UNIQUE = Number(__ENV.UNIQUE || '3000');

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
// Drill 16. Iterations the executor wanted to start and could not, because
// every allocated VU was still parked on an open request. It exists ONLY for an
// arrival-rate executor, so the threshold that declares it is added only for
// one — a threshold naming a metric k6 never created fails the whole run.
const MEASURED_DROPPED = 'dropped_iterations{scenario:measure}';

/**
 * What handleSummary is handed. @types/k6 types `Options` but not this, and the
 * three keys read below are the whole of what summary() needs — a wider type
 * would be a guess about k6's payload rather than a statement about this file.
 */
export interface SummaryData {
  metrics: Record<string, { values: Record<string, number> }>;
}

/**
 * The keys a k6 Rate sub-metric carries, and the trap in them.
 *
 * `http_req_failed` is a Rate whose observations are "did this request fail?",
 * so on THAT metric `passes` counts the requests that FAILED and `fails` counts
 * the ones that were fine. Reading `fails` prints the success count under the
 * word "errors" — a baseline of 4,500 clean requests reported as 4,500 errors
 * at 0.00%, which is how this was caught.
 */
type FailedValues = { rate?: number; passes?: number };

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
  /** constant-arrival-rate only. Iterations started per `timeUnit`. */
  rate?: number;
  timeUnit?: string;
  maxVUs?: number;
  preAllocatedVUs?: number;
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
  // OPEN MODEL, and it needs its own branch rather than falling through to the
  // `vus` default below. An arrival-rate scenario has no `vus` key at all, so
  // the fallback would print `vus=10` over a run whose whole subject is offered
  // load — a summary that looks right and is not, which is the defect this
  // module's header calls out. Drill 16.
  if (measure.rate !== undefined) {
    if (!measure.duration) {
      throw new Error(
        `an arrival-rate measure scenario needs a duration — throughput is ` +
          `reported per measured second and there is nothing to divide by`,
      );
    }
    return {
      seconds: seconds(measure.duration),
      duration: measure.duration,
      // What was ALLOCATED, not what was used. Under a lock every VU is parked
      // on an open request, and the gap between this and the achieved rate is
      // the dropped_iterations count summary() prints.
      vus: measure.maxVUs ?? measure.preAllocatedVUs ?? VUS,
      rate: measure.rate / seconds(measure.timeUnit ?? '1s'),
    };
  }

  if (measure.stages) {
    const total = measure.stages.reduce((s, st) => s + seconds(st.duration), 0);
    return {
      seconds: total,
      duration: `${total}s`,
      vus: Math.max(...measure.stages.map((s) => s.target)),
      rate: undefined,
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
    rate: undefined,
  };
}

/** The warm-up mirrors the measured stage, shortened and thrown away. */
function warmupFor(measure: MeasureScenario): MeasureScenario {
  // The arrival-rate warm-up mirrors the shape rather than flattening to VUs:
  // an open-model run whose warm-up was closed-model would open the pool under
  // a different regime than the one being measured.
  if (measure.rate !== undefined) {
    return { ...measure, duration: WARMUP, gracefulStop: '0s' };
  }
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
      // A declaration, not an assertion, and conditional for the reason given
      // where MEASURED_DROPPED is defined.
      ...(SHAPE.rate !== undefined
        ? { [MEASURED_DROPPED]: ['count>=0'] }
        : {}),
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
 * One POST, checked. The sibling of `request()` above, and separate from it on
 * purpose: `request()` is what ~60 recorded runs in k6/reports/ used, and
 * widening it into a general-purpose method dispatcher would change the thing
 * every one of those baselines was measured with.
 *
 * Idempotency lives in the STATUS code, so every 2xx is a success here — 201
 * created, 200 already-had-it, 202 in flight elsewhere. A check that demanded
 * 200 would fail an entirely correct run, and one that demanded 201 would fail
 * 70% of a duplicate storm by design.
 */
export function post(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): void {
  const res = http.post(url, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  check(res, { 'status is 2xx': (r) => r.status >= 200 && r.status < 300 });
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

  // Requests that were never sent. On a closed-model run there is no such
  // thing — a blocked VU simply sends less — but on an arrival-rate run this is
  // where an outage actually shows up: latency percentiles only describe
  // requests that HAPPENED, and a stalled server's worst damage is the traffic
  // it never got to answer. Drill 16.
  const dropped = data.metrics[MEASURED_DROPPED]?.values.count ?? 0;

  // The error rate, PRINTED rather than only enforced. It has been a threshold
  // since drill 05 and the value has never appeared in a summary, so "zero
  // errors" was a claim about an exit code rather than a recorded number — and
  // drill 16's whole deliverable is one arm with errors beside one without.
  // handleSummary REPLACES k6's own end-of-test block, so if this file does not
  // print it, nothing does.
  const failed: FailedValues = data.metrics[MEASURED_FAILED]?.values ?? {};

  // NOT the counter's own rate. k6 divides a counter's rate by the *whole* run
  // duration, warm-up included — 80s here, not 60s — which understates the
  // measured phase by 25%. Throughput is per measured second or it is wrong.
  const rps = count / SHAPE.seconds;

  const n = (x: number) => x.toFixed(2);

  const report = [
    '',
    `  ${NAME ? `name=${NAME} ` : ''}org=${ORG_ID} ${SHAPE.rate !== undefined ? `rate=${n(SHAPE.rate)}/s maxvus=` : 'vus='}${SHAPE.vus} warmup=${WARMUP} measured=${SHAPE.duration} ${params}`,
    `  measured requests : ${count}`,
    `  errors            : ${failed.passes ?? 0} (${n((failed.rate ?? 0) * 100)}%)`,
    `  p50 / p95 / p99   : ${n(v.med)} / ${n(v['p(95)'])} / ${n(v['p(99)'])} ms`,
    `  min / avg / max   : ${n(v.min)} / ${n(v.avg)} / ${n(v.max)} ms`,
    `  throughput        : ${n(rps)} req/s${SHAPE.rate !== undefined ? ` of ${n(SHAPE.rate)} offered` : ''}`,
    ...(SHAPE.rate !== undefined
      ? [`  dropped           : ${dropped} iterations never started`]
      : []),
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
