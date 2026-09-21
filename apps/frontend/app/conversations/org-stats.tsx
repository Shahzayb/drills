import type { OrgStatsResult } from '@/lib/api';
import { ServedLine } from './served';

/**
 * The slow widget. Card 17.
 *
 * A Server Component with no directive, and that is the first thing worth
 * noticing about it: the slowest thing on the page ships zero JavaScript. It
 * awaits a PROMISE rather than calling `fetchOrgStats` itself — the page starts
 * the fetch at the top of its body, before it awaits the list, so the two run
 * side by side. Started here, the aggregate would begin only after the list
 * had resolved, and the widget would arrive list-time later than it needs to.
 *
 * Where it renders decides what the page waits for. Inside a `<Suspense>` the
 * `await` below suspends only this subtree, the fallback goes out in the first
 * chunk, and this HTML follows in a later one. Without the boundary the same
 * `await` holds the whole document. The component does not know which; the
 * page does. See plans/2026-09-17_drill-17-streaming-inbox-suspense.md.
 */
export async function OrgStats({ stats }: { stats: Promise<OrgStatsResult> }) {
  const result = await stats;

  if (!result.ok) {
    return (
      <div
        data-stats="error"
        className="flex min-h-16 flex-col justify-center rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
      >
        inbox pulse unavailable — {result.error}
      </div>
    );
  }

  const { stats: s } = result;
  const share = (n: number) =>
    s.messages ? `${((100 * n) / s.messages).toFixed(1)}%` : '—';

  return (
    <div
      data-stats="ready"
      className="flex min-h-16 flex-col justify-center gap-1 rounded-lg border border-black/[.08] bg-white px-4 py-3 text-xs text-zinc-600 dark:border-white/[.145] dark:bg-zinc-950 dark:text-zinc-400"
    >
      <p className="text-black dark:text-zinc-50">
        <span className="font-medium">inbox pulse</span> ·{' '}
        {s.messages.toLocaleString('en-US')} messages ·{' '}
        {s.recent.toLocaleString('en-US')} in the last 90 days · avg{' '}
        {Math.round(s.avgLength)} chars
      </p>
      <p>
        {share(s.negative)} negative · {share(s.positive)} positive ({s.method}{' '}
        over every message in the org — not sentiment analysis) · last message{' '}
        {s.lastMessageAt ?? '—'}
      </p>
      {/* The cost, on the widget it paid for. Stays visible either way: on the
          blocking arm this number is also how long the page waited. Card 18
          adds who answered and how old the answer is: on a cache hit the API
          took its 1.3s for somebody else, up to STATS_MAX_AGE_S ago. That age
          is the staleness budget, printed where the user can see it. */}
      <p className="font-mono text-zinc-500 dark:text-zinc-500">
        aggregate took {result.durMs}ms on the API ·{' '}
        <ServedLine name="stats" served={result.served} />
      </p>
    </div>
  );
}

/**
 * Same height as the resolved widget, on purpose. React swaps this node for
 * the real one when the chunk arrives, and a fallback of a different size
 * moves the table underneath it — a layout shift the user did not ask for.
 */
export function OrgStatsFallback() {
  return (
    <div
      data-stats-fallback
      aria-busy="true"
      className="flex min-h-16 flex-col justify-center gap-1 rounded-lg border border-dashed border-black/[.12] px-4 py-3 text-xs text-zinc-400 dark:border-white/[.18] dark:text-zinc-500"
    >
      <p>inbox pulse · computing over every message in the org…</p>
      <p>the list below did not wait for this</p>
      {/* Three lines because the widget is three lines. Two, and the table
          under it moved 18px when the swap landed — visible as a jump between
          the fcp.png and loaded.png that `pnpm ui:paint` writes. */}
      <p className="font-mono">aggregate running on the API…</p>
    </div>
  );
}
