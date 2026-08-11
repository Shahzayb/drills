import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import { Request } from 'express';

export const ORG_ID_HEADER = 'x-org-id';

/**
 * The stub that stands in for authentication.
 *
 * There is no auth in this repo on purpose, but tenant identity still has to
 * come from somewhere explicit. It arrives as a header rather than a query
 * param so it never sits in the same bag as `page` and `pageSize`: those are
 * things a caller may choose, the org is not. See
 * plans/2026-08-09_drill-03-conversation-list.md.
 *
 * When auth lands, only the body of this function changes — every controller
 * that reads `@OrgId()` keeps working.
 *
 * Deliberately does not check that the org exists: that is a query per request
 * to protect against a caller already trusted to name its own tenant. Card 07
 * revisits the whole seam.
 */
export const OrgId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const raw = request.header(ORG_ID_HEADER);

    if (raw === undefined || raw.trim() === '') {
      throw new BadRequestException(`${ORG_ID_HEADER} header is required`);
    }

    // Validated as an integer but returned as a string: org ids are bigint, and
    // `pg` hands bigints back as strings for the same reason — 2^53 is not far
    // enough away to round-trip one through a JS number safely.
    if (!/^[1-9][0-9]*$/.test(raw.trim())) {
      throw new BadRequestException(
        `${ORG_ID_HEADER} must be a positive integer`,
      );
    }

    return raw.trim();
  },
);
