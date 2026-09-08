import {
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
// `import type`, not a value import: with isolatedModules and
// emitDecoratorMetadata both on, a type named in a DECORATED signature has to be
// erased explicitly or TS1272 fails the build. Same rule as the ingest
// controller's Response.
import type { Request, Response } from 'express';
import { QueryBudget } from '../observability/query-budget.decorator';
import { OrgId } from '../tenancy/org-id.decorator';
import { IMPORT, ImportJob, ImportsService } from './imports.service';

/** What the browser or `curl` calls the file. Advisory only — it is stored for
 *  display and never used to build a path. */
const FILENAME_HEADER = 'x-filename';

const FILENAME = /^[A-Za-z0-9._-]{1,200}$/;

/**
 * CSV import. Card 15.
 *
 * Tenant identity is `@OrgId()`, the same stub `/conversations` uses, and not
 * the API key. An import is a customer action taken through the product; the
 * key belongs to the webhook receiver, which is a different caller.
 *
 * The body is raw `text/csv`, not multipart. Nest registers body parsers for
 * `json` and `urlencoded` only, so nothing consumes the request before this
 * handler does — which is what lets it be piped to disk instead of buffered.
 * Registering a `text/*` parser would put a 200MB string in memory one tier
 * above the code this drill measures, with no symptom other than the number.
 *
 * Two status codes, and the arm decides which:
 *
 *   202  IMPORT=stream — the file is spooled, the job row exists, the work has
 *        not happened yet. Poll GET /imports/:id.
 *   200  IMPORT=buffer — the import is finished, because the caller waited for
 *        the whole thing. On a 200MB file that is the forty-minute request the
 *        card describes.
 *
 * See plans/2026-09-09_drill-15-streaming-csv-import.md.
 */
@Controller('imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  // One statement: the INSERT that creates the job row. The spool is disk, not
  // Postgres. IMPORT=buffer breaches this budget by however many rows the file
  // has, on purpose — a naive arm that did not show up in the counter would be
  // a measurement arm nobody could see.
  @Post()
  @QueryBudget(1)
  async upload(
    @OrgId() orgId: string,
    @Req() request: Request,
    // passthrough, so Nest still serialises the returned object. A dynamic
    // status code has no decorator form; @HttpCode takes a constant.
    @Res({ passthrough: true }) response: Response,
  ): Promise<ImportJob> {
    const raw = request.header(FILENAME_HEADER)?.trim();
    const filename = raw && FILENAME.test(raw) ? raw : 'upload.csv';

    const job = await this.imports.receive(orgId, filename, request);

    response.status(IMPORT === 'buffer' ? 200 : 202);
    return job;
  }

  @Get()
  @QueryBudget(1)
  list(@OrgId() orgId: string): Promise<ImportJob[]> {
    return this.imports.list(orgId);
  }

  // `ParseUUIDPipe` for the reason the conversations controller states: without
  // it a non-uuid reaches Postgres and 22P02 surfaces as a 500, which reads as
  // the endpoint breaking rather than as a malformed request.
  @Get(':id')
  @QueryBudget(1)
  async get(
    @OrgId() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ImportJob> {
    const job = await this.imports.get(orgId, id);
    if (!job) throw new NotFoundException('import job not found');
    return job;
  }

  // 202 on both arms: a retry that returns the finished job would be a 200 on
  // `buffer` and a 202 on `stream`, and the difference is not something a
  // client should have to branch on for a route whose answer is always "ask
  // again". @QueryBudget(2) — the read that proves it exists, then the status
  // write. `buffer` breaches it the same way the upload does.
  @Post(':id/retry')
  @HttpCode(202)
  @QueryBudget(2)
  retry(
    @OrgId() orgId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ImportJob> {
    return this.imports.retry(orgId, id);
  }
}
