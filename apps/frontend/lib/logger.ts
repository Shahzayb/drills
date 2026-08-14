import pino from 'pino';
import { TRACING_ENABLED, traceFields } from './trace';

/**
 * The web tier's half of the shared field set: time, level, svc, msg, rid.
 * Same shape as apps/backend/src/observability/logger.ts, so one grep reads
 * both without translating between two vocabularies.
 *
 * No bundler config needed — pino is on Next's automatic
 * serverExternalPackages list.
 */
/** Milliseconds since a performance.now() mark, at the precision logs use. */
export const since = (startedAt: number) =>
  Number((performance.now() - startedAt).toFixed(2));

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { svc: 'web' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  // Only when tracing is on, so with it off this config is byte-identical to
  // what phase 1's k6 A/B measured.
  ...(TRACING_ENABLED ? { mixin: traceFields } : {}),
});
