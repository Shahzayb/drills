// What the browser sees when /conversations loads: TTFB, first paint, when the
// list and the stats widget actually appear, every chunk of the document as it
// arrives, and how many bytes of JavaScript shipped. Per arm, interleaved,
// medians. `pnpm ui:paint`, `pnpm ui:paint --org 150 --rounds 3 --name tail`.
//
// Runs on the HOST against the running container, the `pnpm test:ui` split.
// It lives under apps/frontend because @playwright/test resolves here and
// nowhere else, and it is `.mts` because this package has no `type` field.
//
// Two clocks, one answer. Chrome's DevTools Protocol stamps network and
// lifecycle events on one monotonic clock; the page's own `performance.now()`
// runs from navigation start. Everything below is converted onto the CDP clock
// through the document request's `wallTime`, so "the widget attached at
// 3,201ms" and "chunk 4 arrived at 3,198ms" are the same milliseconds.
//
// Refuses a dev server. `next dev` ships the HMR client and unminified chunks,
// so a JS-bytes number taken there describes the dev server, not the page.
// `pnpm docker:up:prod` first. See
// plans/2026-09-17_drill-17-streaming-inbox-suspense.md.

import { chromium, type Browser, type CDPSession } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

// ------------------------------------------------------------------- knobs

interface Knob {
  flag: string;
  env: string;
  def: string;
  help: string;
}

// Same provenance rule as apps/backend/db/lib/run.mts: a flag beats the
// environment beats the default, and the header says which one arrived.
const KNOBS: Knob[] = [
  { flag: 'org', env: 'ORG_ID', def: '1', help: 'which org the page renders' },
  { flag: 'rounds', env: 'ROUNDS', def: '5', help: 'loads per arm; medians' },
  { flag: 'warmup', env: 'WARMUP', def: '1', help: 'discarded loads per arm' },
  {
    flag: 'arms',
    env: 'ARMS',
    def: 'off,blocking,stream',
    help: 'which ?stats= arms, interleaved per round',
  },
  { flag: 'page-size', env: 'PAGE_SIZE', def: '50', help: 'rows on page 1' },
  {
    flag: 'url',
    env: 'FRONTEND_URL',
    def: 'http://localhost:3001',
    help: 'the Next server',
  },
  { flag: 'name', env: 'NAME', def: '', help: 'labels the report directory' },
];

const options: Record<string, { type: 'string' | 'boolean'; short?: string }> =
  {
    help: { type: 'boolean', short: 'h' },
    'allow-dev': { type: 'boolean' },
  };
for (const k of KNOBS) options[k.flag] = { type: 'string' };

const { values } = parseArgs({ options, allowPositionals: false });

if (values.help) {
  console.log(
    'paint — TTFB, FCP, chunk arrival and JS bytes per ?stats= arm\n',
  );
  console.log('knobs   (--flag value, or NAME=value in the environment)');
  for (const k of KNOBS) {
    console.log(`  --${k.flag.padEnd(12)} ${k.def.padEnd(24)} ${k.help}`);
  }
  console.log(
    '  --allow-dev                            measure a dev server anyway',
  );
  process.exit(0);
}

const resolved = new Map<string, { value: string; source: string }>();
const knob = (flag: string): string => {
  const k = KNOBS.find((entry) => entry.flag === flag)!;
  const fromFlag = values[flag] as string | undefined;
  const fromEnv = process.env[k.env];
  const value = fromFlag ?? (fromEnv || undefined) ?? k.def;
  resolved.set(k.env, {
    value,
    source: fromFlag ? 'flag' : fromEnv ? 'env' : 'default',
  });
  return value;
};

const ORG_ID = knob('org');
const ROUNDS = Number(knob('rounds'));
const WARMUP = Number(knob('warmup'));
const ARMS = knob('arms')
  .split(',')
  .map((arm) => arm.trim())
  .filter(Boolean);
const PAGE_SIZE = knob('page-size');
const FRONTEND_URL = knob('url').replace(/\/$/, '');
const NAME = knob('name');

// ------------------------------------------------------------------- shapes

interface Chunk {
  atMs: number;
  bytes: number;
}

interface Resource {
  name: string;
  type: string;
  startMs: number;
  firstByteMs: number;
  endMs: number;
  bytes: number;
}

