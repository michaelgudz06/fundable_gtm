/**
 * Named sender-context blocks (PRD §4: `sender_context`), loaded from
 * config/sender/<name>.json at the workspace root.
 *
 * An unknown name is a warning, not an error — the message still writes, it just
 * loses the sender-side facts. `default` loads implicitly when the caller names
 * nothing.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SenderContext } from "./facts";

function senderDir(): string | null {
  // import.meta.url is unavailable after Next bundles this file to CJS, so walk
  // from cwd (the app dir under `next dev`, the repo root in tests) instead.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "config", "sender");
    try {
      readFileSync(join(candidate, "default.json"), "utf8");
      return candidate;
    } catch {
      // keep walking
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback for direct tsx runs where cwd is elsewhere entirely.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidate = resolve(here, "../../../../..", "config", "sender");
    readFileSync(join(candidate, "default.json"), "utf8");
    return candidate;
  } catch {
    return null;
  }
}

export function loadSenderContext(name: string | undefined): {
  sender: SenderContext | null;
  warnings: string[];
} {
  const id = name ?? "default";
  // The route already validated [a-z0-9_-]{1,64}; re-check anyway before it
  // becomes a path segment.
  if (!/^[a-z0-9_-]{1,64}$/i.test(id)) {
    return { sender: null, warnings: [`Invalid sender_context name; ignored.`] };
  }

  const dir = senderDir();
  if (!dir) {
    return { sender: null, warnings: ["config/sender not found; no sender facts available."] };
  }

  try {
    const parsed = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8")) as SenderContext;
    if (!Array.isArray(parsed.sender_facts)) {
      return { sender: null, warnings: [`sender_context "${id}" has no sender_facts array; ignored.`] };
    }
    return { sender: { ...parsed, id }, warnings: [] };
  } catch {
    return {
      sender: null,
      warnings: [`sender_context "${id}" not found; writing without sender facts.`],
    };
  }
}
