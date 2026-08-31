import type { NextFunction, Request, Response } from 'express';
import {
  REQUEST_ID_HEADER,
  requestIdFor,
  runWithRequestContext,
} from './request-context';

export function requestContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = requestIdFor(req);
  res.setHeader(REQUEST_ID_HEADER, requestId);
  runWithRequestContext({ requestId, queries: 0, roundTrips: 0 }, next);
}