/** One page load, every number in ms from the document request being sent. */
interface Load {
  arm: string;
  ttfbMs: number;
  fcpMs: number | null;
  listMs: number | null;
  fallbackMs: number | null;
  widgetMs: number | null;
  lastByteMs: number;
  dclMs: number | null;
  loadMs: number | null;
  /** The longest silence between two document chunks. */
  gapMs: number;
  docBytes: number;
  docDecodedBytes: number;
  jsBytes: number;
  jsDecodedBytes: number;
  cssBytes: number;
  inlinePayloadBytes: number;
  inlineOtherBytes: number;
  chunks: Chunk[];
  resources: Resource[];
}

// ----------------------------------------------------------------- one load

const ms = (seconds: number) => seconds * 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;

async function measure(
  browser: Browser,
  arm: string,
  screenshots: string | null,
): Promise<Load> {
  // A fresh context per load: no cache, no cookies. "JS bytes shipped" is a
  // question about a first visit.
  const context = await browser.newContext();
  const page = await context.newPage();

  // Stamps the moment the first row, the fallback and the widget attach. Runs
  // before any page script, so it sees the streamed HTML land node by node.
  await page.addInitScript(() => {
    const marks: Record<string, number> = {};
    const want: Record<string, string> = {
      list: '[data-conversation]',
      fallback: '[data-stats-fallback]',
      widget: '[data-stats]',
    };
    const check = () => {
      for (const [key, selector] of Object.entries(want)) {
        if (marks[key] === undefined && document.querySelector(selector)) {
          marks[key] = performance.now();
        }
      }
    };
    new MutationObserver(check).observe(document, {
      childList: true,
      subtree: true,
    });
    (window as unknown as { __paint: typeof marks }).__paint = marks;
  });

  const cdp: CDPSession = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true });

  let docId: string | null = null;
  let t0 = 0; // CDP monotonic seconds when the document request was sent
  let wall0 = 0; // the same instant as epoch seconds
  let ttfb = 0;
  const chunks: Chunk[] = [];
  let docBytes = 0;
  let docDecodedBytes = 0;
  const lifecycle = new Map<string, number>();
  const pending: Promise<unknown>[] = [];

  const requests = new Map<
    string,
    { name: string; type: string; start: number; firstByte?: number }
  >();
  const resources: Resource[] = [];

  cdp.on('Network.requestWillBeSent', (e) => {
    if (e.type === 'Document' && docId === null) {
      docId = e.requestId;
      t0 = e.timestamp;
      wall0 = e.wallTime;
    }
    requests.set(e.requestId, {
      name: e.request.url,
      type: e.type ?? 'Other',
      start: e.timestamp,
    });
  });

  cdp.on('Network.responseReceived', (e) => {
    const timing = e.response.timing;
    // DevTools' "Waiting (TTFB)": headers done, measured from the request's
    // own start. Falls back to the event time for the rare response without it.
    const firstByte = timing
      ? timing.requestTime + timing.receiveHeadersEnd / 1000
      : e.timestamp;
    const entry = requests.get(e.requestId);
    if (entry) entry.firstByte = firstByte;
    if (e.requestId === docId) ttfb = ms(firstByte - t0);
  });

  cdp.on('Network.dataReceived', (e) => {
    if (e.requestId !== docId) return;
    chunks.push({ atMs: round2(ms(e.timestamp - t0)), bytes: e.dataLength });
    docDecodedBytes += e.dataLength;
  });

  cdp.on('Network.loadingFinished', (e) => {
    const entry = requests.get(e.requestId);
    if (e.requestId === docId) docBytes = e.encodedDataLength;
    if (entry && e.requestId !== docId && t0) {
      resources.push({
        name: entry.name,
        type: entry.type,
        startMs: round2(ms(entry.start - t0)),
        firstByteMs: round2(ms((entry.firstByte ?? e.timestamp) - t0)),
        endMs: round2(ms(e.timestamp - t0)),
        bytes: e.encodedDataLength,
      });
    }
  });

  cdp.on('Page.lifecycleEvent', (e) => {
    if (!lifecycle.has(e.name)) lifecycle.set(e.name, e.timestamp);
    // The picture of the fallback: taken the moment the browser first
    // painted, while the server is still writing the rest of the document.
    if (e.name === 'firstContentfulPaint' && screenshots) {
      pending.push(
        page
          .screenshot({ path: `${screenshots}/${arm}-fcp.png` })
          .catch(() => undefined),
      );
    }
  });

  const url = `${FRONTEND_URL}/conversations?org=${ORG_ID}&pageSize=${PAGE_SIZE}&stats=${arm}`;
  await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
  // `load` can beat the FCP lifecycle event on a page this small. Give it a
  // moment, or the record has no first paint and the screenshot fires into a
  // context that has already been closed.
  for (let i = 0; i < 20 && !lifecycle.has('firstContentfulPaint'); i++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await Promise.all(pending);
  if (screenshots) {
    await page.screenshot({ path: `${screenshots}/${arm}-loaded.png` });
  }

  // The page's side of the story, read once everything has landed.
  const inPage = await page.evaluate(() => {
    const marks = (window as unknown as { __paint: Record<string, number> })
      .__paint;
    const entries = performance.getEntriesByType(
      'resource',
    ) as PerformanceResourceTiming[];
    const sum = (
      filter: (e: PerformanceResourceTiming) => boolean,
      field: 'transferSize' | 'decodedBodySize',
    ) => entries.filter(filter).reduce((acc, e) => acc + e[field], 0);
    const isScript = (e: PerformanceResourceTiming) =>
      e.initiatorType === 'script' || /\.js(\?|$)/.test(e.name);
    const isCss = (e: PerformanceResourceTiming) =>
      e.initiatorType === 'link' || /\.css(\?|$)/.test(e.name);
    let inlinePayload = 0;
    let inlineOther = 0;
    for (const script of Array.from(document.scripts)) {
      if (script.src) continue;
      const text = script.textContent ?? '';
      if (text.includes('__next_f')) inlinePayload += text.length;
      else inlineOther += text.length;
    }
    return {
      timeOrigin: performance.timeOrigin,
      marks,
      jsBytes: sum(isScript, 'transferSize'),
      jsDecodedBytes: sum(isScript, 'decodedBodySize'),
      cssBytes: sum(isCss, 'transferSize'),
      inlinePayload,
      inlineOther,
    };
  });

  await context.close();

  // Page clock -> CDP clock. `wall0` and `t0` name the same instant.
  const fromPage = (perfNow: number | undefined): number | null => {
    if (perfNow === undefined) return null;
    const epochSeconds = (inPage.timeOrigin + perfNow) / 1000;
    return round2(ms(epochSeconds - wall0));
  };
  const fromCdp = (name: string): number | null => {
    const at = lifecycle.get(name);
    return at === undefined ? null : round2(ms(at - t0));
  };

  let gap = 0;
  for (let i = 1; i < chunks.length; i++) {
    gap = Math.max(gap, chunks[i].atMs - chunks[i - 1].atMs);
  }

  resources.sort((a, b) => a.startMs - b.startMs);

  return {
    arm,
    ttfbMs: round2(ttfb),
    fcpMs: fromCdp('firstContentfulPaint'),
    listMs: fromPage(inPage.marks.list),
    fallbackMs: fromPage(inPage.marks.fallback),
    widgetMs: fromPage(inPage.marks.widget),
    lastByteMs: chunks.length ? chunks[chunks.length - 1].atMs : 0,
    dclMs: fromCdp('DOMContentLoaded'),
    loadMs: fromCdp('load'),
    gapMs: round2(gap),
    docBytes,
    docDecodedBytes,
    jsBytes: inPage.jsBytes,
    jsDecodedBytes: inPage.jsDecodedBytes,
    cssBytes: inPage.cssBytes,
    inlinePayloadBytes: inPage.inlinePayload,
    inlineOtherBytes: inPage.inlineOther,
    chunks,
    resources,
  };
}

