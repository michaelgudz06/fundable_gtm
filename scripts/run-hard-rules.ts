/**
 * Scores the hard-rule fixtures (SPEC §6, "Rules and use cases", gate 100%).
 *
 * Distinct from the gold set on purpose. These fixtures assert rules the
 * registry already states, so the expected answer is derivable from
 * config/registry/icp_registry.json — which is why authoring them here is
 * legitimate and why they can never be used to claim accuracy. They answer one
 * question: does the running system obey its own registry?
 *
 *   npx tsx scripts/run-hard-rules.ts
 *   npx tsx scripts/run-hard-rules.ts --base http://localhost:3111
 *
 * A failure is not automatically a code bug. It may be a wrong expectation or a
 * company that changed. The report prints the classifier's reasoning next to
 * every miss so the two can be told apart without a second run.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* environment only */
  }
  return { ...out, ...process.env } as Record<string, string>;
}
const env = loadEnv();
const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const BASE = (arg("base", "https://personalize-api-umber.vercel.app") ?? "").replace(/\/$/, "");
const KEY = env.PERSONALIZE_API_KEY ?? "";

type Row = {
  id: string;
  rule: string;
  expect: string;
  email: string;
  title?: string;
  company?: string;
  why: string;
};

type Outcome = Row & { got: string | null; reasoning: string; agreement: string | null; status: number };

async function run(row: Row): Promise<Outcome> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${BASE}/api/classify`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          email: row.email,
          ...(row.title ? { title: row.title } : {}),
          ...(row.company ? { company: row.company } : {}),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return {
        ...row,
        status: res.status,
        got: typeof j.icp === "string" ? j.icp : null,
        reasoning: typeof j.reasoning === "string" ? j.reasoning : "",
        agreement: typeof j.agreement === "string" ? j.agreement : null,
      };
    } catch {
      /* one retry */
    }
  }
  return { ...row, status: 0, got: null, reasoning: "request failed", agreement: null };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        const item = items[i];
        if (item === undefined) return;
        out[i] = await fn(item);
      }
    })
  );
  return out;
}

async function main() {
  if (!KEY) throw new Error("PERSONALIZE_API_KEY missing.");
  const set = JSON.parse(readFileSync(join(ROOT, "config/eval/hard_rules.json"), "utf8")) as {
    version: string;
    rows: Row[];
  };
  process.stdout.write(`hard rules v${set.version}: ${set.rows.length} fixtures -> ${BASE}\n\n`);

  const results = await mapLimit(set.rows, 4, async (row) => {
    const r = await run(row);
    process.stdout.write(`  ${r.got === r.expect ? "PASS" : "FAIL"}  ${r.id.padEnd(26)} ${String(r.got)}\n`);
    return r;
  });

  const passed = results.filter((r) => r.got === r.expect);
  const failed = results.filter((r) => r.got !== r.expect);

  const L: string[] = [];
  L.push(`# Hard-rule fixtures — v${set.version}`);
  L.push("");
  L.push(`**${passed.length}/${results.length} pass.** Gate is 100%.`);
  L.push("");
  L.push("These assert rules the registry already states, so they measure adherence,");
  L.push("not accuracy. They are not the gold set and must not be scored as one.");
  L.push("");
  L.push("| fixture | rule | expected | got |");
  L.push("|---|---|---|---|");
  for (const r of results) {
    const mark = r.got === r.expect ? "" : " ⚠️";
    L.push(`| ${r.id}${mark} | ${r.rule} | ${r.expect} | ${r.got ?? `HTTP ${r.status}`} |`);
  }
  L.push("");

  if (failed.length) {
    L.push("## Failures, with the classifier's own reasoning");
    L.push("");
    L.push("A failure may mean the expectation is wrong, or the company changed — read");
    L.push("the reasoning before changing code.");
    L.push("");
    for (const r of failed) {
      L.push(`### ${r.id} — ${r.rule}`);
      L.push("");
      L.push(`- input: \`${r.email}\`${r.title ? ` · ${r.title}` : ""}${r.company ? ` @ ${r.company}` : ""}`);
      L.push(`- expected **${r.expect}**, got **${r.got ?? `HTTP ${r.status}`}**${r.agreement ? ` (votes ${r.agreement})` : ""}`);
      L.push(`- fixture's rationale: ${r.why}`);
      L.push(`- classifier said: ${r.reasoning || "—"}`);
      L.push("");
    }
  }

  const md = L.join("\n") + "\n";
  mkdirSync(join(ROOT, "test-runs"), { recursive: true });
  writeFileSync(join(ROOT, "test-runs/hard-rules-report.md"), md);
  process.stdout.write(`\n${passed.length}/${results.length} passed. Report: test-runs/hard-rules-report.md\n`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
