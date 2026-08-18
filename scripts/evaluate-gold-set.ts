/**
 * Scores the classifier against a HUMAN-labelled gold set.
 *
 * This is a different question from every other harness here. `run-icp-benchmark`
 * scores against the reference classifier's own output, which measures AGREEMENT
 * WITH ORANGE SLICE — useful, but it makes the reference true by definition and
 * counts every place we are right and it was wrong as our error. A gold set
 * labelled by a person makes both classifiers measurable against the same truth.
 *
 * Reports what the spec's §6 asks for and nothing had computed before:
 *   - macro-F1 across the 19 core labels plus Not Core
 *   - per-label precision, recall, support
 *   - Not Core precision — the number that says how often "we won't personalize"
 *     was the right call
 *   - hard-rule accuracy on the boundary cases
 *
 *   npx tsx scripts/evaluate-gold-set.ts                       # score + compare to baseline
 *   npx tsx scripts/evaluate-gold-set.ts --freeze              # record this run AS the baseline
 *   npx tsx scripts/evaluate-gold-set.ts --set config/eval/gold_set.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { ROOT, apiBase, apiKey, arg, flag, mapLimit } from "./lib.js";

const BASE = apiBase();
const KEY = apiKey();

/** One human-approved example. `label` is truth, not a prediction. */
type GoldRow = {
  id: string;
  label: string; // "ICP #2: CRE Broker" | "Not Core ICP"
  email: string;
  title?: string;
  company?: string;
  linkedin?: string;
  /** Marks a row that exists to pin a specific hard rule. */
  boundary_for?: string;
  /** Which required slice this row covers, if any. */
  slice?: string;
  approved_by: string;
};

type GoldSet = { version: string; frozen_at: string; rows: GoldRow[] };

/**
 * Classify one row, retrying the failures that are about load rather than the row.
 *
 * The first version returned null on any non-200 and retried only on a thrown
 * exception. That silently converted server-side flakiness into missing rows,
 * and the summary still printed a headline macro-F1 over whatever survived —
 * a measured 21 of 59 rows vanished this way, and the number computed on the
 * remaining 38 was reported as if it described the whole set.
 *
 * A 5xx here is nearly always the Fundable /people leg under concurrency (19s
 * cold), so it is worth retrying with backoff. A 4xx is a real answer about the
 * request and is not retried — except 429, which is the harness's own fault for
 * asking too fast.
 */
async function classify(row: GoldRow): Promise<string | null> {
  const ATTEMPTS = 4;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    try {
      const res = await fetch(`${BASE}/api/classify`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          email: row.email,
          ...(row.title ? { title: row.title } : {}),
          ...(row.company ? { company: row.company } : {}),
          ...(row.linkedin ? { linkedin: row.linkedin } : {}),
        }),
      });
      if (res.status === 200) {
        const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return typeof j.icp === "string" ? j.icp : null;
      }
      const retryable = res.status >= 500 || res.status === 429;
      if (!retryable) return null;
    } catch {
      /* network-level: retry */
    }
  }
  return null;
}

type PerLabel = { support: number; tp: number; fp: number; fn: number };

function score(rows: { truth: string; predicted: string | null }[]) {
  const labels = new Set<string>();
  for (const r of rows) {
    labels.add(r.truth);
    if (r.predicted) labels.add(r.predicted);
  }

  const per = new Map<string, PerLabel>();
  for (const l of labels) per.set(l, { support: 0, tp: 0, fp: 0, fn: 0 });
  for (const r of rows) {
    const t = per.get(r.truth)!;
    t.support++;
    if (r.predicted === r.truth) t.tp++;
    else {
      t.fn++;
      if (r.predicted) per.get(r.predicted)!.fp++;
    }
  }

  const f1 = (m: PerLabel) => {
    const p = m.tp + m.fp === 0 ? 0 : m.tp / (m.tp + m.fp);
    const rc = m.tp + m.fn === 0 ? 0 : m.tp / (m.tp + m.fn);
    return { precision: p, recall: rc, f1: p + rc === 0 ? 0 : (2 * p * rc) / (p + rc) };
  };

  // Macro-F1 averages over labels that actually appear in the truth set — a
  // label with no examples would otherwise contribute a zero and quietly
  // punish the classifier for a gap in the DATA.
  const supported = [...per.entries()].filter(([, m]) => m.support > 0);
  const macroF1 = supported.reduce((n, [, m]) => n + f1(m).f1, 0) / Math.max(1, supported.length);

  const notCore = per.get("Not Core ICP") ?? { support: 0, tp: 0, fp: 0, fn: 0 };
  const notCorePrecision = notCore.tp + notCore.fp === 0 ? 0 : notCore.tp / (notCore.tp + notCore.fp);

  return { per, f1, macroF1, notCorePrecision, supported };
}

