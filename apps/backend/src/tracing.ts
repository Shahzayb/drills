import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { IORedisInstrumentation } from '@opentelemetry/instrumentation-ioredis';
import { NestInstrumentation } from '@opentelemetry/instrumentation-nestjs-core';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { PROBE_ROUTES } from './observability/probes';
import { TRACING_ENABLED } from './observability/trace';

if (TRACING_ENABLED) {
  const sdk = new NodeSDK({
    serviceName: 'api',
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (req) => PROBE_ROUTES.test(req.url ?? ''),
      }),
      new ExpressInstrumentation(),
      new NestInstrumentation(),
      new PgInstrumentation({
        addSqlCommenterCommentToQueries: true,
      }),
      new IORedisInstrumentation(),
    ],
  });

  sdk.start();

  const flush = () => {
    void sdk.shutdown();
  };
  process.on('SIGTERM', flush);
  process.on('SIGINT', flush);
}
