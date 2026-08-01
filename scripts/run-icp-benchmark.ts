/**
 * Scores /api/v1/personalize against a labelled ICP export.
 *
 * The companion to run-testset.ts, for a different question. That one replays 29
 * rows a human judged by hand. This one replays hundreds of rows a SECOND
 * classifier judged, which is the only way to exercise the accept path: the
 * 29-row list contained three core leads, this file contains ninety-three across
 * fifteen labels.
 *
 * Expected CSV columns: LinkedIn URL, First Name, Last Name, Business Email,
 * In ICP — where "In ICP" is "<label> — <reasoning>" or "Not Core ICP — …" or
 * "Unknown — insufficient data".
 *
 *   npx tsx scripts/run-icp-benchmark.ts --csv <path> --n 400
 *
 * IMPORTANT asymmetry, and the main thing to read the output through: the
 * reference labels were produced with the lead's JOB TITLE in hand (their
 * reasoning names it). This API is given only what a visitor list actually
 * SUPERSEDED, 2026-08-01: this script models the visitor feed as carrying no
 * title. The Orange Slice export has a real Title column at 78.8% and Company
 * Name at 86.4%. Passing them lifts core recall 9.4% -> 37.5% on identical rows
 * with Not Core precision unchanged (scripts/benchmark-real-titles.ts). Numbers
 * from here describe the bare path only; they are not the ceiling.
 *
 * carries — an email and a LinkedIn URL — and resolves a title only if Fundable's
 * people index happens to hold the profile. A row where we answer Not Core
 * because we could not see a title is a missing-input result, not a
 * misclassification, and the report counts those separately.
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

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Minimal RFC4180 reader: quoted fields, escaped quotes, embedded newlines. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
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

type Row = {
  linkedin: string;
  first: string;
  last: string;
  email: string;
  keyLabel: string;
  keyReason: string;
  bucket: "core" | "not_core" | "unknown" | "blank";
};

const FREEMAIL_HINT = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com", "outlook.com",
  "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "aim.com",
  "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "bellsouth.net", "cox.net",
  "charter.net", "optonline.net", "earthlink.net", "rocketmail.com", "proton.me",
  "protonmail.com", "snet.net", "centurytel.net",
]);

function emailKind(email: string): "corporate" | "freemail" | "none" {
  const e = email.trim().toLowerCase();
  if (!e.includes("@")) return "none";
  return FREEMAIL_HINT.has(e.split("@").pop() ?? "") ? "freemail" : "corporate";
}

function readRows(csvPath: string): Row[] {
  const grid = parseCsv(readFileSync(csvPath, "utf8").replace(/^﻿/, ""));
  const header = (grid[0] ?? []).map((h) => h.trim().toLowerCase().replace(/^﻿/, ""));
  const col = (name: string) => header.indexOf(name);
  const iLi = col("linkedin url");
  const iFirst = col("first name");
  const iLast = col("last name");
  const iEmail = col("business email");
  const iIcp = col("in icp");
  if (iIcp < 0) throw new Error(`CSV has no "In ICP" column. Found: ${header.join(", ")}`);

  return grid.slice(1).map((cells) => {
    const raw = (cells[iIcp] ?? "").trim();
    const dash = raw.indexOf("—");
    const label = (dash >= 0 ? raw.slice(0, dash) : raw).trim();
    const reason = dash >= 0 ? raw.slice(dash + 1).trim() : "";
    const bucket: Row["bucket"] = /^ICP #\d+:/.test(label)
      ? "core"
      : label.startsWith("Not Core")
        ? "not_core"
        : label.startsWith("Unknown")
          ? "unknown"
          : "blank";
    return {
      linkedin: (cells[iLi] ?? "").trim(),
      first: (cells[iFirst] ?? "").trim(),
      last: (cells[iLast] ?? "").trim(),
      email: (cells[iEmail] ?? "").trim(),
      keyLabel: bucket === "core" ? label : bucket === "not_core" ? "Not Core ICP" : label,
      keyReason: reason,
      bucket,
    };
  });
}

// ---------------------------------------------------------------------------
// Sampling — deterministic, so a re-run scores the same rows
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

/**
 * Every core row, then Not Core and Unknown to fill. Core rows are 6% of the
 * file; sampling at that rate would spend the whole budget re-confirming
 * rejection, which the previous test set already established.
 */
function stratify(rows: Row[], n: number, seed: number) {
  const rand = mulberry32(seed);
  const core = rows.filter((r) => r.bucket === "core");
  const notCore = shuffled(rows.filter((r) => r.bucket === "not_core"), rand);
  const unknown = shuffled(rows.filter((r) => r.bucket === "unknown"), rand);
  const remaining = Math.max(0, n - core.length);
  const takeUnknown = Math.min(unknown.length, Math.round(remaining * 0.17));
  const takeNotCore = Math.min(notCore.length, remaining - takeUnknown);
  return [...core, ...notCore.slice(0, takeNotCore), ...unknown.slice(0, takeUnknown)];
}

