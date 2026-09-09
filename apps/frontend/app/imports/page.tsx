import { fetchImports, type ImportJob } from '@/lib/api';
import { logger, since } from '@/lib/logger';
import { renderStartedAt } from '@/lib/render-timing';
import { after } from 'next/server';

// Same stub as every other page: no auth in this repo, so the tenant is a URL
// parameter with a default.
const DEFAULT_ORG_ID = '1';

/** How often the page re-fetches itself while an import is running. Two
 *  seconds is a whole render and one indexed read per client, which is the
 *  price being paid for the progress bar. */
const POLL_SECONDS = 2;

/** `?a=1&a=2` gives an array. Take the first and move on. */
const first = (value: string | string[] | undefined, fallback: string) =>
  (Array.isArray(value) ? value[0] : value) ?? fallback;

const MEGABYTE = 1024 * 1024;

const mb = (bytes: number | null) =>
  bytes === null ? '—' : `${(bytes / MEGABYTE).toFixed(1)} MB`;

const count = (n: number) => n.toLocaleString();

/** Wall clock for one attempt. Running jobs are timed against now, so the
 *  number moves while you watch it. */
function elapsed(job: ImportJob): string {
  if (!job.startedAt) return '—';
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  return `${((end - Date.parse(job.startedAt)) / 1000).toFixed(1)}s`;
}

const STATUS_STYLE: Record<ImportJob['status'], string> = {
  pending: 'text-zinc-500 dark:text-zinc-400',
  running: 'text-blue-700 dark:text-blue-400',
  succeeded: 'text-green-700 dark:text-green-400',
  failed: 'text-red-700 dark:text-red-400',
};

/**
 * CSV imports. Card 15.
 *
 * Server Component, no client component, no application JavaScript. Progress is
 * a `<meta http-equiv="refresh">` that is rendered ONLY while a job is running,
 * which is the cheapest mechanism that answers the card's stretch: the write
 * side costs nothing at all — the worker's progress update rides a transaction
 * each batch was already paying for — and the read side is one index lookup on
 * `(org_id, created_at DESC)` every two seconds per open tab.
 *
 * A WebSocket or SSE stream would cost less per update and needs a subscription
 * this app does not have. That is recorded as a gap rather than smuggled in
 * here, and it is the same missing piece drill 14 named for the inbox.
 *
 * The upload control is for SMALL files and says so. A plain HTML file input
 * sends multipart/form-data, and reading a part back out buffers it — see
 * app/api/imports/route.ts. The 200MB path is `pnpm db:import fire`.
 *
 * See plans/2026-09-09_drill-15-streaming-csv-import.md.
 */
