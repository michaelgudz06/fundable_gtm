/**
 * Terminal reviewer for the gold-set queue. One keystroke per row.
 *
 *   npx tsx scripts/review-gold-set.ts
 *
 * The queue is 60 rows of "here is a person and a label somebody proposed".
 * Deciding each one needs three things in front of you at once: who the person
 * is, what the proposed label actually requires, and why the label was
 * proposed. Hand-editing the JSON gives you the first and third but not the
 * second — you would be holding nineteen role definitions and three evidence
 * gates in your head — so this prints the registry's own rule under every card.
 *
 * It also removes the one way hand-editing silently loses work: `relabel:` takes
 * an EXACT label string, and a near-miss ("ICP #6 Founder", no colon) does not
 * error. It falls out of the approved set at build time and the row is simply
 * gone. Here you pick a relabel from a numbered list, so the string is always
 * one the registry recognises.
 *
 * Every decision is written to disk immediately. Quit whenever; rerunning picks
 * up at the first undecided row.
 */

import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { icpEntries, icpByNumber, icpLabel } from "../apps/api/src/lib/v2/registry";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const QUEUE = join(ROOT, "config/eval/review_queue.json");

type Row = {
  id: string;
  proposed_label: string;
  email: string;
  title?: string;
  company?: string;
  linkedin?: string;
  source: string;
  boundary_for?: string;
  slice?: string;
  decision: string;
  note: string;
};
type Queue = { "//": string; generated_at: string; rows: Row[] };

// ---------------------------------------------------------------------------

const NO_COLOR = process.env.NO_COLOR !== undefined || !process.stdout.isTTY;
const c = (code: string) => (s: string | number) => (NO_COLOR ? String(s) : `\x1b[${code}m${s}\x1b[0m`);
const bold = c("1");
const dim = c("2");
const green = c("32");
const red = c("31");
const yellow = c("33");
const cyan = c("36");

/** Every label a decision may produce, in registry order, plus Not Core. */
const LABELS: string[] = [...icpEntries().map((e) => icpLabel(e.number)), "Not Core ICP"];

