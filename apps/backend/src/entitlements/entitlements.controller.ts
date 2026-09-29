import { Body, Controller, Get, Header, Put, Req } from '@nestjs/common';
import type { Request } from 'express';
import { OrgId } from '../tenancy/org-id.decorator';
import { SetPlanDto } from './dto/set-plan.dto';
import {
  ENTITLEMENT_CACHE,
  ENTITLEMENT_TTL_S,
  ENTITLEMENTS,
  Entitlements,
  EntitlementsService,
  LookupSource,
  Resolved,
} from './entitlements.service';

export interface EntitlementsResponse extends Entitlements {
  orgId: string;
  source: LookupSource;
  /** How old the answer is. A hit near `ttlS` is about to be re-read. */
  ageMs: number;
  mode: string;
  ttlS: number;
}

@Controller()
export class EntitlementsController {
  constructor(private readonly entitlements: EntitlementsService) {}

  /** What this request was served, as the interceptor resolved it. The instruments poll this. */
  @Get('entitlements')
  current(
    @OrgId() orgId: string,
    @Req() request: Request & { [ENTITLEMENTS]?: Resolved },
  ): EntitlementsResponse {
    const { entitlements, source } = request[ENTITLEMENTS]!;
    return {
      orgId,
      ...entitlements,
      source,
      ageMs: Date.now() - entitlements.loadedAt,
      mode: ENTITLEMENT_CACHE,
      ttlS: ENTITLEMENT_TTL_S,
    };
  }

  /** The billing page's upgrade. The body is read from Postgres, so on `ttl` it disagrees with the cache. */
  @Put('entitlements/plan')
  setPlan(
    @OrgId() orgId: string,
    @Body() body: SetPlanDto,
  ): Promise<Entitlements> {
    return this.entitlements.setPlan(orgId, body.plan);
  }

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics(): string {
    return this.entitlements.metrics();
  }
}