async function main() {
  const setPath = resolve(arg("set", join(ROOT, "config/eval/gold_set.json")) ?? "");
  if (!existsSync(setPath)) {
    throw new Error(
      `No gold set at ${setPath}. Build one with:\n  npx tsx scripts/build-gold-set.ts --csv <export.csv>, review the queue, then --approve`
    );
  }
  const gold = JSON.parse(readFileSync(setPath, "utf8")) as GoldSet;
  process.stdout.write(`gold set ${gold.version} — ${gold.rows.length} rows -> ${BASE}\n\n`);

  let done = 0;
  const results = await mapLimit(gold.rows, 2, async (row) => {
    const predicted = await classify(row);
    done++;
    if (done % 20 === 0) process.stdout.write(`  ${done}/${gold.rows.length}\n`);
    return { row, truth: row.label, predicted };
  });

  const unreachable = results.filter((r) => r.predicted === null);
  const scored = results.filter((r) => r.predicted !== null);
  const { per, f1, macroF1, notCorePrecision, supported } = score(scored);
  const exact = scored.filter((r) => r.predicted === r.truth).length;

  const boundary = scored.filter((r) => r.row.boundary_for);
  const boundaryPassed = boundary.filter((r) => r.predicted === r.truth).length;

  const L: string[] = [];
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  L.push(`# Gold-set evaluation — ${gold.version}`);
  L.push("");
  L.push(`Scored ${scored.length}/${gold.rows.length} rows against \`${BASE}\`.`);
  L.push("");

  // Coverage gate. A metric computed over the rows that happened to succeed is
  // not a metric over the gold set: the rows that fail are the slow ones —
  // no title, LinkedIn resolution through Fundable's /people leg — which is
  // exactly the population whose accuracy is in question. Reporting a headline
  // macro-F1 across a biased subset is worse than reporting nothing, because it
  // looks like an answer. A measured run once lost 21 of 59 rows this way.
  const coverage = scored.length / Math.max(1, gold.rows.length);
  const COVERAGE_FLOOR = 0.95;
  const short = coverage < COVERAGE_FLOOR;
  if (short) {
    L.push(`> **These numbers are not usable.** ${unreachable.length} of ${gold.rows.length} rows`);
    L.push(`> (${pct(1 - coverage)}) did not return a label, and the rows that fail are the slow`);
    L.push("> ones — no title, LinkedIn resolved through Fundable — so what is left is a biased");
    L.push("> subset, not a sample. Re-run; if it persists, the API is failing, not the classifier.");
    L.push("");
    L.push(`> Unreachable: ${unreachable.map((r) => r.row.id).join(", ")}`);
    L.push("");
  }

  L.push("| metric | value |");
  L.push("|---|---|");
  L.push(`| **macro-F1** | **${macroF1.toFixed(3)}** |`);
  L.push(`| Exact accuracy | ${pct(exact / Math.max(1, scored.length))} (${exact}/${scored.length}) |`);
  L.push(`| **Not Core precision** | **${pct(notCorePrecision)}** |`);
  L.push(`| Hard-rule (boundary) accuracy | ${boundary.length ? `${pct(boundaryPassed / boundary.length)} (${boundaryPassed}/${boundary.length})` : "no boundary rows"} |`);
  L.push(`| Labels with support | ${supported.length} |`);
  L.push(`| Unreachable (error/timeout) | ${unreachable.length} |`);
  L.push("");

  // Input regime. Every accuracy number this project has produced is really a
  // number about how much the caller knew, not how well the classifier reasons:
  // a gated ICP needs confirmed evidence, and with no title and no company there
  // is nothing to confirm, so the honest answer is Not Core. Splitting on title
  // presence turns "macro-F1 0.185" from a verdict into a diagnosis, and it is
  // the single number that says whether to fix the model or the vendor feed.
  const withTitle = scored.filter((r) => r.row.title);
  const withoutTitle = scored.filter((r) => !r.row.title);
  const acc = (rs: typeof scored) =>
    rs.length ? `${pct(rs.filter((r) => r.predicted === r.truth).length / rs.length)} (${rs.filter((r) => r.predicted === r.truth).length}/${rs.length})` : "no rows";
  L.push("## By input regime");
  L.push("");
  L.push("| caller supplied | exact accuracy |");
  L.push("|---|---|");
  L.push(`| email + title | ${acc(withTitle)} |`);
  L.push(`| email only | ${acc(withoutTitle)} |`);
  L.push("");
  L.push(
    "A gated ICP requires confirmed evidence. With no title and no company there is " +
      "nothing to confirm, so Not Core is the correct output, not a miss — which is why " +
      "the gap between these two rows is a vendor question, not a model question."
  );
  L.push("");

  // Provenance split. 21 of these rows are hard-rule fixtures whose expected
  // answer follows from the registry, and they ALSO score the separate "100%
  // hard-rule fixtures" clause. Blending them into one headline lets a single
  // dataset satisfy two independent acceptance criteria, and inflates the
  // number with rows the classifier is already tuned to pass. Report both.
  const human = scored.filter((r) => r.row.approved_by !== "registry-derived");
  const derived = scored.filter((r) => r.row.approved_by === "registry-derived");
  const accOf = (rs: typeof scored) =>
    rs.length
      ? `${pct(rs.filter((r) => r.predicted === r.truth).length / rs.length)} (${rs.filter((r) => r.predicted === r.truth).length}/${rs.length})`
      : "no rows";
  L.push("## By provenance");
  L.push("");
  L.push("| rows | label chosen by | exact accuracy |");
  L.push("|---|---|---|");
  L.push(`| ${human.length} | a human | ${accOf(human)} |`);
  L.push(`| ${derived.length} | the registry (hard-rule fixtures) | ${accOf(derived)} |`);
  L.push("");
  L.push(
    "Quote the human row when asked how accurate the classifier is. The derived row " +
      "restates the hard-rule suite and is not independent evidence."
  );
  L.push("");

  L.push("## Per label");
  L.push("");
  L.push("| label | support | precision | recall | F1 |");
  L.push("|---|---|---|---|---|");
  for (const [label, m] of [...per.entries()].sort((a, b) => b[1].support - a[1].support)) {
    if (!m.support && !m.fp) continue;
    const s = f1(m);
    L.push(`| ${label} | ${m.support} | ${pct(s.precision)} | ${pct(s.recall)} | ${s.f1.toFixed(3)} |`);
  }
  L.push("");

  const wrong = scored.filter((r) => r.predicted !== r.truth);
  if (wrong.length) {
    L.push("## Disagreements");
    L.push("");
    L.push("| id | truth | predicted | boundary rule |");
    L.push("|---|---|---|---|");
    for (const r of wrong) {
      L.push(`| ${r.row.id} | ${r.truth} | ${r.predicted} | ${r.row.boundary_for ?? "—"} |`);
    }
    L.push("");
  }

  // --- baseline comparison -------------------------------------------------
  const baselinePath = join(ROOT, "config/eval/baseline.json");
  const current = {
    recorded_at: new Date().toISOString(),
    gold_set_version: gold.version,
    macro_f1: Number(macroF1.toFixed(4)),
    not_core_precision: Number(notCorePrecision.toFixed(4)),
    exact_accuracy: Number((exact / Math.max(1, scored.length)).toFixed(4)),
    rows_scored: scored.length,
  };

  if (short) {
    process.exitCode = 1;
    if (flag("freeze")) {
      process.stderr.write(
        "\nRefusing to freeze a baseline from an incomplete run: a baseline is the thing\n" +
          "every later run is compared against, and one built from a biased subset makes\n" +
          "every future comparison wrong in the same direction. Re-run first.\n"
      );
      return;
    }
  }
  if (flag("freeze")) {
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(
      baselinePath,
      JSON.stringify(
        {
          "//": [
            "The recorded baseline. NOT an Orange Slice number — none was ever supplied,",
            "so 'meet or exceed the frozen baseline' is measured against this instead, and",
            "the first recording is trivially met. It earns its keep from the second change",
            "onward: every later run is compared here, and a regression is visible.",
          ].join(" "),
          ...current,
        },
        null,
        2
      ) + "\n"
    );
    L.push(`Baseline **recorded** at config/eval/baseline.json (macro-F1 ${current.macro_f1}).`);
  } else if (existsSync(baselinePath)) {
    const prev = JSON.parse(readFileSync(baselinePath, "utf8")) as typeof current;
    const dF1 = current.macro_f1 - prev.macro_f1;
    const dNC = current.not_core_precision - prev.not_core_precision;
    L.push("## Against the recorded baseline");
    L.push("");
    L.push("| metric | baseline | now | change |");
    L.push("|---|---|---|---|");
    L.push(`| macro-F1 | ${prev.macro_f1} | ${current.macro_f1} | ${dF1 >= 0 ? "+" : ""}${dF1.toFixed(4)} |`);
    L.push(`| Not Core precision | ${prev.not_core_precision} | ${current.not_core_precision} | ${dNC >= 0 ? "+" : ""}${dNC.toFixed(4)} |`);
    L.push("");
    L.push(dF1 < -0.02 ? "**REGRESSION** against the recorded baseline." : "No material regression.");
  } else {
    L.push("No baseline recorded yet — re-run with `--freeze` to record this one.");
  }

  const md = L.join("\n") + "\n";
  mkdirSync(join(ROOT, "test-runs"), { recursive: true });
  writeFileSync(join(ROOT, "test-runs/gold-set-report.md"), md);
  process.stdout.write(`\n${md}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
