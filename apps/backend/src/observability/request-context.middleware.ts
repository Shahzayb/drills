import type { NextFunction, Request, Response } from 'express';
import {
  REQUEST_ID_HEADER,
  requestIdFor,
  runWithRequestContext,
} from './request-context';

/**
 * Establishes the request id and the async context every other layer reads.
 *
 * Middleware, not an interceptor: `next.handle()` is a lazy Observable, so the
 * handler runs on subscribe — outside anything the interceptor's pre-phase
 * wrapped — and the ALS store would be silently undefined in the service layer.
 * The response header goes here too, so 404s and 400s still carry it. See the
 * plan file.
 */
export function requestContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = requestIdFor(req);
  res.setHeader(REQUEST_ID_HEADER, requestId);
  runWithRequestContext({ requestId }, next);
}