export default async function ImportsPage(props: PageProps<'/imports'>) {
  const startedAt = renderStartedAt();
  const searchParams = await props.searchParams;

  const orgId = first(searchParams.org, DEFAULT_ORG_ID);
  const highlight = first(searchParams.job, '');
  const error = first(searchParams.error, '');

  const result = await fetchImports(orgId);
  const jobs = result.ok ? result.jobs : [];
  const busy = jobs.some(
    (job) => job.status === 'running' || job.status === 'pending',
  );

  after(() =>
    logger.info(
      {
        route: '/imports',
        orgId,
        jobs: jobs.length,
        busy,
        totalMs: since(startedAt),
      },
      'page_render',
    ),
  );

  return (
    <div className="flex flex-1 flex-col bg-zinc-50 font-sans dark:bg-black">
      {/* Rendered only while something is moving. A page that polls forever is
          a page that costs a query per tab per two seconds for no reason. */}
      {busy ? (
        <meta httpEquiv="refresh" content={String(POLL_SECONDS)} />
      ) : null}

      <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-8 py-16">
        <div className="flex flex-col gap-3">
          <h1 className="text-2xl font-medium tracking-tight text-black dark:text-zinc-50">
            CSV imports
          </h1>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Historical tickets for org {orgId}.{' '}
            <a
              href={`/conversations?org=${orgId}`}
              className="text-zinc-500 underline hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50"
            >
              conversations
            </a>
          </p>
        </div>

        <form
          method="post"
          action={`/api/imports?org=${orgId}`}
          encType="multipart/form-data"
          className="flex flex-wrap items-center gap-3 rounded border border-black/[.12] bg-white px-4 py-3 dark:border-white/[.18] dark:bg-zinc-950"
        >
          <input
            type="file"
            name="file"
            accept=".csv,text/csv"
            required
            className="text-xs text-black dark:text-zinc-50"
          />
          <button
            type="submit"
            className="rounded border border-black/[.12] px-3 py-1 text-xs text-black hover:bg-zinc-100 dark:border-white/[.18] dark:text-zinc-50 dark:hover:bg-zinc-900"
          >
            Import
          </button>
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            Small files only — a browser upload is buffered by the web tier. Use{' '}
            <code className="font-mono">pnpm db:import fire</code> for 200MB.
          </span>
        </form>

        {error ? (
          <p className="rounded border border-red-600/30 bg-red-50 px-4 py-2 font-mono text-xs text-red-700 dark:bg-red-950/40 dark:text-red-400">
            {error}
          </p>
        ) : null}

        {!result.ok ? (
          <p className="font-mono text-xs text-red-700 dark:text-red-400">
            {result.error}
          </p>
        ) : null}

        {jobs.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No imports yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded border border-black/[.12] dark:border-white/[.18]">
            <table className="w-full border-collapse text-left font-mono text-xs">
              <thead className="bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  <th className="px-3 py-2 font-normal">file</th>
                  <th className="px-3 py-2 font-normal">status</th>
                  <th className="px-3 py-2 text-right font-normal">size</th>
                  <th className="px-3 py-2 text-right font-normal">read</th>
                  <th className="px-3 py-2 text-right font-normal">written</th>
                  <th className="px-3 py-2 text-right font-normal">skipped</th>
                  {/* The cursor a retry would trust. Shown because it is the
                      whole answer to "the import failed, now what". */}
                  <th className="px-3 py-2 text-right font-normal">
                    resume_row
                  </th>
                  <th className="px-3 py-2 text-right font-normal">elapsed</th>
                  <th className="px-3 py-2 text-right font-normal">peak RSS</th>
                  <th className="px-3 py-2 font-normal">arm</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr
                    key={job.id}
                    className={`border-t border-black/[.08] dark:border-white/[.12] ${
                      job.id === highlight
                        ? 'bg-zinc-100 dark:bg-zinc-900'
                        : undefined
                    }`}
                  >
                    <td className="px-3 py-2 text-black dark:text-zinc-50">
                      {job.filename}
                      {job.error ? (
                        <span className="block text-red-700 dark:text-red-400">
                          {job.error}
                        </span>
                      ) : null}
                    </td>
                    <td className={`px-3 py-2 ${STATUS_STYLE[job.status]}`}>
                      {job.status}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-600 dark:text-zinc-400">
                      {mb(job.byteSize)}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-600 dark:text-zinc-400">
                      {count(job.rowsRead)}
                    </td>
                    <td className="px-3 py-2 text-right text-black dark:text-zinc-50">
                      {count(job.rowsWritten)}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-600 dark:text-zinc-400">
                      {count(job.rowsSkipped)}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-600 dark:text-zinc-400">
                      {count(job.resumeRow)}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-600 dark:text-zinc-400">
                      {elapsed(job)}
                    </td>
                    <td className="px-3 py-2 text-right text-zinc-600 dark:text-zinc-400">
                      {mb(job.peakRssBytes)}
                    </td>
                    <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400">
                      {job.mode}/{job.batchRows}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          {busy
            ? `Refreshing every ${POLL_SECONDS}s while an import is running.`
            : 'Nothing running — the page has stopped polling.'}
        </p>
      </main>
    </div>
  );
}
