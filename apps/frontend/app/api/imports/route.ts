import { uploadImport } from '@/lib/api';
import { NextRequest, NextResponse } from 'next/server';

const DEFAULT_ORG_ID = '1';

const FILENAME = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * The browser's way to reach `POST /imports`. Card 15.
 *
 * A Route Handler and not a Server Action, and the reason is the whole subject
 * of this drill. Next buffers a Server Action's body and rejects it past
 * `serverActions.bodySizeLimit` (1MB by default), so a 200MB upload through one
 * would put the file in the web tier's memory — the exact bug the API was just
 * taught not to have, one process earlier. A Route Handler has neither the
 * buffer nor the cap.
 *
 * Two content types, and only one of them is honest about memory:
 *
 *   text/csv               `request.body` is piped straight through. Bounded,
 *                          and what `curl --data-binary` and the instrument use.
 *   multipart/form-data    what a plain HTML file input sends. Reading a part
 *                          back out means `request.formData()`, which BUFFERS
 *                          the whole upload. Fine for the sample files the page
 *                          offers and wrong for 200MB, which is why the page
 *                          says so beside the control.
 *
 * The real answer for a large upload is a presigned PUT direct to object
 * storage, with the API told only the key. That is named in the drill's honest
 * gaps rather than built.
 */
export async function POST(request: NextRequest) {
  const orgId = request.nextUrl.searchParams.get('org') ?? DEFAULT_ORG_ID;
  const type = request.headers.get('content-type') ?? '';

  if (type.startsWith('multipart/form-data')) {
    const form = await request.formData();
    const file = form.get('file');

    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.redirect(
        new URL(`/imports?org=${orgId}&error=no-file`, request.url),
        303,
      );
    }

    const name = FILENAME.test(file.name) ? file.name : 'upload.csv';
    const result = await uploadImport({
      orgId,
      filename: name,
      body: file.stream(),
    });

    // 303, so the browser follows with a GET and a refresh does not re-post the
    // file. The job id is in the query only so the page can highlight the row.
    const url = result.ok
      ? `/imports?org=${orgId}&job=${result.job.id}`
      : `/imports?org=${orgId}&error=${encodeURIComponent(result.message)}`;

    return NextResponse.redirect(new URL(url, request.url), 303);
  }

  if (!request.body) {
    return NextResponse.json({ error: 'empty body' }, { status: 400 });
  }

  const raw = request.headers.get('x-filename')?.trim();
  const result = await uploadImport({
    orgId,
    filename: raw && FILENAME.test(raw) ? raw : 'upload.csv',
    body: request.body,
  });

  return result.ok
    ? NextResponse.json(result.job, { status: 202 })
    : NextResponse.json({ error: result.message }, { status: result.status || 502 }); // prettier-ignore
}
