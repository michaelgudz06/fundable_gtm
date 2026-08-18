/**
 * Why did THIS lead get THAT label?
 *
 * The API returns exactly three keys, so the classifier's reasoning and the
 * research it read are invisible from outside — fine as a contract, useless
 * when a whole ICP is being rejected and nobody can say why. This runs the same
 * classification in-process and prints what the model actually saw.
 *
 *   npx tsx scripts/debug-classify.ts "Devin Gfeller" broker@example.com "commercial real estate broker and principal"
 *   npx tsx scripts/debug-classify.ts --preset cre
 */

import { classifyV2, researchTarget } from "../apps/api/src/lib/v2/classify";
import { loadRootEnv } from "../packages/fundable-shared/src/env.js";
import { answer, newExaLedger } from "@fundable/shared";

type Probe = { name: string; email: string; title: string; company?: string };

const PRESETS: Record<string, Probe[]> = {
  // Every one of these is a real lead the reference labelled ICP #2 and we did not.
  cre: [
    { name: "Devin Gfeller", email: "devin@gfellerco.com", title: "commercial real estate broker and principal" },
    { name: "Robert Stillman", email: "robert.stillman@cbre.com", title: "Vice Chairman", company: "CBRE" },
    { name: "Loralie Ogden", email: "loralie.ogden@cbre.com", title: "First Vice President", company: "CBRE" },
    { name: "Jim McCahon", email: "jim.mccahon@jll.com", title: "Director, Transactions Management", company: "JLL" },
  ],
  // Titles that ARE in #19's eligible role list, still landing Not Core.
  investor: [
    { name: "Jack Leeney", email: "leeney3@aol.com", title: "Managing Partner and Co-Founder", company: "7GC" },
    { name: "Scott Lopano", email: "scottlopano@gmail.com", title: "Partner", company: "Sweater Ventures" },
    { name: "Poojan Mehta", email: "pmehta@personstpartners.com", title: "Partner/Co-Founder" },
    { name: "Roseanne Wincek", email: "rwincek@gmail.com", title: "Co-Founder & Managing Director", company: "Renegade Partners" },
  ],
};

async function probe(p: Probe) {
  const exa = newExaLedger();
  const domain = p.email.split("@").pop() ?? "";
  const target = researchTarget({ emailDomain: domain, company: p.company });

  process.stdout.write(`\n${"=".repeat(78)}\n${p.name} — "${p.title}" <${domain}>\n${"=".repeat(78)}\n`);

  if (target) {
    try {
      const a = await answer(target.query, exa);
      process.stdout.write(`RESEARCH (${target.kind}:${target.value}):\n  ${a.text.replace(/\n/g, "\n  ").slice(0, 700)}\n\n`);
    } catch (e) {
      process.stdout.write(`RESEARCH FAILED: ${(e as Error).message}\n\n`);
    }
  } else {
    process.stdout.write("RESEARCH: no target\n\n");
  }

  const res = await classifyV2({ email: p.email, title: p.title, company: p.company }, exa);
  process.stdout.write(`VERDICT : ${res.label}\nPATH    : ${res.path}\nREASON  : ${res.reasoning}\n`);
  if (res.warnings.length) process.stdout.write(`WARNINGS: ${res.warnings.join(" | ")}\n`);
}

async function main() {
  // Loaded before any client reads process.env, which they do lazily per call.
  loadRootEnv();
  const presetIdx = process.argv.indexOf("--preset");
  const probes: Probe[] =
    presetIdx >= 0
      ? PRESETS[process.argv[presetIdx + 1] ?? "cre"] ?? []
      : [{ name: process.argv[2] ?? "", email: process.argv[3] ?? "", title: process.argv[4] ?? "" }];

  for (const p of probes) await probe(p);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
