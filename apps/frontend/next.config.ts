import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  logging: {
    // Next's own dev request lines are not JSON and cannot be made JSON, so
    // the web stream is mixed format in development — stated in the drill's
    // writeup rather than hidden. What can be done is muting the one line that
    // is pure noise: Docker probes /health every 5 seconds on this service.
    incomingRequests: { ignore: [/^\/health$/] },
  },
};

export default nextConfig;
