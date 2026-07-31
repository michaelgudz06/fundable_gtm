/**
 * The ceiling test: does this work if the input is fixed?
 *
 * The 400-row benchmark scored 12% recall on the accept path because a visitor
 * list carries no job title and every ICP gates on role. That is a statement
 * about the INPUT, and it leaves the important question open — if an
 * identification vendor supplied titles, would the classifier be good enough to
 * buy one for?
 *
 * This replays the same leads with a title attached, plus a Not Core control
 * that also gets a title, so the false-positive rate is measured on equal terms
 * rather than only the accept path being helped.
 *
 * HONEST CAVEAT, and it matters: the titles are extracted from the reference
 * classifier's own reasoning text. That is the title it had in hand when it
 * chose the label, so this measures an UPPER BOUND — a real vendor may return a
 * different, staler, or blanker title. It does not leak the label itself, and a
 * vendor-sourced rerun would be the honest confirmation.
 *
 *   npx tsx scripts/run-with-titles.ts
 */

import { readFileSync, writeFileSync } from "node:fs";
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
const BASE = "https://personalize-api-umber.vercel.app";
const KEY = env.PERSONALIZE_API_KEY ?? "";

type Lead = {
  email: string;
  linkedin: string;
  first: string;
  last: string;
  keyLabel: string;
  bucket: "core" | "not_core";
  title: string;
  company?: string | null;
};

async function classify(lead: Lead): Promise<{ label: string | null; status: number; ms: number }> {
  const started = Date.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${BASE}/api/v1/personalize`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          email: lead.email,
          linkedin_url: lead.linkedin || undefined,
          message_type: "website_visitor",
          template_id: "website_visitor_use_case",
          known_fields: {
            first_name: lead.first,
            title: lead.title,
            ...(lead.company ? { company_name: lead.company } : {}),
          },
          additional_context: { sender_name: "Jacob" },
        }),
      });
      const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { label: typeof j.icp === "string" ? j.icp : null, status: res.status, ms: Date.now() - started };
    } catch {
      /* retry once */
    }
  }
  return { label: null, status: 0, ms: Date.now() - started };
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
  const leads = JSON.parse(readFileSync(join(ROOT, "test-runs/with-titles-input.json"), "utf8")) as Lead[];
  const core = leads.filter((l) => l.bucket === "core");
  const control = leads.filter((l) => l.bucket === "not_core");
  process.stdout.write(`${core.length} core leads + ${control.length} Not Core control, with title + company supplied — what an identification vendor returns.\n\n`);

  let done = 0;
  const results = await mapLimit(leads, 5, async (lead) => {
    const r = await classify(lead);
    done++;
    if (done % 20 === 0) process.stdout.write(`  ${done}/${leads.length}\n`);
    return { lead, ...r };
  });

  const scored = results.filter((r) => r.status === 200);
  const coreR = scored.filter((r) => r.lead.bucket === "core");
  const ctrlR = scored.filter((r) => r.lead.bucket === "not_core");
  const isCore = (l: string | null) => !!l && l !== "Not Core ICP";

  const exact = coreR.filter((r) => r.label === r.lead.keyLabel).length;
  const anyCore = coreR.filter((r) => isCore(r.label)).length;
  const fps = ctrlR.filter((r) => isCore(r.label));

  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(0)}%` : "n/a");
  const lines: string[] = [];
  lines.push("# With titles supplied — the ceiling test");
  lines.push("");
  lines.push("Titles extracted from the reference classifier's own reasoning, so this is an");
  lines.push("UPPER BOUND on what a title-supplying vendor would achieve, not a prediction.");
  lines.push("");
  lines.push("| | without title (400-row run) | **with title** |");
  lines.push("|---|---|---|");
  lines.push(`| Core recall (any core label) | 12% (10/83) | **${pct(anyCore, coreR.length)} (${anyCore}/${coreR.length})** |`);
  lines.push(`| Exact-label recall | 6% (5/83) | **${pct(exact, coreR.length)} (${exact}/${coreR.length})** |`);
  lines.push(`| False positives on Not Core | 2/194 (1%) | **${pct(fps.length, ctrlR.length)} (${fps.length}/${ctrlR.length})** |`);
  lines.push("");

  const byLabel = new Map<string, { n: number; exact: number; core: number }>();
  for (const r of coreR) {
    const e = byLabel.get(r.lead.keyLabel) ?? { n: 0, exact: 0, core: 0 };
    e.n++;
    if (r.label === r.lead.keyLabel) e.exact++;
    if (isCore(r.label)) e.core++;
    byLabel.set(r.lead.keyLabel, e);
  }
  lines.push("## Per label");
  lines.push("");
  lines.push("| Reference label | rows | exact | any core |");
  lines.push("|---|---|---|---|");
  for (const [lab, e] of [...byLabel.entries()].sort((a, b) => b[1].n - a[1].n)) {
    lines.push(`| ${lab} | ${e.n} | ${e.exact} | ${e.core} |`);
  }
  lines.push("");

  if (fps.length) {
    lines.push("## New false positives (Not Core in the reference)");
    lines.push("");
    for (const r of fps) lines.push(`- **${r.lead.first} ${r.lead.last}** · ${r.lead.title} · ${r.lead.email} → \`${r.label}\``);
    lines.push("");
  }

  const missed = coreR.filter((r) => !isCore(r.label));
  if (missed.length) {
    lines.push("## Still Not Core despite a title");
    lines.push("");
    lines.push("| Person | title | reference label |");
    lines.push("|---|---|---|");
    for (const r of missed) lines.push(`| ${r.lead.first} ${r.lead.last} | ${r.lead.title} | ${r.lead.keyLabel} |`);
    lines.push("");
  }

  const md = lines.join("\n") + "\n";
  writeFileSync(join(ROOT, "test-runs/with-titles-report.md"), md);
  writeFileSync(join(ROOT, "test-runs/with-titles-results.json"), JSON.stringify(results, null, 2));
  process.stdout.write(`\n${md}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
