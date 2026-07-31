import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app lives in a workspace and imports from packages/fundable-shared and
  // config/ at the repo root. Without this the tracer stops at apps/api and
  // those files never reach the serverless bundle.
  outputFileTracingRoot: path.join(__dirname, "../../"),

  // config/*.json is imported statically (see src/lib/config-registry.ts), so
  // the bundler already carries it. This is belt-and-braces for the traced
  // output, and cheap — it is a handful of small JSON files.
  outputFileTracingIncludes: {
    "/*": ["../../config/**/*.json"],
  },
};

export default nextConfig;
