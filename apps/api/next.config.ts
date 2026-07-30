import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @fundable/shared resolves to its built dist/ (plain ESM + .d.ts), so no
  // transpilePackages needed. The predev/prebuild scripts keep dist fresh.
};

export default nextConfig;
