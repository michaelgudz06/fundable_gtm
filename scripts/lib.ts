/**
 * Shared plumbing for the operator scripts: argv, env, API config, bounded
 * concurrency, CSV. Plain functions only — each script keeps its own logic.
 *
 * Check: npx tsx --test scripts/lib.test.ts
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadRootEnv, requireEnv } from "../packages/fundable-shared/src/env.js";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `--name value` from argv, or the fallback. */
export function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  // A flag used as a bare switch (`--approve`) has no value after it, and
  // returning undefined there is how `--approve` came to crash with an opaque
  // EISDIR: resolve(undefined ?? "") is the CWD, and readFileSync on a
  // directory throws. Fall back to the default instead. The `--` guard stops
  // the next FLAG being eaten as this one's value.
  return v !== undefined && !v.startsWith("--") ? v : fallback;
}

/** Bare `--name` presence. */
export const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/** Where the API lives: `--base` overrides prod. */
export function apiBase(): string {
  return (arg("base", "https://personalize-api-umber.vercel.app") ?? "").replace(/\/$/, "");
}

/** The bearer key, from .env or the environment; throws by name if absent. */
export function apiKey(): string {
  loadRootEnv();
  return requireEnv("PERSONALIZE_API_KEY");
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i] as T, i);
      }
    })
  );
  return out;
}

/**
 * Minimal RFC4180 reader: quoted fields, escaped quotes, embedded newlines.
 * Strips a leading BOM and drops all-blank rows.
 */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}
