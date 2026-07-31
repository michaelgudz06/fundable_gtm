/**
 * Runs a real lead list through POST /api/v1/personalize and scores the result
 * against the human annotations that came with the list.
 *
 * This exists because Jacob's acceptance bar is not "the fixtures pass" — it is
 * "these will be sent to people". The only honest way to measure that is to
 * replay a list he has already judged by hand and look at every disagreement.
 *
 *   npx tsx scripts/run-testset.ts                      # prod, baseline fields
 *   npx tsx scripts/run-testset.ts --domain             # also pass company_domain
 *   npx tsx scripts/run-testset.ts --base http://localhost:3111
 *
 * Writes <out>/results-<variant>.json (every request/response verbatim) and
 * report-<variant>.md (the scoreboard + disagreements).
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* fall through to process.env */
  }
  return { ...out, ...process.env } as Record<string, string>;
}

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

type Row = {
  id: string;
  expected: "notified" | "not_in_icp";
  sent: "sent" | "skipped" | "existing_customer";
  linkedin_url: string;
  first_name: string;
  last_name: string;
  title: string;
  company_name: string;
  email: string;
  company_website: string;
  industry: string;
  size: string;
  city: string;
};

type Outcome = {
  row: Row;
  request: unknown;
  status: number;
  ms: number;
  icp: string | null;
  use_case_ids: string[];
  email_body: string | null;
  error_code: string | null;
  error_message: string | null;
  headers: Record<string, string>;
  /** How this row lands against Jacob's annotation. */
  verdict: "agree_core" | "agree_not_core" | "false_positive" | "false_negative" | "no_output" | "request_error";
};

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function callOne(base: string, key: string, row: Row, withDomain: boolean): Promise<Outcome> {
  const known: Record<string, string> = {};
  if (row.first_name) known.first_name = row.first_name;
  if (row.title) known.title = row.title;
  if (row.company_name) known.company_name = row.company_name;
  if (withDomain && row.company_website) known.company_domain = row.company_website;

  const request = {
    email: row.email,
    linkedin_url: row.linkedin_url || undefined,
    message_type: "website_visitor",
    template_id: "website_visitor_use_case",
    known_fields: known,
    additional_context: { sender_name: "Jacob" },
  };

  const started = Date.now();
  let status = 0;
  let json: Record<string, unknown> = {};
  let headers: Record<string, string> = {};
  try {
    const res = await fetch(`${base}/api/v1/personalize`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(request),
    });
    status = res.status;
    for (const [k, v] of res.headers) if (k.toLowerCase().startsWith("x-")) headers[k] = v;
    json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  } catch (e) {
    status = 0;
    json = { error: { code: "TRANSPORT", message: (e as Error).message } };
  }
  const ms = Date.now() - started;

  const err = (json.error ?? null) as { code?: string; message?: string } | null;
  const icp = typeof json.icp === "string" ? json.icp : null;
  const useCases = Array.isArray(json.icp_use_cases)
    ? (json.icp_use_cases as { id?: string }[]).map((u) => u.id ?? "?")
    : [];
  const emailBody = typeof json.email_body === "string" ? json.email_body : null;

  const isCore = icp !== null && icp !== "Not Core ICP";
  let verdict: Outcome["verdict"];
  if (status !== 200) {
    // A gate that refuses to answer is not a classification. It still means no
    // personalized email exists for this row, which is worth counting separately.
    verdict = status === 400 || status === 409 ? "no_output" : "request_error";
  } else if (row.expected === "notified") {
    verdict = isCore ? "agree_core" : "false_negative";
  } else {
    verdict = isCore ? "false_positive" : "agree_not_core";
  }

  return {
    row,
    request,
    status,
    ms,
    icp,
    use_case_ids: useCases,
    email_body: emailBody,
    error_code: err?.code ?? null,
    error_message: err?.message ?? null,
    headers,
    verdict,
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = next++;
        const item = items[i];
        if (item === undefined) return;
        out[i] = await fn(item, i);
      }
    })
  );
  return out;
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const VERDICT_LABEL: Record<Outcome["verdict"], string> = {
  agree_core: "agree (core)",
  agree_not_core: "agree (not core)",
  false_positive: "DISAGREE — we say core, list says not",
  false_negative: "DISAGREE — we say not core, list says core",
  no_output: "no output (hard gate)",
  request_error: "ERROR",
};

function pct(n: number, d: number): string {
  return d === 0 ? "n/a" : `${((n / d) * 100).toFixed(0)}%`;
}

