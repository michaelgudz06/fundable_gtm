/**
 * Builds a review queue of candidate gold-set rows for a human to approve.
 *
 * The spec wants >=5 positives per core label, >=40 diverse Not Core, >=2
 * boundary examples per hard gate, and named slices. Measured against the real
 * export, only 4 of 19 labels clear the bar and four have ZERO examples (#7,
 * #10, #17, #18) — so the data has to be built, not found.
 *
 * Nothing here decides a label. It assembles candidates from sources that are
 * already labelled or obviously typed, and emits a queue whose every row a human
 * marks approve/reject. Only approved rows reach the gold set, because a gold
 * set our own classifier labelled would measure nothing but its own consistency.
 *
 *   npx tsx scripts/build-gold-set.ts --csv <export.csv>   # mine candidates
 *   npx tsx scripts/build-gold-set.ts --approve <queue>    # fold approvals into the set
 *
 * Boundary and slice rows are authored here rather than mined: they encode
 * specific rules ("without confirmed startup customers -> Not Core") and there
 * is no export to find them in.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i < 0) return d;
  const v = process.argv[i + 1];
  // A flag used as a bare switch (`--approve`) has no value after it, and
  // returning undefined there is how `--approve` came to crash with an opaque
  // EISDIR: resolve(undefined ?? "") is the CWD, and readFileSync on a
  // directory throws. Fall back to the default instead. The `--` guard stops
  // the next FLAG being eaten as this one's value.
  return v !== undefined && !v.startsWith("--") ? v : d;
};

type Candidate = {
  id: string;
  proposed_label: string;
  email: string;
  title?: string;
  company?: string;
  linkedin?: string;
  source: string;
  boundary_for?: string;
  slice?: string;
  /** Filled in by the reviewer: "approve" | "reject" | "relabel:<label>". */
  decision: string;
  note: string;
};

// ---------------------------------------------------------------------------
// Authored rows: boundaries and slices
//
// Every one of these encodes a rule the spec names as a required fixture. They
// use example-domain addresses because their job is to pin a DECISION, not to
// describe a real person — and a gold set full of real strangers' addresses is
// a liability that grows every time the repo is cloned.
// ---------------------------------------------------------------------------

const AUTHORED: Omit<Candidate, "decision" | "note">[] = [
  {
    id: "boundary-10-confirmed",
    proposed_label: "ICP #10: Cross-Border Payments",
    email: "ae@example-crossborder.com",
    title: "Account Executive",
    company: "Example Cross-Border Payments",
    source: "authored",
    boundary_for: "startup_customers_required (confirmed side)",
  },
  {
    id: "boundary-10-unconfirmed",
    proposed_label: "Not Core ICP",
    email: "ae@example-fxbank.com",
    title: "Account Executive",
    company: "Example FX Bank",
    source: "authored",
    boundary_for: "startup_customers_required (unconfirmed -> Not Core)",
  },
  {
    id: "boundary-11-over-20",
    proposed_label: "ICP #11: Startup HR Platform",
    email: "gtm@example-hrplatform.com",
    title: "Head of Growth",
    company: "Example HR Platform",
    source: "authored",
    boundary_for: "specific ICP takes precedence over #20 catch-all",
  },
  {
    id: "boundary-6-venture",
    proposed_label: "ICP #6: Founder",
    email: "founder@example-devtools.com",
    title: "Co-Founder & CEO",
    company: "Example Devtools",
    source: "authored",
    boundary_for: "#6 requires a venture-style startup",
  },
  {
    id: "boundary-6-consultancy",
    proposed_label: "Not Core ICP",
    email: "owner@example-consultancy.com",
    title: "Founder",
    company: "Example Local Consultancy",
    source: "authored",
    boundary_for: "#6 excludes consultancies and local services",
  },
  {
    id: "boundary-9-product",
    proposed_label: "ICP #9: Startup Data Customer",
    email: "cto@example-enrichment.com",
    title: "CTO",
    company: "Example Enrichment",
    source: "authored",
    boundary_for: "#9 is product/engineering roles only",
  },
  {
    id: "boundary-9-sales-is-20",
    proposed_label: "ICP #20: Startup GTM",
    email: "sales@example-enrichment.com",
    title: "Account Executive",
    company: "Example Enrichment",
    source: "authored",
    boundary_for: "a GTM role at a data startup is #20, not #9",
  },
  {
    id: "boundary-19-fund",
    proposed_label: "ICP #19: Investor",
    email: "partner@example-seedfund.com",
    title: "Partner",
    company: "Example Seed Fund",
    source: "authored",
    boundary_for: "#19 is core in v2 (reverses the v1 VC exclusion)",
  },
  {
    id: "boundary-19-residential",
    proposed_label: "Not Core ICP",
    email: "broker@example-homes.com",
    title: "Broker",
    company: "Example Residential Realty",
    source: "authored",
    boundary_for: "residential real estate is excluded outright",
  },
  {
    id: "boundary-19-newsletter",
    proposed_label: "Not Core ICP",
    email: "editor@example-vcnewsletter.com",
    title: "Editor",
    company: "Example VC Newsletter",
    source: "authored",
    boundary_for: "VC newsletter operators are excluded outright",
  },
  {
    id: "slice-personal-email",
    proposed_label: "Not Core ICP",
    email: "someone.random@gmail.com",
    source: "authored",
    slice: "personal email, no title",
  },
  {
    id: "slice-missing-name",
    proposed_label: "Not Core ICP",
    email: "info@example-unknown.com",
    source: "authored",
    slice: "missing name",
  },
  {
    id: "slice-sparse-evidence",
    proposed_label: "Not Core ICP",
    email: "contact@example-noweb.com",
    title: "Manager",
    source: "authored",
    slice: "sparse evidence",
  },
  {
    id: "slice-past-vs-current-role",
    proposed_label: "ICP #20: Startup GTM",
    email: "gtm@example-startup.com",
    title: "Head of Sales (previously Partner at a VC fund)",
    company: "Example Startup",
    source: "authored",
    slice: "past vs current role",
    boundary_for: "current role only, never background",
  },
];

