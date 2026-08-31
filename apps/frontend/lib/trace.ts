import {
  context,
  isSpanContextValid,
  propagation,
  trace,
} from '@opentelemetry/api';

export const TRACING_ENABLED = Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);

function activeSpanContext() {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && isSpanContextValid(spanContext)
    ? spanContext
    : undefined;
}

export function traceFields(): Record<string, string> {
  const spanContext = activeSpanContext();
  return spanContext
    ? { trace_id: spanContext.traceId, span_id: spanContext.spanId }
    : {};
}

export function injectTraceContext(headers: Headers): void {
  propagation.inject(context.active(), headers, {
    set: (carrier, key, value) => carrier.set(key, value),
  });
}
