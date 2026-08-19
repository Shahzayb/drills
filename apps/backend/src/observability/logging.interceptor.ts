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

/**
 * Logs what pino-http's automatic line cannot know: which controller and
 * handler ran, which org asked, and handler-only duration rather than the whole
 * Express round trip. Both lines are kept — pino-http fires from
 * res.on('finish') so it covers requests that never reach a handler, and the
 * difference between the two durations is Nest's own overhead.
 *
 * Also where card 08's query budget is enforced. That check has to run at
 * `info`, not just `debug` — a threshold nobody is watching by default is not
 * a threshold — so the bail-out below is narrower than it used to be: it now
 * skips work only when neither debug logging nor counting would read it.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const countingOn = QUERY_COUNTER_MODE !== 'off';
    const debugOn = logger.isLevelEnabled('debug');

    // Bail before doing any work when neither the debug line nor the budget
    // check would read it: no tap() in the chain, no performance.now(), no
    // payload object. This and the db_query guard are worth ~5-6% of
    // tail-org throughput with counting off — measured in
    // plans/2026-08-13_drill-06-request-id-propagation.md.
    if (context.getType() !== 'http' || (!debugOn && !countingOn)) {
      return next.handle();
    }

    const startedAt = performance.now();
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();

    // Handler metadata first, class metadata second — same precedence Nest's
    // own guards use. DEFAULT_QUERY_BUDGET applies to every route that
    // declares nothing, which is the point: this is meant to catch the N+1
    // nobody thought to annotate.
    const budget =
      this.reflector.getAllAndOverride<number>(QUERY_BUDGET_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? DEFAULT_QUERY_BUDGET;

    const finish = (status: number) => {
      const { queries = 0, roundTrips = 0 } = getRequestContext() ?? {};

      if (countingOn && queries > budget) {
        // warn, not debug: a threshold event has to survive the default
        // level or there is no point declaring one — same design as
        // PostgresService's slow_query.
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
            // Omitted rather than logged as 0 when QUERY_COUNTER=off: nothing
            // incremented them, and a zero that means "not counted" reads
            // exactly like a zero that means "made no queries".
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
        // On the error path the exception filter has not run yet, so
        // res.statusCode is still 200 — the exception is the only thing here
        // that knows the status this request is actually going to get.
        error: (error: unknown) =>
          finish(error instanceof HttpException ? error.getStatus() : 500),
      }),
    );
  }
}
