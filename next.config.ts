import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // This repo is checked out inside a larger workspace; pin the root so
  // Turbopack does not walk up to unrelated lockfiles.
  turbopack: { root: import.meta.dirname },
  // PGlite ships a WASM Postgres build; it must be loaded by Node at runtime,
  // not bundled by webpack/turbopack.
  serverExternalPackages: ['@electric-sql/pglite'],
  // The dev badge overlaps the composer and sidebar; compile/runtime errors still show.
  devIndicators: false,
};

export default nextConfig;
