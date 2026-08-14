import { isSpanContextValid, trace } from '@opentelemetry/api';

/**
 * Whether this process is tracing.
 *
 * The same gate `src/tracing.ts` starts the SDK on, so that with tracing off
 * every consumer below compiles down to "do nothing" and the logger's
 * configuration is byte-identical to what the phase 1 k6 A/B measured.
 *
 * Read once at module load: it is a deployment-time switch, not a per-request
 * one, and re-reading process.env per log line is not free.
 */
export const TRACING_ENABLED = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);

/**
 * Safe to call with no SDK registered: `@opentelemetry/api` falls back to a
 * no-op span whose context is all zeroes, which isSpanContextValid rejects — so
 * callers get undefined, not an id nobody can look up.
 *
 * Load-bearing beyond that: isSpanContextValid checks the trace id against
 * `/^[0-9a-f]{32}$/i`, which is what lets deriveRequestId return it without
 * re-running the SQL-comment allowlist over it.
 */
function activeSpanContext() {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && isSpanContextValid(spanContext)
    ? spanContext
    : undefined;
}

/** The 32-hex trace id of the request being served, when there is one. */
export function currentTraceId(): string | undefined {
  return activeSpanContext()?.traceId;
}

/**
 * The fields that turn a log line into a link to its trace.
 *
 * snake_case, breaking this repo's camelCase, on purpose: `trace_id` and
 * `span_id` are the names Grafana, Loki and Datadog look for when they derive
 * a trace link from a log line. A local naming convention is not worth losing
 * that — an external contract beats internal consistency.
 */
export function traceFields(): Record<string, string> {
  const spanContext = activeSpanContext();
  return spanContext
    ? { trace_id: spanContext.traceId, span_id: spanContext.spanId }
    : {};
}
