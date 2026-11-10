import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // PGlite ships a WASM Postgres build; it must be loaded by Node at runtime,
  // not bundled by webpack/turbopack.
  serverExternalPackages: ['@electric-sql/pglite'],
  experimental: {
    // Post-turn work (claim extraction, embeddings) runs after the response.
    serverActions: { bodySizeLimit: '2mb' },
  },
};

export default nextConfig;