function report(results: Outcome[], meta: { base: string; variant: string; startedAt: string }): string {
  const counts = (v: Outcome["verdict"]) => results.filter((r) => r.verdict === v).length;
  const scored = results.filter((r) => r.status === 200);
  const agree = counts("agree_core") + counts("agree_not_core");
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  const p = (q: number) => ms[Math.min(ms.length - 1, Math.floor(ms.length * q))] ?? 0;

  const lines: string[] = [];
  lines.push(`# Website-visitor test set — ${meta.variant}`);
  lines.push("");
  lines.push(`Run ${meta.startedAt} against \`${meta.base}\`. ${results.length} rows from Jacob's export.`);
  lines.push("");
  lines.push("## Scoreboard");
  lines.push("");
  lines.push("| | count |");
  lines.push("|---|---|");
  lines.push(`| Rows | ${results.length} |`);
  lines.push(`| Classified (HTTP 200) | ${scored.length} |`);
  lines.push(`| Agreement with the list | ${agree}/${scored.length} (${pct(agree, scored.length)}) |`);
  lines.push(`| — agree, core ICP | ${counts("agree_core")} |`);
  lines.push(`| — agree, Not Core | ${counts("agree_not_core")} |`);
  lines.push(`| Disagree — we say core | ${counts("false_positive")} |`);
  lines.push(`| Disagree — we say Not Core | ${counts("false_negative")} |`);
  lines.push(`| Hard gate, no output | ${counts("no_output")} |`);
  lines.push(`| Errors | ${counts("request_error")} |`);
  lines.push(`| Latency p50 / p95 / max | ${p(0.5)}ms / ${p(0.95)}ms / ${ms[ms.length - 1] ?? 0}ms |`);
  const handler = results
    .map((r) => Number(r.headers["x-handler-ms"] ?? NaN))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  if (handler.length) {
    const hp = (q: number) => handler[Math.min(handler.length - 1, Math.floor(handler.length * q))] ?? 0;
    lines.push(`| In-handler p50 / p95 / max | ${hp(0.5)}ms / ${hp(0.95)}ms / ${handler[handler.length - 1] ?? 0}ms |`);
    const overhead = results
      .map((r) => r.ms - Number(r.headers["x-handler-ms"] ?? NaN))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    lines.push(`| Platform overhead (cold boot + queue + network) max | ${overhead[overhead.length - 1] ?? 0}ms |`);
  }
  lines.push("");

  lines.push("## Every row");
  lines.push("");
  lines.push("| # | Person | Title @ Company | Email | List says | API says | Verdict | ms |");
  lines.push("|---|---|---|---|---|---|---|---|");
  results.forEach((r, i) => {
    const api = r.status === 200 ? r.icp : `${r.status} ${r.error_code ?? ""}`;
    const said = r.row.expected === "notified" ? "in ICP" : "not in ICP";
    lines.push(
      `| ${i + 1} | ${r.row.first_name} ${r.row.last_name} | ${r.row.title || "—"} @ ${r.row.company_name || "—"} | ${r.row.email || "—"} | ${said} | ${api} | ${VERDICT_LABEL[r.verdict]} | ${r.ms} |`
    );
  });
  lines.push("");

  const interesting = results.filter(
    (r) => r.verdict === "false_positive" || r.verdict === "false_negative" || r.verdict === "no_output" || r.verdict === "request_error"
  );
  if (interesting.length) {
    lines.push("## Rows that need a human");
    lines.push("");
    for (const r of interesting) {
      lines.push(`### ${r.row.first_name} ${r.row.last_name} — ${VERDICT_LABEL[r.verdict]}`);
      lines.push("");
      lines.push(`- Title/company: ${r.row.title || "(none)"} @ ${r.row.company_name || "(none)"}`);
      lines.push(`- Email: ${r.row.email || "(none)"} · site: ${r.row.company_website || "(none)"}`);
      lines.push(`- List annotation: ${r.row.expected} (outreach: ${r.row.sent})`);
      lines.push(`- API: HTTP ${r.status}${r.icp ? ` · ${r.icp}` : ""}${r.error_code ? ` · ${r.error_code}: ${r.error_message}` : ""}`);
      lines.push("");
    }
  }

  const sample = results.find((r) => r.verdict === "agree_core") ?? results.find((r) => r.status === 200);
  if (sample?.email_body) {
    lines.push("## Sample body");
    lines.push("");
    lines.push(`${sample.row.first_name} ${sample.row.last_name} — ${sample.icp}`);
    lines.push("");
    lines.push("```");
    lines.push(sample.email_body);
    lines.push("```");
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------

async function main() {
  const env = loadEnv();
  const base = (arg("base", "https://personalize-api-umber.vercel.app") ?? "").replace(/\/$/, "");
  const key = env.PERSONALIZE_API_KEY;
  if (!key) throw new Error("PERSONALIZE_API_KEY missing (.env or environment).");
  const withDomain = flag("domain");
  const variant = withDomain ? "with-domain" : "baseline";
  const concurrency = Number(arg("concurrency", "4"));
  const outDir = resolve(arg("out", join(ROOT, "test-runs")) ?? "");
  mkdirSync(outDir, { recursive: true });

  const fixture = JSON.parse(
    readFileSync(join(ROOT, "apps/api/test/fixtures/website-visitors.json"), "utf8")
  ) as { rows: Row[] };
  const limit = Number(arg("limit", String(fixture.rows.length)));
  const rows = fixture.rows.slice(0, limit);

  const startedAt = new Date().toISOString();
  process.stdout.write(`${variant}: ${rows.length} rows -> ${base} (concurrency ${concurrency})\n`);

  const results = await mapLimit(rows, concurrency, async (row) => {
    const r = await callOne(base, key, row, withDomain);
    const shown = r.status === 200 ? r.icp : `HTTP ${r.status} ${r.error_code ?? ""}`;
    process.stdout.write(`  ${r.verdict === "agree_core" || r.verdict === "agree_not_core" ? "ok " : "!! "}${row.id.padEnd(22)} ${String(shown).padEnd(34)} ${r.ms}ms\n`);
    return r;
  });

  writeFileSync(join(outDir, `results-${variant}.json`), JSON.stringify({ meta: { base, variant, startedAt }, results }, null, 2));
  const md = report(results, { base, variant, startedAt });
  writeFileSync(join(outDir, `report-${variant}.md`), md);
  process.stdout.write(`\n${md.split("## Every row")[0]}\nWrote ${outDir}/report-${variant}.md\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
