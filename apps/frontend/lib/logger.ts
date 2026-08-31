import pino from 'pino';
import { TRACING_ENABLED, traceFields } from './trace';

export const since = (startedAt: number) =>
  Number((performance.now() - startedAt).toFixed(2));

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { svc: 'web' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  ...(TRACING_ENABLED ? { mixin: traceFields } : {}),
});
