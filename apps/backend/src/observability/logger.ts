import pino from 'pino';
import { TRACING_ENABLED, traceFields } from './trace';

/** Milliseconds since a performance.now() mark, at the precision logs use. */
export const since = (startedAt: number) =>
  Number((performance.now() - startedAt).toFixed(2));

/**
 * A caught value as a log field. `String(unknown)` is what you reach for and it
 * yields '[object Object]' for anything thrown that isn't an Error — which is
 * the case worth reading.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error) ?? 'unserialisable error';
}

/**
 * The one pino instance this process writes through.
 *
 * A module-level const, not an injected PinoLogger: every line passes `rid`
 * explicitly anyway, so DI would buy nothing and would force every narrow test
 * graph (schema.e2e-spec.ts imports PostgresModule alone) to know about
 * logging. Mirrors apps/frontend/lib/logger.ts field for field.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // Replaces pino's default { pid, hostname }.
  base: { svc: 'api' },
  // Default is epoch millis; ISO-8601 is what makes `logs | sort` readable.
  timestamp: pino.stdTimeFunctions.isoTime,
  // Default is numeric (30/40/50). A string greps without a lookup table.
  formatters: { level: (label) => ({ level: label }) },
  // Spread rather than set unconditionally: with tracing off this object is
  // exactly what phase 1's k6 A/B measured, so that number stays honest. pino
  // calls a mixin only for lines that will actually be written, so the cost is
  // per emitted line rather than per log call.
  ...(TRACING_ENABLED ? { mixin: traceFields } : {}),
});