// ---------------------------------------------------------------------------
// Calling
// ---------------------------------------------------------------------------

type Outcome = {
  row: Row;
  status: number;
  ms: number;
  ourLabel: string | null;
  errorCode: string | null;
  headers: Record<string, string>;
  verdict:
    | "exact"
    | "both_core_different_label"
    | "missed_core" // key says core, we say Not Core
    | "over_called" // key says Not Core, we say core
    | "key_unknown"
    | "no_email"
    | "error";
};

async function callOne(base: string, key: string, row: Row): Promise<Outcome> {
  const known: Record<string, string> = {};
  if (row.first) known.first_name = row.first;

  const body = {
    email: row.email,
    linkedin_url: row.linkedin || undefined,
    message_type: "website_visitor",
    template_id: "website_visitor_use_case",
    known_fields: known,
    additional_context: { sender_name: "Jacob" },
  };

  const started = Date.now();
  let status = 0;
  let json: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${base}/api/v1/personalize`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      status = res.status;
      for (const [k, v] of res.headers) if (k.toLowerCase().startsWith("x-")) headers[k] = v;
      json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      break;
    } catch (e) {
      status = 0;
      json = { error: { code: "TRANSPORT", message: (e as Error).message } };
    }
  }

  const err = (json.error ?? null) as { code?: string } | null;
  const ourLabel = typeof json.icp === "string" ? json.icp : null;
  const weCore = !!ourLabel && ourLabel !== "Not Core ICP";
  const keyCore = row.bucket === "core";

  let verdict: Outcome["verdict"];
  if (status === 400 && !row.email) verdict = "no_email";
  else if (status !== 200) verdict = "error";
  else if (row.bucket === "unknown" || row.bucket === "blank") verdict = "key_unknown";
  else if (keyCore && weCore) verdict = ourLabel === row.keyLabel ? "exact" : "both_core_different_label";
  else if (keyCore && !weCore) verdict = "missed_core";
  else if (!keyCore && weCore) verdict = "over_called";
  else verdict = "exact";

  return {
    row,
    status,
    ms: Date.now() - started,
    ourLabel,
    errorCode: err?.code ?? null,
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
// Report
// ---------------------------------------------------------------------------

function report(results: Outcome[], meta: { base: string; csv: string; startedAt: string; seed: number }): string {
  const n = (v: Outcome["verdict"]) => results.filter((r) => r.verdict === v).length;
  const scored = results.filter((r) => !["no_email", "error", "key_unknown"].includes(r.verdict));
  const agree = n("exact");
  const L: string[] = [];

  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "n/a");

  L.push("# ICP benchmark against the labelled visitor export");
  L.push("");
  L.push(`Run ${meta.startedAt} · \`${meta.base}\` · seed ${meta.seed} · ${results.length} rows.`);
  L.push("");
  L.push("> The reference labels were produced with the lead's job title available.");
  L.push("> This API received only an email and a LinkedIn URL, and resolves a title");
  L.push("> only when Fundable's people index holds the profile. Rows below marked");
  L.push("> **missing input** are that gap, not a disagreement about taxonomy.");
  L.push("");
  L.push("## Headline");
  L.push("");
  L.push("| | |");
  L.push("|---|---|");
  L.push(`| Rows attempted | ${results.length} |`);
  L.push(`| Comparable (key had a definite label, we answered) | ${scored.length} |`);
  L.push(`| **Exact label agreement** | **${agree}/${scored.length} (${pct(agree, scored.length)})** |`);
  L.push(`| Both core, different label | ${n("both_core_different_label")} |`);
  L.push(`| Key core → we said Not Core | ${n("missed_core")} |`);
  L.push(`| Key Not Core → we said core (false positive) | ${n("over_called")} |`);
  L.push(`| Key said Unknown (not scored) | ${n("key_unknown")} |`);
  L.push(`| No email on the row → 400 | ${n("no_email")} |`);
  L.push(`| Errors | ${n("error")} |`);
  const ms = results.map((r) => r.ms).sort((a, b) => a - b);
  L.push(`| Latency p50 / p95 | ${ms[Math.floor(ms.length / 2)] ?? 0}ms / ${ms[Math.floor(ms.length * 0.95)] ?? 0}ms |`);
  L.push("");

  // Agreement split by what evidence we actually had.
  L.push("## Agreement by the evidence we had");
  L.push("");
  L.push("| Email on the row | rows | exact | missed core | false positive |");
  L.push("|---|---|---|---|---|");
  for (const kind of ["corporate", "freemail", "none"] as const) {
    const g = scored.filter((r) => emailKind(r.row.email) === kind);
    if (!g.length) continue;
    L.push(
      `| ${kind} | ${g.length} | ${g.filter((r) => r.verdict === "exact").length} (${pct(g.filter((r) => r.verdict === "exact").length, g.length)}) | ${g.filter((r) => r.verdict === "missed_core").length} | ${g.filter((r) => r.verdict === "over_called").length} |`
    );
  }
  L.push("");

  // Per-label recall on the accept path — the thing the 29-row set could not measure.
  const keyLabels = [...new Set(results.filter((r) => r.row.bucket === "core").map((r) => r.row.keyLabel))].sort();
  if (keyLabels.length) {
    L.push("## Recall per ICP label");
    L.push("");
    L.push("| Reference label | rows | exact | different core label | said Not Core |");
    L.push("|---|---|---|---|---|");
    for (const lab of keyLabels) {
      const g = results.filter((r) => r.row.keyLabel === lab && r.verdict !== "no_email" && r.verdict !== "error");
      if (!g.length) continue;
      L.push(
        `| ${lab} | ${g.length} | ${g.filter((r) => r.verdict === "exact").length} | ${g.filter((r) => r.verdict === "both_core_different_label").length} | ${g.filter((r) => r.verdict === "missed_core").length} |`
      );
    }
    L.push("");
  }

  const fps = results.filter((r) => r.verdict === "over_called");
  if (fps.length) {
    L.push("## False positives — we called core, the reference did not");
    L.push("");
    L.push("The expensive error: a personalized claim about someone who does not fit.");
    L.push("");
    for (const r of fps) {
      L.push(`**${r.row.first} ${r.row.last}** · ${r.row.email} → we said \`${r.ourLabel}\``);
      L.push("");
      L.push(`> ${r.row.keyReason.slice(0, 400)}`);
      L.push("");
    }
  }

  const diff = results.filter((r) => r.verdict === "both_core_different_label");
  if (diff.length) {
    L.push("## Both core, different label");
    L.push("");
    for (const r of diff) {
      L.push(`**${r.row.first} ${r.row.last}** · ${r.row.email}`);
      L.push(`- reference: \`${r.row.keyLabel}\``);
      L.push(`- ours: \`${r.ourLabel}\``);
      L.push(`> ${r.row.keyReason.slice(0, 320)}`);
      L.push("");
    }
  }

  const missed = results.filter((r) => r.verdict === "missed_core");
  if (missed.length) {
    L.push("## Reference says core, we said Not Core");
    L.push("");
    L.push("| Person | email | kind | reference label |");
    L.push("|---|---|---|---|");
    for (const r of missed) {
      L.push(`| ${r.row.first} ${r.row.last} | ${r.row.email || "—"} | ${emailKind(r.row.email)} | ${r.row.keyLabel} |`);
    }
    L.push("");
  }

  return L.join("\n") + "\n";
}

