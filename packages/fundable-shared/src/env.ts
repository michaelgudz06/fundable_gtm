/**
 * Env loading for scripts and tests.
 *
 * Next.js loads `.env` itself, so the API app never needs this. Standalone runs
 * (smoke tests, one-off scripts) do — they get the repo-root `.env` without
 * pulling in dotenv, via Node's own loader (>=20.12).
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let loaded = false;

/** Walks up from this file to the repo root and loads `.env` if present. */
export function loadRootEnv(): void {
  if (loaded) return;
  loaded = true;

  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate) && existsSync(join(dir, "package.json"))) {
      // Only the workspace root carries both .env and the `workspaces` field.
      try {
        process.loadEnvFile(candidate);
      } catch {
        // Already-set vars win; a malformed file shouldn't kill the process.
      }
      return;
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
}

/** Throws with the variable name rather than failing deep inside a fetch. */
export function requireEnv(name: string): string {
  loadRootEnv();
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in (see the repo README).`
    );
  }
  return value;
}

export function optionalEnv(name: string): string | undefined {
  loadRootEnv();
  return process.env[name] || undefined;
}
