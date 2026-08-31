import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { TRACING_ENABLED } from './lib/trace';

if (TRACING_ENABLED) {
  const sdk = new NodeSDK({
    serviceName: 'web',
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [],
  });

  sdk.start();

  const flush = () => {
    void sdk.shutdown();
  };
  process.on('SIGTERM', flush);
  process.on('SIGINT', flush);
}