// ---------------------------------------------------------------- reporting

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const kb = (bytes: number) => (bytes / 1024).toFixed(1);
const fmt = (n: number | null) => (n === null ? '—' : n.toFixed(0));

/** Median over the rounds of one arm, for every numeric field. */
function medians(loads: Load[]) {
  const pick = (field: keyof Load) =>
    median(
      loads
        .map((l) => l[field])
        .filter((v): v is number => typeof v === 'number'),
    );
  const nullable = (field: keyof Load) =>
    loads.some((l) => l[field] !== null) ? pick(field) : null;
  return {
    ttfbMs: pick('ttfbMs'),
    fcpMs: nullable('fcpMs'),
    listMs: nullable('listMs'),
    widgetMs: nullable('widgetMs'),
    lastByteMs: pick('lastByteMs'),
    dclMs: nullable('dclMs'),
    loadMs: nullable('loadMs'),
    gapMs: pick('gapMs'),
    docBytes: pick('docBytes'),
    docDecodedBytes: pick('docDecodedBytes'),
    jsBytes: pick('jsBytes'),
    jsDecodedBytes: pick('jsDecodedBytes'),
    cssBytes: pick('cssBytes'),
    inlinePayloadBytes: pick('inlinePayloadBytes'),
    inlineOtherBytes: pick('inlineOtherBytes'),
    chunks: median(loads.map((l) => l.chunks.length)),
  };
}