function labelNumber(label: string): number | null {
  const m = label.match(/^ICP #(\d+):/);
  return m ? Number(m[1]) : null;
}

/**
 * The registry's own words for what this label requires.
 *
 * This is the part you cannot get from the queue file. A proposed label is only
 * checkable against the rule that defines it, and the rules are not memorable —
 * #2 is a default-deny producer ladder, #11 is a four-role list, three ICPs
 * carry evidence gates that industry alone must never satisfy.
 */
function ruleFor(label: string): string[] {
  const n = labelNumber(label);
  if (n === null) {
    return [
      dim("Not Core is the residual: no core ICP fits, or a hard exclusion fired"),
      dim("(residential real estate, public-market investing, fund back-office)."),
    ];
  }
  const e = icpByNumber(n);
  if (!e) return [red(`#${n} is not in the registry`)];

  const gate =
    e.evidence_gate === "startup_customers_required"
      ? yellow("GATE: startup customers must be CONFIRMED in evidence — industry never implies it")
      : e.evidence_gate === "startup_focus"
        ? yellow("GATE: the company must be built for startups — enterprise/BigLaw focus fails closed")
        : dim("gate: none");

  return [
    `${dim("roles  ")} ${e.roles}`,
    `${dim("company")} ${e.company}`,
    `         ${gate}`,
    ...(e.catch_all ? [`         ${yellow("CATCH-ALL: applies only when no specific ICP fits")}`] : []),
    ...(e.note ? [`${dim("note   ")} ${dim(e.note)}`] : []),
  ];
}

function card(r: Row, idx: number, total: number, done: number): string {
  const person = [r.title, r.company ?? r.email.split("@")[1]].filter(Boolean).join("  ·  ");
  const lines = [
    "",
    `${dim(`row ${idx + 1} of ${total}`)}  ${dim("·")}  ${dim(`${done} decided`)}  ${dim("·")}  ${dim(r.id)}`,
    "",
    `  ${bold(person || r.email)}`,
    `  ${dim(r.email)}${r.linkedin ? dim(`  ·  ${r.linkedin}`) : ""}`,
    "",
    `  ${dim("proposed")}  ${cyan(r.proposed_label)}   ${dim(`(${r.source})`)}`,
    "",
    ...ruleFor(r.proposed_label).map((l) => `  ${l}`),
    "",
    ...(r.boundary_for ? [`  ${dim("pins rule")} ${r.boundary_for}`, ""] : []),
    ...(r.note ? [`  ${dim(wrap(r.note, 76).join("\n  " + dim("")))}`, ""] : []),
  ];
  return lines.join("\n");
}

function wrap(s: string, w: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of s.split(/\s+/)) {
    if ((line + " " + word).trim().length > w) {
      out.push(line.trim());
      line = word;
    } else line += " " + word;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}

/** Write via temp + rename so a crash mid-write cannot truncate the queue. */
function save(q: Queue): void {
  const tmp = `${QUEUE}.tmp`;
  writeFileSync(tmp, JSON.stringify(q, null, 2) + "\n");
  renameSync(tmp, QUEUE);
}

function tally(rows: Row[]) {
  const t = { approve: 0, reject: 0, relabel: 0, undecided: 0 };
  for (const r of rows) {
    if (r.decision.startsWith("approve")) t.approve++;
    else if (r.decision.startsWith("relabel:")) t.relabel++;
    else if (r.decision.startsWith("reject")) t.reject++;
    else t.undecided++;
  }
  return t;
}

// ---------------------------------------------------------------------------

async function key(): Promise<string> {
  return new Promise((res) => {
    const stdin = process.stdin;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const on = (k: string) => {
      stdin.removeListener("data", on);
      stdin.setRawMode?.(false);
      stdin.pause();
      // Raw mode delivers a chunk, not a character: an arrow key is three bytes
      // and a fast typist can land two keys in one event. Take the first only.
      res(k[0] ?? "");
    };
    stdin.on("data", on);
  });
}

async function pickLabel(current: string): Promise<string | null> {
  process.stdout.write(`\n  ${bold("Relabel to:")}\n`);
  LABELS.forEach((l, i) => {
    const tag = String(i + 1).padStart(2);
    const mark = l === current ? dim(" (proposed)") : "";
    process.stdout.write(`   ${dim(tag)}  ${l}${mark}\n`);
  });
  process.stdout.write(`\n  ${dim("number then Enter, or Enter alone to cancel: ")}`);

  process.stdin.setRawMode?.(false);
  process.stdin.resume();
  const line = await new Promise<string>((res) => {
    const on = (d: Buffer) => {
      process.stdin.removeListener("data", on);
      res(d.toString());
    };
    process.stdin.on("data", on);
  });
  process.stdin.pause();

  const n = Number(line.trim());
  if (!line.trim() || !Number.isInteger(n) || n < 1 || n > LABELS.length) return null;
  return LABELS[n - 1]!;
}

const HELP = [
  "",
  `  ${bold("a")} approve      the proposed label is correct`,
  `  ${bold("r")} reject       the person does not belong in the gold set at all`,
  `  ${bold("l")} relabel      correct label, chosen from the registry list`,
  `  ${bold("s")} skip         leave undecided, come back later`,
  `  ${bold("u")} undo         reopen the previous row`,
  `  ${bold("q")} quit         save and exit — rerun resumes here`,
  "",
  `  ${dim("reject vs relabel: reject means the row is unusable (wrong person, dead")}`,
  `  ${dim("company, ambiguous). relabel means the person is fine and the label is not.")}`,
  "",
].join("\n");

async function main() {
  const q = JSON.parse(readFileSync(QUEUE, "utf8")) as Queue;
  const rows = q.rows;

  if (process.argv.includes("--status")) {
    const t = tally(rows);
    process.stdout.write(
      `\n  ${t.approve} approved · ${t.relabel} relabelled · ${t.reject} rejected · ${t.undecided} undecided\n\n`
    );
    return;
  }

  if (!process.stdin.isTTY) {
    process.stdout.write(
      "\nThis reviewer needs an interactive terminal.\n" +
        "Run it from your own shell:  npx tsx scripts/review-gold-set.ts\n\n"
    );
    process.exitCode = 1;
    return;
  }

  const reviewAll = process.argv.includes("--all");
  process.stdout.write(`\n${bold("Gold-set review")} ${dim(`— ${rows.length} rows`)}\n${HELP}`);

  const history: number[] = [];
  let i = 0;
  while (i < rows.length) {
    const r = rows[i]!;
    if (r.decision && !reviewAll) {
      i++;
      continue;
    }
    const t = tally(rows);
    process.stdout.write(card(r, i, rows.length, t.approve + t.reject + t.relabel));
    process.stdout.write(`  ${dim("[a]pprove  [r]eject  re[l]abel  [s]kip  [u]ndo  [q]uit  [?]help")}  `);

    const k = (await key()).toLowerCase();
    process.stdout.write("\n");

    // Raw mode swallows SIGINT: Ctrl-C arrives as \x03 data, not a signal.
    // Without this the only way out is `q`, and someone who does not know that
    // is stuck in a terminal that appears to ignore Ctrl-C. \x04 is Ctrl-D.
    if (!k || k === "q" || k === "\x03" || k === "\x04") break;
    if (k === "?") {
      process.stdout.write(HELP);
      continue;
    }
    if (k === "u") {
      const prev = history.pop();
      if (prev === undefined) {
        process.stdout.write(`  ${dim("nothing to undo")}\n`);
        continue;
      }
      rows[prev]!.decision = "";
      save(q);
      i = prev;
      continue;
    }
    if (k === "s") {
      history.push(i);
      i++;
      continue;
    }
    if (k === "a") {
      r.decision = "approve";
      process.stdout.write(`  ${green("approved")} ${dim(r.proposed_label)}\n`);
    } else if (k === "r") {
      r.decision = "reject";
      process.stdout.write(`  ${red("rejected")}\n`);
    } else if (k === "l") {
      const picked = await pickLabel(r.proposed_label);
      if (!picked) {
        process.stdout.write(`  ${dim("cancelled")}\n`);
        continue;
      }
      // An approve and a relabel-to-the-same-label mean the same thing; record
      // the simpler one so the built set does not carry a pointless diff.
      r.decision = picked === r.proposed_label ? "approve" : `relabel:${picked}`;
      process.stdout.write(`  ${yellow("relabelled")} ${dim("->")} ${picked}\n`);
    } else {
      process.stdout.write(`  ${dim("unrecognised key — ? for help")}\n`);
      continue;
    }

    save(q);
    history.push(i);
    i++;
  }

  const t = tally(rows);
  const decided = t.approve + t.reject + t.relabel;
  process.stdout.write(
    `\n  ${bold("Saved.")} ${green(`${t.approve} approved`)} · ${yellow(`${t.relabel} relabelled`)} · ` +
      `${red(`${t.reject} rejected`)} · ${t.undecided} left\n`
  );
  if (t.undecided > 0) {
    process.stdout.write(`  ${dim("rerun to continue: npx tsx scripts/review-gold-set.ts")}\n\n`);
  } else if (decided > 0) {
    process.stdout.write(`  ${dim("build the set:    npx tsx scripts/build-gold-set.ts --approve")}\n\n`);
  }
}

main().catch((e) => {
  process.stdin.setRawMode?.(false);
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
