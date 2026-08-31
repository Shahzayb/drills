import { check } from 'k6';
import http from 'k6/http';
import type { Options, Scenario, Threshold } from 'k6/options';

export const BASE_URL = __ENV.BASE_URL || 'http://nest_server:3002';
export const NAME = __ENV.NAME || '';
export const ORG_ID = __ENV.ORG_ID || '1';
export const VUS = Number(__ENV.VUS || '10');
export const WARMUP = __ENV.WARMUP || '20s';
export const DURATION = __ENV.DURATION || '60s';
export const PAGE = Number(__ENV.PAGE || '1');
export const PAGE_SIZE = Number(__ENV.PAGE_SIZE || '20');
export const Q = __ENV.Q || 'export';

const P95_BUDGET_MS = __ENV.P95_BUDGET_MS;

const SUMMARY_OUT = __ENV.SUMMARY_OUT;

const MEASURED_DURATION = 'http_req_duration{scenario:measure}';
const MEASURED_REQS = 'http_reqs{scenario:measure}';
const MEASURED_FAILED = 'http_req_failed{scenario:measure}';

export interface SummaryData {
  metrics: Record<string, { values: Record<string, number> }>;
}

type SummaryOutput = Record<string, string>;

const UNITS: Record<string, number> = { h: 3600, m: 60, s: 1, ms: 0.001 };
function seconds(d: string): number {
  const parts = [...String(d).matchAll(/(\d+(?:\.\d+)?)(ms|[hms])/g)];
  const total = parts.reduce((sum, [, n, u]) => sum + Number(n) * UNITS[u], 0);
  if (!parts.length || !total) throw new Error(`'${d}' is not a duration`);
  return total;
}

type Stage = { duration: string; target: number };
type MeasureScenario = Scenario & {
  duration?: string;
  vus?: number;
  stages?: Stage[];
};

const flat = (): MeasureScenario =>
  ({
    executor: 'constant-vus',
    vus: VUS,
    duration: DURATION,
  }) as MeasureScenario;

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

function warmupFor(measure: MeasureScenario): MeasureScenario {
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

let SHAPE: ReturnType<typeof shapeOf> | null = null;

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
    scenarios: {
      warmup: warmup ?? warmupFor(measure),
      measure: { ...measure, startTime: WARMUP },
    },

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
      [MEASURED_FAILED]: ['rate<0.01'],
      ...thresholds,
      [MEASURED_DURATION]: [
        ...durationThresholds,
        ...(thresholds?.[MEASURED_DURATION] ?? []),
      ],
      [MEASURED_REQS]: ['count>0'],
    },
  };
}

export function request(url: string): void {
  const res = http.get(url, { headers: { 'x-org-id': ORG_ID } });
  check(res, { 'status is 200': (r) => r.status === 200 });
}

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

  const rps = count / SHAPE.seconds;

  const n = (x: number) => x.toFixed(2);

  const report = [
    '',
    `  ${NAME ? `name=${NAME} ` : ''}org=${ORG_ID} vus=${SHAPE.vus} warmup=${WARMUP} measured=${SHAPE.duration} ${params}`,
    `  measured requests : ${count}`,
    `  p50 / p95 / p99   : ${n(v.med)} / ${n(v['p(95)'])} / ${n(v['p(99)'])} ms`,
    `  min / avg / max   : ${n(v.min)} / ${n(v.avg)} / ${n(v.max)} ms`,
    `  throughput        : ${n(rps)} req/s`,
    `  (incl. warm-up)   : p50 ${n(overall.med)}  p95 ${n(overall['p(95)'])}  p99 ${n(overall['p(99)'])} ms`,
    '',
    `RESULT,${NAME},${ORG_ID},${SHAPE.vus},${columns.join(',')},${n(v.med)},${n(v['p(95)'])},${n(v['p(99)'])},${n(rps)},${count}`,
    '',
  ].join('\n');

  return SUMMARY_OUT
    ? { stdout: report, [SUMMARY_OUT]: report }
    : { stdout: report };
}
