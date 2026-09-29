import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { API_KEY_ORG } from '../ingest/api-key.guard';
import { ORG_ID_HEADER, ORG_ID_PATTERN } from '../tenancy/org-id.decorator';
import {
  ENTITLEMENT_HEADER,
  ENTITLEMENTS,
  EntitlementsService,
  Resolved,
} from './entitlements.service';

type EntitledRequest = Request & {
  [API_KEY_ORG]?: string;
  [ENTITLEMENTS]?: Resolved;
};

/**
 * Resolves the org's entitlements on every org-scoped request and meters API-key traffic.
 * An interceptor because global guards run before ApiKeyGuard and could not see the ingest org.
 */
@Injectable()
export class EntitlementsInterceptor implements NestInterceptor {
  constructor(private readonly entitlements: EntitlementsService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<EntitledRequest>();
    const response = http.getResponse<Response>();

    const keyOrg = request[API_KEY_ORG];
    const header = request.header(ORG_ID_HEADER)?.trim();
    const orgId =
      keyOrg ?? (header && ORG_ID_PATTERN.test(header) ? header : undefined);
    if (!orgId) return next.handle();

    const resolved = await this.entitlements.resolve(orgId);
    request[ENTITLEMENTS] = resolved;
    response.setHeader(ENTITLEMENT_HEADER, resolved.source);

    // The rule is "API-key traffic is metered", not a route list. First-party X-Org-Id calls are not.
    if (keyOrg) {
      const use = await this.entitlements.consumeIngest(
        orgId,
        resolved.entitlements,
      );
      if (use) {
        response.setHeader('x-ratelimit-limit', use.limit);
        response.setHeader(
          'x-ratelimit-remaining',
          Math.max(0, use.limit - use.count),
        );
        if (use.count > use.limit) {
          response.setHeader('retry-after', Math.ceil(use.resetMs / 1000));
          throw new HttpException(
            {
              error: 'rate_limited',
              message: `plan ${resolved.entitlements.plan} allows ${use.limit} ingests per minute`,
              plan: resolved.entitlements.plan,
              limit: use.limit,
            },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
      }
    }

    return next.handle();
  }
}
