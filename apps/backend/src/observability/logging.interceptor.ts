import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import {
  DEFAULT_QUERY_BUDGET,
  QUERY_BUDGET_KEY,
} from './query-budget.decorator';
import { QUERY_COUNT_HEADER, QUERY_COUNTER_MODE } from './query-counter';
import { ORG_ID_HEADER } from '../tenancy/org-id.decorator';
import { logger, since } from './logger';
import { getRequestContext, getRequestId } from './request-context';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const countingOn = QUERY_COUNTER_MODE !== 'off';
    const debugOn = logger.isLevelEnabled('debug');

    if (context.getType() !== 'http' || (!debugOn && !countingOn)) {
      return next.handle();
    }

    const startedAt = performance.now();
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();

    const budget =
      this.reflector.getAllAndOverride<number>(QUERY_BUDGET_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_QUERY_BUDGET;

    const finish = (status: number) => {
      const { queries = 0, roundTrips = 0 } = getRequestContext() ?? {};

      if (countingOn && queries > budget) {
        logger.warn(
          {
            rid: getRequestId(),
            ctrl: context.getClass().name,
            handler: context.getHandler().name,
            orgId: request.header(ORG_ID_HEADER),
            queries,
            budget,
          },
          'query_budget_exceeded',
        );
      }

      if (QUERY_COUNTER_MODE === 'header') {
        http.getResponse<Response>().setHeader(QUERY_COUNT_HEADER, queries);
      }

      if (debugOn) {
        logger.debug(
          {
            rid: getRequestId(),
            ctrl: context.getClass().name,
            handler: context.getHandler().name,
            orgId: request.header(ORG_ID_HEADER),
            status,
            ...(countingOn ? { queries, roundTrips } : {}),
            durMs: since(startedAt),
          },
          'handler',
        );
      }
    };

    return next.handle().pipe(
      tap({
        next: () => finish(http.getResponse<Response>().statusCode),
        error: (error: unknown) =>
          finish(error instanceof HttpException ? error.getStatus() : 500),
      }),
    );
  }
}
