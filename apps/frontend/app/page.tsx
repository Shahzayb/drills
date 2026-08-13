import { fetchInfo } from '@/lib/api';
import { logger, since } from '@/lib/logger';
import { renderStartedAt } from '@/lib/render-timing';
import { after } from 'next/server';

export default async function Home() {
  const startedAt = renderStartedAt();
  const result = await fetchInfo();

  // Timed inside the callback: `after` runs once the response is finished, and
  // the flush is part of the render.
  after(() => {
    logger.info(
      {
        rid: result.requestId,
        route: '/',
        totalMs: since(startedAt),
        upstreamMs: result.durMs,
      },
      'page_render',
    );
  });

  return (
    <div className="flex flex-1 flex-col items-center justify-center bg-zinc-50 font-sans dark:bg-black">
      <main className="flex w-full max-w-3xl flex-col gap-8 px-16 py-24">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-black dark:text-zinc-50">
            Drill 01
          </h1>
          <p className="text-lg text-zinc-600 dark:text-zinc-400">
            This page is rendered by Next, which called the API by its Compose
            service name, which read the value below out of Postgres.
          </p>
        </div>

        {result.ok ? (
          <dl className="flex flex-col gap-4 rounded-lg border border-black/[.08] bg-white p-6 dark:border-white/[.145] dark:bg-zinc-950">
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-zinc-500 dark:text-zinc-400">
                Postgres reports
              </dt>
              <dd className="font-mono text-sm break-words text-black dark:text-zinc-50">
                {result.info.postgres.version}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-zinc-500 dark:text-zinc-400">
                Database server time
              </dt>
              <dd className="font-mono text-sm text-black dark:text-zinc-50">
                {result.info.postgres.serverTime}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-zinc-500 dark:text-zinc-400">Pool</dt>
              <dd className="font-mono text-sm text-black dark:text-zinc-50">
                {result.info.postgres.poolStats.total} open ·{' '}
                {result.info.postgres.poolStats.idle} idle ·{' '}
                {result.info.postgres.poolStats.waiting} waiting · max{' '}
                {result.info.postgres.poolStats.max}
              </dd>
            </div>
          </dl>
        ) : (
          <div className="flex flex-col gap-2 rounded-lg border border-red-200 bg-red-50 p-6 dark:border-red-900/50 dark:bg-red-950/30">
            <p className="font-medium text-red-900 dark:text-red-200">
              Could not reach the API
            </p>
            <p className="font-mono text-sm text-red-800 dark:text-red-300">
              {result.error}
            </p>
          </div>
        )}

        <p className="text-sm">
          <a
            href="/conversations"
            className="text-zinc-600 underline hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
          >
            Drill 03 — the conversation list →
          </a>
        </p>

        <p className="font-mono text-xs break-all text-zinc-500 dark:text-zinc-400">
          fetched from {result.source} in {result.durMs}ms
          <br />
          rid {result.requestId}
        </p>
      </main>
    </div>
  );
}
