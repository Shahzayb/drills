import { Body, Controller, Post, Res, UseGuards } from '@nestjs/common';
// `import type`, not a value import. With isolatedModules and
// emitDecoratorMetadata both on, a type named in a DECORATED signature has to be
// erased explicitly or TS1272 fails the build — the compiler cannot emit
// metadata for a symbol it may be about to elide. Every other express import in
// this repo is a plain one because none of them sits in a decorated parameter.
import type { Response } from 'express';
import { QueryBudget } from '../observability/query-budget.decorator';
import { ApiKeyOrg } from './api-key-org.decorator';
import { ApiKeyGuard } from './api-key.guard';
import { IngestEventDto } from './dto/ingest-event.dto';
import { IngestResult, IngestService } from './ingest.service';

/**
 * The webhook receiver.
 *
 * The first route in this repo where tenant identity is *derived* rather than
 * asserted. Every other endpoint reads `@OrgId()`, the `X-Org-Id` header that
 * stands in for authentication; here the org comes out of the API key and
 * `X-Org-Id` is ignored completely. Treating it as a fallback would turn the
 * stub into a bypass on the one route that has real credentials.
 *
 * Three status codes, and the third is the interesting one:
 *
 *   201  created — this delivery produced a conversation
 *   200  duplicate — already handled, here is the same conversation id
 *   202  accepted — a concurrent delivery of this event is in flight and has
 *        not committed, so nobody can name the row yet. Retry.
 *
 * 202 only ever happens on `ON_CONFLICT=nothing` and on the pure `redis` arm.
 * It is a real answer, not an error: the alternative is to invent an id or to
 * block, and both are worse.
 *
 * See plans/2026-08-31_drill-12-idempotent-ingest.md.
 */
@Controller('ingest')
@UseGuards(ApiKeyGuard)
export class IngestController {
  constructor(private readonly ingest: IngestService) {}

  // Three, because the worst *supported* arm is ON_CONFLICT=nothing: the
  // guard's key lookup, the upsert, and the follow-up select. The `constraint`
  // and `both` arms run two, and IDEMPOTENCY=none runs four and breaches on
  // purpose — a naive arm that did not show up in the budget would be a
  // measurement arm nobody could see.
  @Post()
  @QueryBudget(3)
  async receive(
    @ApiKeyOrg() orgId: string,
    @Body() body: IngestEventDto,
    // passthrough, so Nest still serialises the returned object — @Res()
    // without it hands the whole response over and the body never gets written.
    // A dynamic status code has no decorator form; @HttpCode takes a constant.
    @Res({ passthrough: true }) response: Response,
  ): Promise<IngestResult> {
    const result = await this.ingest.ingest(orgId, body);

    response.status(
      result.outcome === 'created'
        ? 201
        : result.outcome === 'duplicate'
          ? 200
          : 202,
    );

    return result;
  }
}
