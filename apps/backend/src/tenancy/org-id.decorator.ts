import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
} from '@nestjs/common';
import { Request } from 'express';

export const ORG_ID_HEADER = 'x-org-id';

export const OrgId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const raw = request.header(ORG_ID_HEADER);

    if (raw === undefined || raw.trim() === '') {
      throw new BadRequestException(`${ORG_ID_HEADER} header is required`);
    }

    if (!/^[1-9][0-9]*$/.test(raw.trim())) {
      throw new BadRequestException(
        `${ORG_ID_HEADER} must be a positive integer`,
      );
    }

    return raw.trim();
  },
);
