import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: [
    '@opentelemetry/sdk-node',
    '@opentelemetry/exporter-trace-otlp-http',
  ],
  logging: {
    incomingRequests: { ignore: [/^\/health$/] },
  },
};

export default nextConfig;
