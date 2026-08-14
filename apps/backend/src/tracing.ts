import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PROBE_ROUTES } from './observability/probes';
import { TRACING_ENABLED } from './observability/trace';

/**
 * OpenTelemetry. Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set — `pnpm trace:on`.
 *
 * Must finish before `@nestjs/core` is required: instrumentations patch a
 * module's exports *as it loads*, so `import './tracing';` first in main.ts is
 * the whole mechanism. Below any other import there is no error and no spans.
 * Hence the only app imports here are two constants files that pull nothing.
 *
 * Five named instrumentations, not `auto-instrumentations-node` (~40 packages
 * for stores this app does not have). Reasoning and the measured cost of
 * NodeSDK itself: plans/2026-08-13_drill-06-request-id-propagation.md.
 */
if (TRACING_ENABLED) {
  const sdk = new NodeSDK({
    // Becomes the `service.name` resource attribute — the name Jaeger's
    // dropdown shows. Same value as the logger's `svc`, deliberately.
    serviceName: 'api',
    // No arguments: the exporter reads OTEL_EXPORTER_OTLP_ENDPOINT itself and
    // appends /v1/traces. The env var is the switch and the address at once.
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({
        // The server span is the root of everything below it, so dropping it
        // here drops the whole probe trace rather than orphaning its children
        // — which is what a collector-side filter on the same routes would do.
        ignoreIncomingRequestHook: (req) => PROBE_ROUTES.test(req.url ?? ''),
      }),
      new ExpressInstrumentation(),
      new NestInstrumentation(),
      new PgInstrumentation({
        // The standard's version of PostgresService's `/* rid=... */`: appends
        // `traceparent='00-<trace>-<span>-01'` to the SQL text in sqlcommenter
        // format. Both comments ride the same statement, which is the point —
        // the Postgres log shows the hand-built one and the standard one on
        // one line, and only the second identifies the *span*.
        addSqlCommenterCommentToQueries: true,
      }),
      new IORedisInstrumentation(),
    ],
  });

  sdk.start();

  // Spans are batched, so without this the last second of a run is exported
  // never. Nest's own enableShutdownHooks does not know about the SDK.
  const flush = () => {
    void sdk.shutdown();
  };
  process.on('SIGTERM', flush);
  process.on('SIGINT', flush);
}
