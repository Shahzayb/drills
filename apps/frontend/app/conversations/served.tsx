import type { Served } from '@/lib/api';

/** `12.4s old` / `0.3s old`, on one decimal so a memo (a few ms) reads as
 *  `0.0s` rather than as nothing. */
export const age = (ms: number) => `${(ms / 1000).toFixed(1)}s old`;

/**
 * One fetch's evidence line. Card 18.
 *
 * A Server Component, a few lines of markup, used by the inbox footer, the
 * detail page and the stats widget — the reason it is a component and not
 * three copies. The attributes are the part that matters: Playwright reads
 * `data-served`, the k6 script greps it out of the HTML, and a human reads the
 * words. `filled by rid` is the id `pnpm logs:trace` wants. When it is this
 * page's own id the entry was filled a moment ago by this same render (the
 * per-render dedupe); when it is another id, the API did not run for this
 * render at all — and that mismatch IS the evidence.
 */
export function ServedLine({
  name,
  served,
  pageRid,
}: {
  name: string;
  served: Served;
  /** This render's own id, so a cache answer can say who filled it. */
  pageRid?: string;
}) {
  const thisRender = served.from === 'cache' && served.rid === pageRid;
  return (
    <span
      data-fetch={name}
      data-served={served.from}
      data-filled-by={thisRender ? 'this-render' : undefined}
      data-rid={served.rid}
    >
      {name}: {served.from}
      {served.from === 'cache' && ` · ${age(served.ageMs)}`}
      {served.rid &&
        (served.from === 'origin'
          ? ` · rid ${served.rid}`
          : thisRender
            ? ' · filled by this render'
            : ` · filled by rid ${served.rid}`)}
    </span>
  );
}