// ---------------------------------------------------------------------------

async function main() {
  const env = loadEnv();
  const base = (arg("base", "https://personalize-api-umber.vercel.app") ?? "").replace(/\/$/, "");
  const key = env.PERSONALIZE_API_KEY;
  if (!key) throw new Error("PERSONALIZE_API_KEY missing.");
  const csv = arg("csv");
  if (!csv) throw new Error("--csv <path> is required.");
  const n = Number(arg("n", "400"));
  const seed = Number(arg("seed", "42"));
  const concurrency = Number(arg("concurrency", "6"));
  const outDir = resolve(arg("out", join(ROOT, "test-runs/icp-benchmark")) ?? "");
  mkdirSync(outDir, { recursive: true });

  const all = readRows(resolve(csv));
  const sample = stratify(all, n, seed);
  const startedAt = new Date().toISOString();

  const counts = sample.reduce<Record<string, number>>((a, r) => ({ ...a, [r.bucket]: (a[r.bucket] ?? 0) + 1 }), {});
  process.stdout.write(
    `${all.length} rows in file; sampling ${sample.length} (${JSON.stringify(counts)}) -> ${base}\n`
  );

  let done = 0;
  const results = await mapLimit(sample, concurrency, async (row) => {
    const r = await callOne(base, key, row);
    done++;
    if (done % 25 === 0 || r.verdict === "over_called") {
      process.stdout.write(`  ${done}/${sample.length} ${r.verdict === "over_called" ? `FP: ${r.row.email} -> ${r.ourLabel}` : ""}\n`);
    }
    return r;
  });

  writeFileSync(join(outDir, "results.json"), JSON.stringify({ meta: { base, csv, startedAt, seed }, results }, null, 2));
  const md = report(results, { base, csv, startedAt, seed });
  writeFileSync(join(outDir, "report.md"), md);
  process.stdout.write(`\n${md.split("## Agreement by")[0]}\nWrote ${outDir}/report.md\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
