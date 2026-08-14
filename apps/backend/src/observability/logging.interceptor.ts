import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';
import { ORG_ID_HEADER } from '../tenancy/org-id.decorator';
import { logger, since } from './logger';
import { getRequestId } from './request-context';

/**
 * Logs what pino-http's automatic line cannot know: which controller and
 * handler ran, which org asked, and handler-only duration rather than the whole
 * Express round trip. Both lines are kept — pino-http fires from
 * res.on('finish') so it covers requests that never reach a handler, and the
 * difference between the two durations is Nest's own overhead.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Bail before doing any work when the line would be discarded: no tap()
    // in the chain, no performance.now(), no payload object. This and the
    // db_query guard are worth ~5-6% of tail-org throughput — measured in the
    // plan file.
    if (context.getType() !== 'http' || !logger.isLevelEnabled('debug')) {
      return next.handle();
    }

    const startedAt = performance.now();
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();

    const write = (status: number) =>
      logger.debug(
        {
          rid: getRequestId(),
          ctrl: context.getClass().name,
          handler: context.getHandler().name,
          orgId: request.header(ORG_ID_HEADER),
          status,
          durMs: since(startedAt),
        },
        'handler',
      );

    return next.handle().pipe(
      tap({
        next: () => write(http.getResponse<Response>().statusCode),
        // On the error path the exception filter has not run yet, so
        // res.statusCode is still 200 — the exception is the only thing here
        // that knows the status this request is actually going to get.
        error: (error: unknown) =>
          write(error instanceof HttpException ? error.getStatus() : 500),
      }),
    );
  }
}
