import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { TRACING_ENABLED } from './lib/trace';

/**
 * The web tier's SDK. Same gate and same shape as the API's src/tracing.ts,
 * with one difference worth understanding.
 */
if (TRACING_ENABLED) {
  const sdk = new NodeSDK({
    serviceName: 'web',
    traceExporter: new OTLPTraceExporter(),
    // Empty, and not an oversight. Next already emits its own spans —
    // BaseServer.handleRequest, AppRender.fetch, AppRender.getBodyResult and a
    // dozen more — through `@opentelemetry/api`, which it declares as a peer
    // dependency. All this has to do is register a provider for them to land
    // in. Nothing is monkey-patched, which sidesteps the failure mode
    // auto-instrumentation has inside a bundled Next server, and it is why the
    // render-vs-fetch split arrives for free.
    //
    // The cost of the empty list is the outgoing hop: nothing patches fetch, so
    // `traceparent` is injected by hand in lib/api.ts.
    instrumentations: [],
  });

  sdk.start();

  // Spans are batched; without a flush the last second of a run is exported
  // never.
  const flush = () => {
    void sdk.shutdown();
  };
  process.on('SIGTERM', flush);
  process.on('SIGINT', flush);
}
