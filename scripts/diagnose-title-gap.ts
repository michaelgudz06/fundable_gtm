/**
 * Is the missing job title the whole story?
 *
 * The benchmark said the reference classifier and this API agree on rejection
 * and diverge almost completely on acceptance: 10 of 83 core leads recovered.
 * Every ICP in the registry gates on ROLE, and a visitor list carries no title,
 * so the suspicion is that the classifier is fine and the INPUT is starving it.
 *
 * This tests that directly, on rows the benchmark missed:
 *   1. call the API exactly as the benchmark did          -> the miss
 *   2. resolve a title from the LinkedIn URL via Exa      -> the candidate fix
 *   3. call again with that title supplied                -> the recovery
 *
 * The title comes from Exa, never from the reference key's reasoning, so this
 * measures a fix we could actually ship rather than leaking the answer.
 *
 *   npx tsx scripts/diagnose-title-gap.ts --n 10
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { findPerson, newExaLedger } from "@fundable/shared";

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
for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v;

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};

const BASE = (arg("base", "https://personalize-api-umber.vercel.app") ?? "").replace(/\/$/, "");
const KEY = env.PERSONALIZE_API_KEY ?? "";

type Miss = { first: string; last: string; email: string; linkedin: string; keyLabel: string };

async function classify(row: Miss, title?: string, company?: string): Promise<string> {
  const known: Record<string, string> = { first_name: row.first };
  if (title) known.title = title;
  if (company) known.company_name = company;
  const res = await fetch(`${BASE}/api/v1/personalize`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      email: row.email,
      linkedin_url: row.linkedin || undefined,
      message_type: "website_visitor",
      template_id: "website_visitor_use_case",
      known_fields: known,
      additional_context: { sender_name: "Jacob" },
    }),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status !== 200) return `HTTP ${res.status} ${(j.error as { code?: string })?.code ?? ""}`;
  return String(j.icp);
}

async function main() {
  const results = JSON.parse(
    readFileSync(join(ROOT, "test-runs/icp-benchmark/results.json"), "utf8")
  ) as { results: { verdict: string; ourLabel: string | null; row: Miss & { keyLabel: string } }[] };

  const missed = results.results
    .filter((r) => r.verdict === "missed_core" && r.row.linkedin && r.row.email)
    .slice(0, Number(arg("n", "10")));

  const exa = newExaLedger();
  process.stdout.write(`Testing ${missed.length} missed core leads.\n\n`);

  let resolved = 0;
  let recovered = 0;
  for (const m of missed) {
    const row = m.row;
    const name = `${row.first} ${row.last}`.trim();
    const domain = row.email.split("@").pop() ?? "";
    let title: string | undefined;
    let company: string | undefined;
    try {
      // The current role is the first work-history entry with no end date,
      // falling back to the most recent one. ExaPerson has no flat `title`.
      const { person } = await findPerson({ name, company: domain }, exa);
      const current = person?.workHistory.find((w) => !w.to) ?? person?.workHistory[0];
      title = current?.title ?? undefined;
      company = current?.company ?? undefined;
    } catch (e) {
      title = undefined;
    }
    if (title) resolved++;

    const after = title ? await classify(row, title, company) : "(no title resolved)";
    const hit = after === row.keyLabel;
    if (hit) recovered++;

    process.stdout.write(
      `${hit ? "RECOVERED" : "         "} ${name} <${domain}>\n` +
        `    reference : ${row.keyLabel}\n` +
        `    before    : ${m.ourLabel}\n` +
        `    exa title : ${title ?? "—"}${company ? ` @ ${company}` : ""}\n` +
        `    after     : ${after}\n\n`
    );
  }

  process.stdout.write(
    `Exa resolved a title for ${resolved}/${missed.length}. ` +
      `With that title, ${recovered}/${missed.length} match the reference label exactly.\n` +
      `Exa spend: $${exa.usd.toFixed(4)}\n`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
