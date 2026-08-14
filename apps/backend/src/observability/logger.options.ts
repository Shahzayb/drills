import type { Params } from 'nestjs-pino';
import { logger } from './logger';
import { PROBE_ROUTES } from './probes';
import { requestIdFor } from './request-context';

/**
 * nestjs-pino's two jobs: the automatic per-request line, and routing Nest's
 * own internal logs through the same stream. It is handed the logger from
 * ./logger rather than making one, so there is one instance and one place the
 * field set is decided.
 *
 * Field set and what it leaves out: see the plan file.
 */
export const loggerOptions: Params = {
  pinoHttp: {
    logger,
    genReqId: (req) => requestIdFor(req),
    autoLogging: { ignore: (req) => PROBE_ROUTES.test(req.url ?? '') },
    // Same names every other event writes: one `durMs`, one `status`, one
    // `rid`, whichever layer produced the line. pino-http's own names are
    // `responseTime` and a nested `res.statusCode`; the res serializer below
    // flattens that to a bare number so this rename lands it top-level.
    customAttributeKeys: { responseTime: 'durMs', res: 'status' },
    // rid only. customProps is applied both when the per-request child logger
    // is created and again at response time, so anything here that changes
    // during the request (the status does — it is 200 until it isn't) comes out
    // as a duplicate key with two different values.
    customProps: (req) => ({ rid: requestIdFor(req) }),
    // Without this every 5xx is logged at `level: "info"` — the one line
    // guaranteed to exist for a failed request would look exactly as severe as
    // a success, and `grep '"level":"error"'` would never find a server error.
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: () => 'http_request',
    customErrorMessage: () => 'http_request',
    serializers: {
      // pino-http wraps this around its default, so `req` arrives already
      // serialized — headers included. Dropping them is the point: that is
      // where an Authorization header would land the day auth exists.
      //
      // `url` keeps the query string. Useful (which page, which sort) and a
      // deliberate exception to "no user-controlled text in logs" — the day a
      // token or an email can appear in a query param, this line has to change.
      req: (req: { method: string; url: string }) => ({
        method: req.method,
        url: req.url,
      }),
      // Just the number. Combined with the `res: 'status'` rename above this
      // yields a top-level `"status": 404` rather than a nested object.
      res: (res: { statusCode: number }) => res.statusCode,
    },
  },
};
