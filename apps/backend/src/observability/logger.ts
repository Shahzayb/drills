import pino from 'pino';
import { TRACING_ENABLED, traceFields } from './trace';

export const since = (startedAt: number) =>
  Number((performance.now() - startedAt).toFixed(2));

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error) ?? 'unserialisable error';
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { svc: 'api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  ...(TRACING_ENABLED ? { mixin: traceFields } : {}),
});
