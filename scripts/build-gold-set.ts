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
  return i >= 0 ? process.argv[i + 1] : d;
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
    const titleMatch = reason.match(/\bis (?:a|an|the) ([^,.;]{3,60}?) at |\bholds (?:a|an|the) ([^.;]{3,70}?) (?:role|title)/);
    out.push({
      id: `mined-${(cells[iLi] ?? email).split("/").pop()}`,
      proposed_label: label,
      email,
      ...(titleMatch ? { title: (titleMatch[1] ?? titleMatch[2] ?? "").trim() } : {}),
      ...(cells[iLi] ? { linkedin: cells[iLi].trim() } : {}),
      source: "orange-slice-export",
      decision: "",
      note: `${(cells[iFirst] ?? "").trim()} ${(cells[iLast] ?? "").trim()} — reference said: ${reason.slice(0, 160)}`,
    } as Candidate);
  }
  return out;
}

function main() {
  const outDir = join(ROOT, "config/eval");
  mkdirSync(outDir, { recursive: true });

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
    ...AUTHORED.map((a) => ({ ...a, decision: "", note: "authored boundary/slice — verify the rule still reads correctly" })),
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