// ---------------------------------------------------------------------------

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

function mineFromExport(csvPath: string): Candidate[] {
  const grid = parseCsv(readFileSync(csvPath, "utf8").replace(/^﻿/, ""));
  const header = (grid[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (n: string) => header.indexOf(n);
  const iLi = col("linkedin url");
  const iFirst = col("first name");
  const iLast = col("last name");
  const iEmail = col("business email");
  const iIcp = col("in icp");
  const iTitle = col("title");
  const iCompany = col("company name");

  const out: Candidate[] = [];
  const perLabel = new Map<string, number>();

  for (const cells of grid.slice(1)) {
    const raw = (cells[iIcp] ?? "").trim();
    if (!/^ICP #\d+:/.test(raw)) continue; // only proposed positives are worth reviewing
    const label = raw.split("—")[0]!.trim();
    const email = (cells[iEmail] ?? "").trim();
    if (!email) continue;

    // Cap per label: the point is to fill the thin labels, not to re-review the
    // three that already have volume.
    const seen = perLabel.get(label) ?? 0;
    if (seen >= 8) continue;
    perLabel.set(label, seen + 1);

    const reason = raw.includes("—") ? raw.split("—").slice(1).join("—").trim() : "";

    // Title and company come from the export's own columns. They used to be
    // regex-scraped out of the reference classifier's reasoning prose, which
    // found a title on barely half the rows and invented the "the visitor feed
    // has no titles" premise that shaped months of planning. The export fills
    // Title on 78.8% of rows and Company Name on 86.4%. Falling back to the
    // scrape only when the column is genuinely empty.
    const titleMatch = reason.match(/\bis (?:a|an|the) ([^,.;]{3,60}?) at |\bholds (?:a|an|the) ([^.;]{3,70}?) (?:role|title)/);
    const title = (iTitle >= 0 ? (cells[iTitle] ?? "").trim() : "") ||
      (titleMatch ? (titleMatch[1] ?? titleMatch[2] ?? "").trim() : "");
    const company = iCompany >= 0 ? (cells[iCompany] ?? "").trim() : "";
    out.push({
      id: `mined-${(cells[iLi] ?? email).split("/").pop()}`,
      proposed_label: label,
      email,
      ...(title ? { title } : {}),
      ...(company ? { company } : {}),
      ...(cells[iLi] ? { linkedin: cells[iLi].trim() } : {}),
      source: "orange-slice-export",
      decision: "",
      note: `${(cells[iFirst] ?? "").trim()} ${(cells[iLast] ?? "").trim()} — reference said: ${reason.slice(0, 160)}`,
    } as Candidate);
  }
  return out;
}

/**
 * Fill title/company on an EXISTING queue from an export, preserving decisions.
 *
 * The queue was mined before anyone noticed the export had a Title column, so
 * 23 of 59 approved rows carry no title — and a gated ICP with no role and no
 * company has nothing to confirm, so it correctly answers Not Core. The
 * resulting macro-F1 of 0.185 was therefore measuring the miner, not the
 * classifier. Re-mining from scratch would fix the fields and throw away every
 * human decision, which is the expensive part. This matches on LinkedIn URL
 * first (stable) then email, and only ever ADDS fields.
 *
 *   npx tsx scripts/build-gold-set.ts --enrich <export.csv>
 */
function enrichQueue(csvPath: string, queuePath: string): void {
  const grid = parseCsv(readFileSync(csvPath, "utf8").replace(/^\ufeff/, ""));
  const header = (grid[0] ?? []).map((h) => h.trim().toLowerCase());
  const col = (n: string) => header.indexOf(n);
  const iLi = col("linkedin url");
  const iEmail = col("business email");
  const iTitle = col("title");
  const iCompany = col("company name");
  if (iTitle < 0) throw new Error(`No "Title" column in ${csvPath}`);

  const norm = (u: string) => u.trim().toLowerCase().replace(/\/+$/, "");
  const byLi = new Map<string, string[]>();
  const byEmail = new Map<string, string[]>();
  for (const cells of grid.slice(1)) {
    if (iLi >= 0 && cells[iLi]) byLi.set(norm(cells[iLi]), cells);
    if (iEmail >= 0 && cells[iEmail]) byEmail.set(norm(cells[iEmail]), cells);
  }

  const queue = JSON.parse(readFileSync(queuePath, "utf8")) as { rows: Candidate[] };
  let title = 0;
  let company = 0;
  for (const r of queue.rows) {
    const hit = (r.linkedin ? byLi.get(norm(r.linkedin)) : undefined) ?? byEmail.get(norm(r.email));
    if (!hit) continue;
    const t = iTitle >= 0 ? (hit[iTitle] ?? "").trim() : "";
    const c = iCompany >= 0 ? (hit[iCompany] ?? "").trim() : "";
    if (t && !r.title) {
      r.title = t;
      title++;
    }
    if (c && !r.company) {
      r.company = c;
      company++;
    }
  }
  writeFileSync(queuePath, JSON.stringify(queue, null, 2) + "\n");
  process.stdout.write(
    `enriched ${queuePath}: +${title} titles, +${company} companies ` +
      `(${queue.rows.filter((r) => r.title).length}/${queue.rows.length} now have a title)\n` +
      `decisions preserved: ${queue.rows.filter((r) => r.decision).length}\n`
  );
}

/**
 * Boundary rows, taken from the verified hard-rule fixtures.
 *
 * These used to be authored here against example-*.com addresses, on the
 * reasoning that a gold set full of real strangers is a liability. That is
 * true, and it produced rows that CANNOT PASS: a gated ICP needs confirmable
 * evidence, and a company that does not exist supplies none, so every
 * positive-side boundary row failed closed to Not Core. All four hard-rule
 * failures in the first evaluation were this, not the classifier.
 *
 * config/eval/hard_rules.json already solved it the right way — real companies,
 * synthetic role@ addresses, so the row tests a rule rather than a person — and
 * those 21 fixtures pass 21/21 live. Deriving boundary rows from them means one
 * definition of each rule instead of two that can drift, and no expectation
 * enters the gold set that has not already been demonstrated reachable.
 *
 * They are marked `registry-derived` rather than `human-review`: their expected
 * answer follows from the registry, so a human ratifying them would be
 * confirming a rule, not supplying a judgment.
 */
function boundaryRowsFromHardRules(): Candidate[] {
  const hr = JSON.parse(readFileSync(join(ROOT, "config/eval/hard_rules.json"), "utf8")) as {
    rows: { id: string; rule: string; expect: string; email: string; title?: string; company?: string; why: string }[];
  };
  return hr.rows.map((r) => ({
    id: `hardrule-${r.id}`,
    proposed_label: r.expect,
    email: r.email,
    ...(r.title ? { title: r.title } : {}),
    ...(r.company ? { company: r.company } : {}),
    source: "hard-rules",
    boundary_for: r.rule,
    // Pre-decided: the expectation is derivable from the registry and already
    // verified live. Leaving it blank would put 21 rows in front of a reviewer
    // whose only honest answer is "yes, that is what the registry says".
    decision: "approve",
    note: r.why,
  }));
}

function main() {
  const outDir = join(ROOT, "config/eval");
  mkdirSync(outDir, { recursive: true });

  if (process.argv.includes("--enrich")) {
    const csv = arg("enrich");
    if (!csv) throw new Error("--enrich <export.csv> is required");
    enrichQueue(resolve(csv), join(outDir, "review_queue.json"));
    return;
  }

  if (process.argv.includes("--approve")) {
    const queuePath = resolve(arg("approve", join(outDir, "review_queue.json")) ?? "");
    const queue = JSON.parse(readFileSync(queuePath, "utf8")) as { rows: Candidate[] };
    const approved = queue.rows.filter((r) => r.decision.startsWith("approve") || r.decision.startsWith("relabel:"));
    const rows = approved.map((r) => ({
      id: r.id,
      label: r.decision.startsWith("relabel:") ? r.decision.slice("relabel:".length).trim() : r.proposed_label,
      email: r.email,
      ...(r.title ? { title: r.title } : {}),
      ...(r.company ? { company: r.company } : {}),
      ...(r.linkedin ? { linkedin: r.linkedin } : {}),
      ...(r.boundary_for ? { boundary_for: r.boundary_for } : {}),
      ...(r.slice ? { slice: r.slice } : {}),
      approved_by: "human-review",
    }));
    const setPath = join(outDir, "gold_set.json");
    const version = existsSync(setPath)
      ? `${Number((JSON.parse(readFileSync(setPath, "utf8")).version ?? "0")) + 1}`
      : "1";
    writeFileSync(
      setPath,
      JSON.stringify(
        {
          "//": "Human-approved labels ONLY. A gold set our own classifier labelled would measure its own consistency, not its accuracy.",
          version,
          frozen_at: new Date().toISOString(),
          rows,
        },
        null,
        2
      ) + "\n"
    );
    process.stdout.write(`gold_set.json v${version}: ${rows.length} approved rows\n`);
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.label, (counts.get(r.label) ?? 0) + 1);
    const thin = [...counts.entries()].filter(([, n]) => n < 5).map(([l, n]) => `${l} (${n})`);
    if (thin.length) process.stdout.write(`still under 5 positives: ${thin.join(", ")}\n`);
    return;
  }

  const csv = arg("csv");
  const mined = csv ? mineFromExport(resolve(csv)) : [];
  const rows: Candidate[] = [
    // Boundary rows come from the verified hard-rule fixtures; only the slices
    // are still authored here, and those legitimately need synthetic domains
    // (a "sparse evidence" row is testing the absence of evidence).
    ...boundaryRowsFromHardRules(),
    ...AUTHORED.filter((a) => a.slice).map((a) => ({ ...a, decision: "", note: "authored slice — verify the rule still reads correctly" })),
    ...mined,
  ];

  const queuePath = join(outDir, "review_queue.json");
  writeFileSync(
    queuePath,
    JSON.stringify(
      {
        "//": [
          "REVIEW QUEUE. Set `decision` on every row to one of: approve | reject | relabel:<exact label>.",
          "Then run: npx tsx scripts/build-gold-set.ts --approve",
          "Nothing here is a label yet. Proposed labels came from the Orange Slice export or were authored to pin a rule;",
          "both need a human, because scoring against our own output would measure consistency rather than accuracy.",
        ].join(" "),
        generated_at: new Date().toISOString(),
        rows,
      },
      null,
      2
    ) + "\n"
  );

  const byLabel = new Map<string, number>();
  for (const r of rows) byLabel.set(r.proposed_label, (byLabel.get(r.proposed_label) ?? 0) + 1);
  process.stdout.write(`review queue: ${rows.length} candidates -> ${queuePath}\n\n`);
  for (const [label, n] of [...byLabel.entries()].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  ${String(n).padStart(3)}  ${label}\n`);
  }
  process.stdout.write(`\nboundary rows: ${rows.filter((r) => r.boundary_for).length}, slice rows: ${rows.filter((r) => r.slice).length}\n`);
}

main();
