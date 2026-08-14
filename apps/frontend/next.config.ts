import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // pino is on Next's automatic externals list; the OTel packages are not.
  // Bundling an SDK that resolves modules at runtime is how you get a provider
  // that registers into a *different* copy of @opentelemetry/api than the one
  // Next's own tracer holds — no error, no spans.
  serverExternalPackages: [
    '@opentelemetry/sdk-node',
    '@opentelemetry/exporter-trace-otlp-http',
  ],
  logging: {
    // Next's own dev request lines are not JSON and cannot be made JSON, so
    // the web stream is mixed format in development — stated in the drill's
    // writeup rather than hidden. What can be done is muting the one line that
    // is pure noise: Docker probes /health every 5 seconds on this service.
    incomingRequests: { ignore: [/^\/health$/] },
  },
};

export default nextConfig;
