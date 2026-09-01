import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { API_KEY_ORG } from './api-key.guard';

/**
 * The org `ApiKeyGuard` resolved, as a string for the reason `@OrgId()` gives:
 * org ids are bigint and `pg` hands bigints back as strings, because 2^53 is
 * not far enough away to round-trip one through a JS number safely.
 *
 * The counterpart to `@OrgId()`, and the difference between them is the drill.
 * `@OrgId()` reads a header the caller chose — the stub that stands in for
 * authentication. This one reads what authentication decided. A caller cannot
 * name its own tenant here, which is why `/ingest` ignores `X-Org-Id` entirely
 * rather than treating it as a fallback: a fallback would make the header a
 * bypass.
 *
 * Throws rather than returning undefined if the guard did not run. That is
 * unreachable while `@UseGuards(ApiKeyGuard)` is on the controller, and it is
 * the failure worth being loud about the day somebody removes it — the
 * alternative is `withOrg(undefined)`, which sets app.org_id to nothing and
 * quietly returns zero rows.
 */
export const ApiKeyOrg = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx
      .switchToHttp()
      .getRequest<Request & { [API_KEY_ORG]?: string }>();

    const orgId = request[API_KEY_ORG];
    if (!orgId) {
      throw new Error('ApiKeyGuard did not run — @ApiKeyOrg() has no org');
    }
    return orgId;
  },
);
