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
 *   201  created — this delivery produced a conversation and moved the meter
 *   200  duplicate — already handled, here is the same conversation id, and
 *        the meter did NOT move
 *   202  accepted — a concurrent delivery of this event is in flight and has
 *        not committed, so nobody can name the row yet. Retry.
 *   503  QUOTA=serializable only: the transaction restarted QUOTA_MAX_RETRIES
 *        times and gave up. Card 13 — see TenantDb.withOrg.
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

  // Four since card 13. The shipped default (`both` + `atomic`) runs three —
  // the guard's key lookup, the upsert CTE that carries the ledger row, and the
  // counter — and the worst *supported* combination adds one: either
  // ON_CONFLICT=nothing's follow-up select or the read half of QUOTA=rmw.
  //
  // Combinations past that breach on purpose. IDEMPOTENCY=none runs five, and a
  // QUOTA=serializable request that retried runs more still — which is correct,
  // because it really did make those round trips, and it turns the budget into
  // a second readout of the retry rate. A naive arm that did not show up in the
  // budget would be a measurement arm nobody could see.
  @Post()
  @QueryBudget(4)
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
