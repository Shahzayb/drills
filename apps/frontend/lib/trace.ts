import {
  context,
  isSpanContextValid,
  propagation,
  trace,
} from '@opentelemetry/api';

/**
 * The web tier's half of the log/trace join. Mirrors
 * apps/backend/src/observability/trace.ts, duplicated for the same reason the
 * two loggers are: `packages/` has no build wiring and one shared file is not
 * worth inventing it. The *field names* are the contract.
 */
export const TRACING_ENABLED = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);

/**
 * With no SDK registered `@opentelemetry/api` hands back a no-op span whose
 * context is all zeroes. isSpanContextValid is what rejects that, so callers
 * get undefined rather than an id nobody can look up.
 */
function activeSpanContext() {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && isSpanContextValid(spanContext)
    ? spanContext
    : undefined;
}

/**
 * snake_case on purpose — `trace_id`/`span_id` are what Grafana, Loki and
 * Datadog look for to turn a log line into a link to its trace.
 */
export function traceFields(): Record<string, string> {
  const spanContext = activeSpanContext();
  return spanContext
    ? { trace_id: spanContext.traceId, span_id: spanContext.spanId }
    : {};
}

/**
 * Write the active span into outgoing headers as W3C `traceparent`.
 *
 * Explicit, because Next does not do it: it creates an `AppRender.fetch` span
 * for every server-side fetch but never injects the propagation headers
 * (`patch-fetch.js` has no mention of traceparent). On the Nest side the same
 * job is done by instrumentation-http with no code at all — which is the whole
 * automatic-vs-explicit distinction in one hop.
 *
 * A no-op when nothing is registered: the API's default propagator does
 * nothing, so this is safe to call with tracing off.
 */
export function injectTraceContext(headers: Headers): void {
  propagation.inject(context.active(), headers, {
    set: (carrier, key, value) => carrier.set(key, value),
  });
}
