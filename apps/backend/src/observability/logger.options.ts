import type { Params } from 'nestjs-pino';
import { logger } from './logger';
import { PROBE_ROUTES } from './probes';
import { requestIdFor } from './request-context';

export const loggerOptions: Params = {
  pinoHttp: {
    logger,
    genReqId: (req) => requestIdFor(req),
    autoLogging: { ignore: (req) => PROBE_ROUTES.test(req.url ?? '') },
    customAttributeKeys: { responseTime: 'durMs', res: 'status' },
    customProps: (req) => ({ rid: requestIdFor(req) }),
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: () => 'http_request',
    customErrorMessage: () => 'http_request',
    serializers: {
      req: (req: { method: string; url: string }) => ({
        method: req.method,
        url: req.url,
      }),
      res: (res: { statusCode: number }) => res.statusCode,
    },
  },
};
