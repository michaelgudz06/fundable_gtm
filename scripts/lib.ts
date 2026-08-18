/**
 * Helpers every script in this directory had its own copy of.
 *
 * There were six copies of `loadEnv`, five of `arg`, four of `mapLimit` and two
 * of `parseCsv`. They were not identical, and the differences were not stylistic
 * — each is resolved here in favour of the copy that is correct on edge cases:
 *
 *   arg       four copies refuse to read the NEXT FLAG as this flag's value
 *             (`--csv --n 40` must not set csv="--n"); run-testset's older copy
 *             did. The guard is kept.
 *   mapLimit  three copies stop the worker when `items[i] === undefined`, which
 *             silently truncates the run at the first hole in the array. The
 *             bounds check is kept. The callback takes `(item, index)`; callers
 *             that ignore the index are unaffected.
 *   loadEnv   this now delegates to the shared package's `loadRootEnv`, which
 *             uses Node's own `process.loadEnvFile`. Verified to have the same
 *             precedence the hand-rolled copies had: an already-set process
 *             variable beats the file, so `FOO=x npx tsx …` still wins.
 *   parseCsv  the two copies were genuinely different functions, not duplicates
 *             — one returns raw rows, the other maps them onto header keys. The
 *             parser body is shared; both shapes remain.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRootEnv } from "@fundable/shared";

/** Repo root — every script resolved this the same way. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Loads the repo-root `.env` (if present) and returns the merged environment. */
export function loadEnv(): Record<string, string> {
  loadRootEnv();
  return process.env as Record<string, string>;
}

/** `--name value`. Returns `fallback` when the flag is absent or bare. */
export const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  // A bare switch (`--approve`) has no value after it, and the next token is
  // the next flag — reading it as this flag's value is how `--csv --n 40`
  // silently becomes csv="--n".
  return v !== undefined && !v.startsWith("--") ? v : fallback;
};

/** `--name` present, no value. */
export const flag = (name: string): boolean => process.argv.includes(`--${name}`);

/** Bounded-concurrency map that preserves input order. */
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
        out[i] = await fn(items[i]!, i);
      }
    })
  );
  return out;
}

/** RFC4180-ish CSV → raw rows. Handles quoted cells, `""` escapes and CRLF. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

/** Same parse, keyed by the header row. Strips the UTF-8 BOM Excel prepends. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows = parseCsvRows(text);
  const hdr = (rows.shift() ?? []).map((h) => h.replace(/^﻿/, "").trim());
  return rows.map((r) => Object.fromEntries(hdr.map((h, i) => [h, (r[i] ?? "").trim()])));
}