// The waterfall, drawn from the last round of each arm — the round the
// screenshots come from — so the picture and the PNGs describe one load.
// Colours are the dataviz reference palette's first three slots, validated
// all-pairs; the aqua bar carries a direct label because its contrast is low.
function waterfall(loads: Load[], org: string): string {
  const W = 1100;
  const LEFT = 270;
  const RIGHT = 130;
  const ROW = 18;
  const HEAD = 60;
  const maxMs = Math.max(...loads.map((l) => l.loadMs ?? l.lastByteMs)) * 1.05;
  const x = (t: number) =>
    Math.round((LEFT + (t / maxMs) * (W - LEFT - RIGHT)) * 10) / 10;
  // "—" rather than "—ms" for a mark the arm never had.
  const at = (n: number | null) => (n === null ? '—' : `${fmt(n)}ms`);
  const short = (name: string) =>
    name
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/\?.*$/, '')
      .slice(-38);

  const panels: string[] = [];
  let y = 40;

  for (const load of loads) {
    const rows = [
      {
        name: `document  ?stats=${load.arm}`,
        startMs: 0,
        firstByteMs: load.ttfbMs,
        endMs: load.lastByteMs,
        bytes: load.docBytes,
        chunks: load.chunks,
      },
      ...load.resources
        .filter((r) => /Script|Stylesheet|Font/.test(r.type))
        .slice(0, 10)
        .map((r) => ({ ...r, name: short(r.name), chunks: [] as Chunk[] })),
    ];
    const height = HEAD + rows.length * ROW + 36;
    const parts: string[] = [];
    const title =
      `${load.arm.padEnd(8)} TTFB ${at(load.ttfbMs)} · FCP ${at(load.fcpMs)}` +
      ` · list ${at(load.listMs)} · widget ${at(load.widgetMs)}` +
      ` · last byte ${at(load.lastByteMs)} · load ${at(load.loadMs)}`;
    parts.push(`<text x="${LEFT}" y="${y + 14}" class="title">${title}</text>`);

    // Event lines: labelled, not colour-alone. Widget is the headline.
    const marks: [string, number | null, string][] = [
      ['FCP', load.fcpMs, 'mark'],
      ['widget', load.widgetMs, 'mark-widget'],
      ['load', load.loadMs, 'mark'],
    ];
    const top = y + HEAD - 8;
    const bottom = y + HEAD + rows.length * ROW;
    // Marks that land within a label's width of each other stack their labels
    // instead of writing over each other — blocking's FCP and widget do.
    let lastLabelX = -Infinity;
    let stack = 0;
    for (const [label, when, cls] of marks) {
      if (when === null) continue;
      stack = x(when) - lastLabelX < 90 ? stack + 1 : 0;
      lastLabelX = x(when);
      parts.push(
        `<line x1="${x(when)}" x2="${x(when)}" y1="${top}" y2="${bottom}" class="${cls}"/>`,
        `<text x="${x(when) + 3}" y="${top - 2 - stack * 11}" class="mark-label">${label} ${at(when)}</text>`,
      );
    }

    rows.forEach((row, i) => {
      const ry = y + HEAD + i * ROW;
      parts.push(
        `<text x="${LEFT - 8}" y="${ry + 12}" class="label" text-anchor="end">${row.name}</text>`,
      );
      // waiting: request sent -> first byte; download: first byte -> last byte
      parts.push(
        `<rect x="${x(row.startMs)}" y="${ry + 3}" width="${Math.max(1, x(row.firstByteMs) - x(row.startMs))}" height="10" class="wait"/>`,
        `<rect x="${x(row.firstByteMs)}" y="${ry + 3}" width="${Math.max(1, x(row.endMs) - x(row.firstByteMs))}" height="10" class="download"/>`,
      );
      for (const chunk of row.chunks) {
        parts.push(
          `<line x1="${x(chunk.atMs)}" x2="${x(chunk.atMs)}" y1="${ry + 1}" y2="${ry + 15}" class="chunk"/>`,
        );
      }
      parts.push(
        `<text x="${x(row.endMs) + 4}" y="${ry + 12}" class="value">${fmt(row.endMs - row.startMs)}ms · ${kb(row.bytes)}KB</text>`,
      );
    });

    panels.push(parts.join('\n'));
    y += height;
  }

  // Axis, once, along the bottom.
  const ticks: string[] = [];
  const step = maxMs > 4000 ? 1000 : maxMs > 1500 ? 500 : 100;
  for (let t = 0; t <= maxMs; t += step) {
    ticks.push(
      `<line x1="${x(t)}" x2="${x(t)}" y1="30" y2="${y}" class="grid"/>`,
      `<text x="${x(t)}" y="${y + 14}" class="axis" text-anchor="middle">${t}ms</text>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${y + 24}" viewBox="0 0 ${W} ${y + 24}" class="viz-root">
<style>
  .viz-root { --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --grid: #e6e5e1;
              --wait: #2a78d6; --download: #1baf7a; --widget: #eb6834; }
  @media (prefers-color-scheme: dark) {
    .viz-root { --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --grid: #333230;
                --wait: #3987e5; --download: #199e70; --widget: #d95926; }
  }
  .bg { fill: var(--surface); }
  text { font: 11px ui-sans-serif, system-ui, sans-serif; fill: var(--ink-2); }
  .title { font-weight: 600; fill: var(--ink); font-family: ui-monospace, SFMono-Regular, monospace; }
  .label, .value { font-family: ui-monospace, SFMono-Regular, monospace; font-size: 10px; }
  .axis { font-size: 10px; }
  .grid { stroke: var(--grid); stroke-width: 1; }
  .wait { fill: var(--wait); rx: 2; }
  .download { fill: var(--download); rx: 2; }
  .chunk { stroke: var(--ink); stroke-width: 1; }
  .mark { stroke: var(--ink-2); stroke-width: 1; stroke-dasharray: 3 3; }
  .mark-widget { stroke: var(--widget); stroke-width: 2; }
  .mark-label { font-size: 10px; fill: var(--ink); }
  .legend { font-size: 10px; }
</style>
<rect class="bg" width="100%" height="100%"/>
<text x="16" y="20" class="title">/conversations?org=${org} — document chunks and resources, one load per arm (the last round). </text>
<rect x="${W - 330}" y="10" width="10" height="10" class="wait"/><text x="${W - 316}" y="19" class="legend">waiting (TTFB)</text>
<rect x="${W - 230}" y="10" width="10" height="10" class="download"/><text x="${W - 216}" y="19" class="legend">receiving</text>
<line x1="${W - 140}" x2="${W - 140}" y1="9" y2="21" class="chunk"/><text x="${W - 134}" y="19" class="legend">a chunk arrived</text>
${ticks.join('\n')}
${panels.join('\n')}
</svg>
`;
}

// --------------------------------------------------------------------- run

const health = await fetch(`${FRONTEND_URL}/health`)
  .then((r) => r.json() as Promise<{ mode?: string }>)
  .catch(() => null);

if (!health) {
  console.error(`no answer from ${FRONTEND_URL}/health — is next_app up?`);
  process.exit(1);
}
if (health.mode !== 'production' && !values['allow-dev']) {
  console.error(
    `${FRONTEND_URL} is a ${health.mode ?? 'unknown'} server. JS bytes from a dev ` +
      `server describe the dev server. \`pnpm docker:up:prod\` first, or --allow-dev.`,
  );
  process.exit(1);
}

console.log('paint — TTFB, FCP, chunk arrival and JS bytes per ?stats= arm');
for (const [name, k] of resolved) {
  console.log(
    `  ${name.padEnd(14)} ${(k.value || '(none)').padEnd(24)} (${k.source})`,
  );
}
console.log(`  mode           ${health.mode}\n`);

const d = new Date();
const pad = (n: number) => String(n).padStart(2, '0');
const stamp =
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
  `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const safeName = NAME.trim().replace(/[^a-zA-Z0-9._]+/g, '-');
const dir = new URL(
  `./reports/${stamp}${safeName ? `-${safeName}` : ''}-paint-org${ORG_ID}-size${PAGE_SIZE}/`,
  import.meta.url,
);
mkdirSync(dir, { recursive: true });
const dirPath = dir.pathname;

const browser = await chromium.launch();
const loads: Load[] = [];
const transcript: string[] = [];
const say = (line: string) => {
  transcript.push(line);
  console.log(line);
};

for (let i = 0; i < WARMUP; i++) {
  for (const arm of ARMS) await measure(browser, arm, null);
}

for (let round = 1; round <= ROUNDS; round++) {
  for (const arm of ARMS) {
    const last = round === ROUNDS;
    const load = await measure(browser, arm, last ? dirPath : null);
    loads.push(load);
    say(
      `round ${round} ${arm.padEnd(8)} ttfb ${fmt(load.ttfbMs).padStart(5)}  fcp ${fmt(load.fcpMs).padStart(5)}` +
        `  list ${fmt(load.listMs).padStart(5)}  widget ${fmt(load.widgetMs).padStart(5)}` +
        `  last byte ${fmt(load.lastByteMs).padStart(5)}  load ${fmt(load.loadMs).padStart(5)}` +
        `  chunks ${String(load.chunks.length).padStart(2)}  gap ${fmt(load.gapMs).padStart(5)}`,
    );
  }
}

await browser.close();

say('');
say(
  `${'arm'.padEnd(9)}${'ttfb'.padStart(6)}${'fcp'.padStart(6)}${'list'.padStart(6)}${'widget'.padStart(7)}` +
    `${'lastB'.padStart(7)}${'dcl'.padStart(6)}${'load'.padStart(6)}${'gap'.padStart(6)}` +
    `${'chunks'.padStart(7)}${'docKB'.padStart(7)}${'jsKB'.padStart(7)}${'cssKB'.padStart(7)}${'payloadKB'.padStart(10)}${'inlineKB'.padStart(9)}`,
);
const summary: Record<string, ReturnType<typeof medians>> = {};
for (const arm of ARMS) {
  const m = medians(loads.filter((l) => l.arm === arm));
  summary[arm] = m;
  say(
    `${arm.padEnd(9)}${fmt(m.ttfbMs).padStart(6)}${fmt(m.fcpMs).padStart(6)}${fmt(m.listMs).padStart(6)}` +
      `${fmt(m.widgetMs).padStart(7)}${fmt(m.lastByteMs).padStart(7)}${fmt(m.dclMs).padStart(6)}` +
      `${fmt(m.loadMs).padStart(6)}${fmt(m.gapMs).padStart(6)}${fmt(m.chunks).padStart(7)}${kb(m.docBytes).padStart(7)}` +
      `${kb(m.jsBytes).padStart(7)}${kb(m.cssBytes).padStart(7)}${kb(m.inlinePayloadBytes).padStart(10)}` +
      `${kb(m.inlineOtherBytes).padStart(9)}`,
  );
}
say('');
say(
  `medians of ${ROUNDS} rounds, ms from the document request; KB on the wire (transfer size). ` +
    `docKB is the HTML as sent, jsKB every external script, payloadKB the inline ` +
    `self.__next_f.push RSC payload, inlineKB every other inline <script>.`,
);
say(`gap = the longest silence between two document chunks.`);

const lastRound = ARMS.map((arm) => loads.filter((l) => l.arm === arm).at(-1)!);
writeFileSync(new URL('waterfall.svg', dir), waterfall(lastRound, ORG_ID));
writeFileSync(new URL('summary.txt', dir), transcript.join('\n') + '\n');
writeFileSync(
  new URL('run.json', dir),
  JSON.stringify(
    {
      instrument: 'paint',
      at: d.toISOString(),
      name: safeName || null,
      mode: health.mode,
      knobs: Object.fromEntries(resolved),
      summary,
      loads,
    },
    null,
    2,
  ) + '\n',
);

console.log(`\napps/frontend/perf/reports/${dirPath.split('/reports/')[1]}`);
