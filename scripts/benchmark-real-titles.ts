/**
 * Does the visitor feed's own Title column close the accept-path gap?
 *
 * Every accuracy number this project has reported rests on a claim that turns
 * out to be false. `run-icp-benchmark` states it outright: "This API received
 * only an email and a LinkedIn URL." `run-with-titles` measured the ceiling by
 * scraping titles out of the reference classifier's REASONING PROSE, and called
 * that an honest caveat.
 *
 * The Orange Slice export has a real `Title` column, populated on 78.8% of
 * 1511 rows, with `Company Name` at 86.4% and `LinkedIn URL` at 98.8%. The
 * titles were there the whole time. "The accept path is input-bound at 12%"
 * was measuring a pipeline that threw away data it already had, and the fix is
 * a field in a POST body rather than a vendor negotiation.
 *
 * So this runs the SAME rows through both arms:
 *
 *   bare    email + linkedin            (what the benchmarks have been measuring)
 *   titled  email + linkedin + title + company
 *
 * Paired on identical rows, so the delta is the effect of the field and not of
 * sampling. Reports recall on core labels and precision on Not Core separately,
 * because a title lifts both and only one of them is good news.
 *
 *   npx tsx scripts/benchmark-real-titles.ts --csv <export.csv> [--base <url>] [--core 70] [--notcore 30]
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  return v !== undefined && !v.startsWith("--") ? v : d;
};

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* env only */
  }
  return { ...out, ...process.env } as Record<string, string>;
}
const env = loadEnv();
const KEY = env.PERSONALIZE_API_KEY ?? "";
const BASE = (arg("base", "http://localhost:3111") ?? "").replace(/\/$/, "");

// --- CSV ---------------------------------------------------------------------

function parseCsv(text: string): Record<string, string>[] {
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
  const hdr = (rows.shift() ?? []).map((h) => h.replace(/^﻿/, "").trim());
  return rows
    .filter((r) => r.some((c) => c.trim()))
    .map((r) => Object.fromEntries(hdr.map((h, i) => [h, (r[i] ?? "").trim()])));
}

/** The export packs label and rationale into one cell: "ICP #6: Founder — because…". */
function refLabel(r: Record<string, string>): string {
  const v = (r["In ICP"] ?? "").trim();
  if (!v) return "";
  return v.split("—")[0]!.trim();
}

// --- calling -----------------------------------------------------------------

type Arm = "bare" | "titled";

async function classify(r: Record<string, string>, arm: Arm): Promise<string | null> {
  const body: Record<string, string> = { email: r["Business Email"] || r["Found Email"] || "" };
  if (r["LinkedIn URL"]) body.linkedin = r["LinkedIn URL"];
  if (arm === "titled") {
    if (r["Title"]) body.title = r["Title"];
    if (r["Company Name"]) body.company = r["Company Name"];
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise((s) => setTimeout(s, 500 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(`${BASE}/api/classify`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify(body),
      });
      if (res.status === 200) {
        const j = (await res.json()) as Record<string, unknown>;
        return typeof j.icp === "string" ? j.icp : null;
      }
      if (res.status < 500 && res.status !== 429) return null;
    } catch {
      /* retry */
    }
  }
  return null;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
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

// --- main --------------------------------------------------------------------

async function main() {
  if (!KEY) throw new Error("PERSONALIZE_API_KEY missing.");
  const csvPath = arg("csv");
  if (!csvPath) throw new Error("--csv <export.csv> is required");
  const all = parseCsv(readFileSync(csvPath, "utf8"));

  const usable = all.filter((r) => (r["Business Email"] || r["Found Email"]) && refLabel(r));
  const core = usable.filter((r) => refLabel(r).startsWith("ICP #"));
  const notCore = usable.filter((r) => refLabel(r) === "Not Core ICP");

  // Take every core row up to the cap — they are the scarce signal and the rare
  // labels vanish under random sampling. Not Core is abundant; a slice is fine.
  const nCore = Number(arg("core", "70"));
  const nNot = Number(arg("notcore", "30"));
  const sample = [...core.slice(0, nCore), ...notCore.slice(0, nNot)];

  process.stdout.write(
    `${usable.length} usable rows (${core.length} core, ${notCore.length} Not Core)\n` +
      `sampling ${sample.length} -> ${BASE}\n` +
      `title present on ${sample.filter((r) => r["Title"]).length}/${sample.length} sampled rows\n\n`
  );

  const results: { row: Record<string, string>; ref: string; bare: string | null; titled: string | null }[] = [];
  let done = 0;
  await mapLimit(sample, 2, async (r) => {
    const [bare, titled] = [await classify(r, "bare"), await classify(r, "titled")];
    results.push({ row: r, ref: refLabel(r), bare, titled });
    if (++done % 10 === 0) process.stdout.write(`  ${done}/${sample.length}\n`);
  });

  const coreRes = results.filter((x) => x.ref.startsWith("ICP #"));
  const notRes = results.filter((x) => x.ref === "Not Core ICP");
  const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}% (${a}/${b})` : "n/a");

  const exact = (arm: Arm) => results.filter((x) => x[arm] === x.ref).length;
  const coreRecall = (arm: Arm) => coreRes.filter((x) => x[arm] === x.ref).length;
  // "Reached a core verdict at all" — separates "wrong ICP" from "gave up".
  const coreAny = (arm: Arm) => coreRes.filter((x) => (x[arm] ?? "").startsWith("ICP #")).length;
  const notKept = (arm: Arm) => notRes.filter((x) => x[arm] === "Not Core ICP").length;

  const L: string[] = [];
  L.push("# Does the feed's own Title column close the gap?");
  L.push("");
  L.push(`Paired run over ${results.length} identical rows from \`${csvPath.split("/").pop()}\`.`);
  L.push("");
  L.push("| | bare (email + linkedin) | titled (+ title + company) |");
  L.push("|---|---|---|");
  L.push(`| Agreement with reference | ${pct(exact("bare"), results.length)} | ${pct(exact("titled"), results.length)} |`);
  L.push(`| Core-label recall | ${pct(coreRecall("bare"), coreRes.length)} | ${pct(coreRecall("titled"), coreRes.length)} |`);
  L.push(`| Reached any core verdict | ${pct(coreAny("bare"), coreRes.length)} | ${pct(coreAny("titled"), coreRes.length)} |`);
  L.push(`| Not Core held (precision proxy) | ${pct(notKept("bare"), notRes.length)} | ${pct(notKept("titled"), notRes.length)} |`);
  L.push("");
  L.push(
    "Core recall is the accept path. 'Not Core held' is the control: a title lifts " +
      "both arms' willingness to commit, so a recall gain only counts if Not Core did not collapse."
  );
  L.push("");
  L.push("## Rows the title rescued");
  L.push("");
  L.push("| title | company | reference | bare | titled |");
  L.push("|---|---|---|---|---|");
  for (const x of coreRes.filter((y) => y.titled === y.ref && y.bare !== y.ref).slice(0, 25)) {
    L.push(
      `| ${x.row["Title"] ?? ""} | ${x.row["Company Name"] ?? ""} | ${x.ref} | ${x.bare ?? "err"} | ${x.titled} |`
    );
  }

  const out = join(ROOT, "test-runs/real-titles-report.md");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, L.join("\n") + "\n");
  process.stdout.write("\n" + L.join("\n") + `\n\nWrote ${out}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
