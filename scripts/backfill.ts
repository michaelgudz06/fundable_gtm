/**
 * Runs a lead export through POST /api/v1/personalize, concurrently, resumably.
 *
 *   npx tsx scripts/backfill.ts --csv ~/Desktop/hubspot-export.csv --stop-at linkedin
 *   npx tsx scripts/backfill.ts --csv ~/Desktop/hubspot-export.csv --limit 25
 *   npx tsx scripts/backfill.ts --csv ... --concurrency 8 --out out/backfill
 *
 * Three things make this quick, in the order they matter:
 *
 *  1. It never re-asks a question it has an answer to. Results append to
 *     results.ndjson as they land, and a re-run skips every email already in
 *     there. A run killed at row 900 resumes at 901 — and even a row it does
 *     redo is near-free, because the API caches the LinkedIn resolution and the
 *     classification for 30 days.
 *  2. It sends a title from the export when there is one. A title short-circuits
 *     BOTH identity lookups and is the single biggest accuracy lever there is:
 *     12% core recall without one, 61% with title+company.
 *  3. It runs `--concurrency` rows in flight. 1306 rows at ~10s cold is 3.8h
 *     sequential and ~28min at 8.
 *
 * The default concurrency is 6, not higher: the binding limit is n8n Cloud's
 * concurrent-execution cap on Fundable's plan, not this process. Raise it only
 * after watching an n8n run queue up.
 *
 * ---- Why the export's linkedin_url is NOT sent by default -------------------
 *
 * It looks like a free saving — supplying it skips the n8n cascade, ~4s and one
 * Apollo credit per row. Measured on a real lead, it is a downgrade:
 *
 *   email + name             -> ICP #6 Founder      0.6s   (cascade -> Apollo title)
 *   email + name + linkedin  -> ICP #9              8.6s   (Fundable /people: not in index)
 *   email + name + title     -> ICP #6 Founder      0.45s  (no lookup at all)
 *
 * Supplying the URL routes identity to Fundable's people index INSTEAD of the
 * cascade (personalize.ts:216). Fundable's index is startup-people-shaped, so
 * for anyone outside it the lookup burns up to its full 8s cap, returns no
 * title, and the lead drops to the email-only classification path — the exact
 * evidence the cascade would have supplied. Slower AND less accurate.
 *
 * `--use-csv-linkedin` opts back in. It is the right call when the export's
 * people ARE in Fundable's index, or when the Apollo credits matter more than
 * the labels. Check with a `--limit 50` run both ways before committing 1306.
 *
 * ponytail: one CSV in, one NDJSON out, no queue and no batch endpoint. The
 * resume file IS the retry story. Add a real queue when a run needs to survive
 * the laptop closing, not before.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ROOT, apiBase, apiKey, arg, flag, mapLimit, parseCsv } from "./lib.js";

type StopAt = "linkedin" | "icp" | "email";

type Lead = {
  row: number;
  email: string;
  first_name: string;
  last_name: string;
  linkedin_url?: string;
  location?: string;
  title?: string;
  company_name?: string;
};

type Result = {
  row: number;
  email: string;
  status: number;
  ms: number;
  linkedin_url: string | null;
  linkedin_source: string;
  icp: string | null;
  email_body: string | null;
  /** True when the export already had the URL, so no cascade and no credit. */
  had_linkedin: boolean;
  /** The export supplied a title, so neither identity lookup ran. */
  had_title: boolean;
  /** Fundable's lookup blew its 8s cap: this row's ICP is the degraded one. */
  identity_timeout: boolean;
  error: string | null;
};

/**
 * HubSpot's column names are not stable across exports and neither are
 * people's. Matching on a normalised header means a re-export with "Email
 * Address" instead of "Email" does not silently produce 1306 skipped rows.
 */
const COLUMNS: Record<keyof Omit<Lead, "row">, string[]> = {
  email: ["email", "emailaddress", "workemail", "contactemail"],
  first_name: ["firstname", "first", "givenname"],
  last_name: ["lastname", "last", "surname", "familyname"],
  linkedin_url: ["linkedinurl", "linkedin", "linkedinprofile", "linkedinbio"],
  location: ["location", "city", "citystate", "contactlocation"],
  title: ["title", "jobtitle", "position", "role"],
  company_name: ["company", "companyname", "employer", "organization"],
};

const normalise = (h: string): string => h.toLowerCase().replace(/[^a-z]/g, "");

function columnIndexes(header: string[]): Record<string, number> {
  const seen = header.map(normalise);
  const out: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(COLUMNS)) {
    const i = seen.findIndex((h) => aliases.includes(h));
    if (i >= 0) out[field] = i;
  }
  return out;
}

function readLeads(path: string): { leads: Lead[]; skipped: { row: number; why: string }[] } {
  const rows = parseCsv(readFileSync(path, "utf8"));
  const header = rows.shift();
  if (!header) throw new Error(`${path} is empty.`);

  const idx = columnIndexes(header);
  for (const required of ["email", "first_name", "last_name"] as const) {
    if (idx[required] === undefined) {
      throw new Error(
        `No column matched "${required}" in [${header.join(", ")}]. ` +
          `Aliases tried: ${COLUMNS[required].join(", ")}.`
      );
    }
  }

  const leads: Lead[] = [];
  const skipped: { row: number; why: string }[] = [];
  const at = (r: string[], f: string): string => (idx[f] === undefined ? "" : (r[idx[f]] ?? "").trim());

  rows.forEach((r, i) => {
    const row = i + 2; // 1-based, plus the header
    const lead: Lead = {
      row,
      email: at(r, "email").toLowerCase(),
      first_name: at(r, "first_name"),
      last_name: at(r, "last_name"),
      linkedin_url: at(r, "linkedin_url") || undefined,
      location: at(r, "location") || undefined,
      title: at(r, "title") || undefined,
      company_name: at(r, "company_name") || undefined,
    };
    // Filtered here rather than sent: the route 400s on these, and spending a
    // request to be told so is the one cost with no upside. 18.4% of the real
    // export fails this gate, and email — not the names — is the binding one.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) skipped.push({ row, why: "no usable email" });
    else if (!lead.first_name || !lead.last_name) skipped.push({ row, why: "missing first or last name" });
    else leads.push(lead);
  });

  return { leads, skipped };
}

async function personalize(
  lead: Lead,
  opts: { base: string; key: string; stopAt: StopAt; messageType: string; templateId: string; useCsvLinkedin: boolean }
): Promise<Result> {
  const started = Date.now();
  const base: Result = {
    row: lead.row,
    email: lead.email,
    status: 0,
    ms: 0,
    linkedin_url: null,
    linkedin_source: "",
    icp: null,
    email_body: null,
    had_linkedin: !!lead.linkedin_url,
    had_title: !!lead.title,
    identity_timeout: false,
    error: null,
  };

  try {
    const res = await fetch(`${opts.base}/api/v1/personalize`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${opts.key}`,
        "content-type": "application/json",
        // Deliberately NO idempotency-key. It would replay a body for 24h, and
        // the row most worth re-running is the one whose identity lookup timed
        // out — a replay would hand back the degraded label instead of retrying
        // it. Re-runs are already cheap: the resolve/person/classification
        // caches are keyed on the evidence and hold for 30 days.
      },
      body: JSON.stringify({
        email: lead.email,
        stop_at: opts.stopAt,
        // See the header note: sending this by default trades a better label
        // for a slower request.
        ...(opts.useCsvLinkedin && lead.linkedin_url ? { linkedin_url: lead.linkedin_url } : {}),
        known_fields: {
          first_name: lead.first_name,
          last_name: lead.last_name,
          ...(opts.useCsvLinkedin && lead.linkedin_url ? { linkedin_url: lead.linkedin_url } : {}),
          ...(lead.location ? { location: lead.location } : {}),
          // Always sent when present: the caller's own assertion wins over both
          // lookups, and skipping them is the fastest path AND the accurate one.
          ...(lead.title ? { title: lead.title } : {}),
          ...(lead.company_name ? { company_name: lead.company_name } : {}),
        },
        // Composition inputs are only legal in the full mode, and only that
        // mode reads them.
        ...(opts.stopAt === "email"
          ? { message_type: opts.messageType, template_id: opts.templateId }
          : {}),
      }),
    });

    const ms = Date.now() - started;
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const e = body.error as { code?: string; message?: string } | undefined;
      return { ...base, status: res.status, ms, error: `${e?.code ?? "HTTP_ERROR"}: ${e?.message ?? ""}`.trim() };
    }
    return {
      ...base,
      status: res.status,
      ms,
      linkedin_url: (body.linkedin_url as string | null) ?? null,
      linkedin_source: res.headers.get("x-linkedin-source") ?? "",
      identity_timeout: res.headers.get("x-identity") === "timeout",
      icp: (body.icp as string | undefined) ?? null,
      email_body: (body.email_body as string | undefined) ?? null,
    };
  } catch (e) {
    return { ...base, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  }
}

async function main(): Promise<void> {
  const csv = arg("csv");
  if (!csv) {
    console.error("Usage: npx tsx scripts/backfill.ts --csv <export.csv> [--stop-at linkedin|icp|email]");
    console.error("       [--concurrency 6] [--limit N] [--out DIR] [--restart] [--dry-run]");
    process.exit(2);
  }

  const stopAt = (arg("stop-at", "email") as StopAt) ?? "email";
  if (!["linkedin", "icp", "email"].includes(stopAt)) {
    console.error(`--stop-at must be linkedin, icp, or email (got "${stopAt}")`);
    process.exit(2);
  }
  const concurrency = Number(arg("concurrency", "6"));
  const limit = Number(arg("limit", "0"));
  const outDir = resolve(ROOT, arg("out", `out/backfill-${stopAt}`) as string);
  const messageType = arg("message-type", "website_visitor") as string;
  const useCsvLinkedin = flag("use-csv-linkedin");
  const templateId = arg("template-id", "website_visitor_use_case") as string;

  const { leads, skipped } = readLeads(resolve(csv));
  mkdirSync(outDir, { recursive: true });
  const resultsPath = join(outDir, "results.ndjson");

  // Resume: whatever already succeeded stays done. --restart is the only way to
  // redo finished rows, so an accidental re-run never costs a second credit.
  let done = new Set<string>();
  if (flag("restart")) writeFileSync(resultsPath, "");
  else if (existsSync(resultsPath)) {
    done = new Set(
      readFileSync(resultsPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as Result).email)
    );
  }

  let todo = leads.filter((l) => !done.has(l.email));
  if (limit > 0) todo = todo.slice(0, limit);

  const withTitle = todo.filter((l) => l.title).length;
  const alreadyLinked = todo.filter((l) => l.linkedin_url).length;
  console.log(
    [
      `csv          ${csv}`,
      `rows         ${leads.length + skipped.length} (${leads.length} usable, ${skipped.length} skipped)`,
      `already done ${done.size}`,
      `to run       ${todo.length}  (${withTitle} have a title -> no identity lookup at all)`,
      useCsvLinkedin
        ? `csv linkedin SENT for ${alreadyLinked} rows -> Fundable /people instead of the cascade`
        : `csv linkedin ignored for ${alreadyLinked} rows (--use-csv-linkedin to send; see the header note)`,
      `mode         stop_at=${stopAt}, concurrency=${concurrency}`,
      `target       ${apiBase()}`,
      `out          ${resultsPath}`,
    ].join("\n")
  );
  if (skipped.length) {
    writeFileSync(join(outDir, "skipped.json"), JSON.stringify(skipped, null, 2));
    console.log(`             skipped rows written to ${join(outDir, "skipped.json")}`);
  }
  if (flag("dry-run") || todo.length === 0) return;

  const opts = { base: apiBase(), key: apiKey(), stopAt, messageType, templateId, useCsvLinkedin };
  const started = Date.now();
  let finished = 0;

  const results = await mapLimit(todo, concurrency, async (lead) => {
    const r = await personalize(lead, opts);
    // Appended the moment it lands, not at the end: a run that dies keeps
    // everything it paid for.
    appendFileSync(resultsPath, `${JSON.stringify(r)}\n`);
    finished += 1;
    if (finished % 25 === 0 || finished === todo.length) {
      const rate = finished / ((Date.now() - started) / 1000);
      const eta = Math.round((todo.length - finished) / Math.max(rate, 0.001));
      console.log(`  ${finished}/${todo.length}  ${rate.toFixed(1)}/s  eta ${Math.floor(eta / 60)}m${eta % 60}s`);
    }
    return r;
  });

  const okRows = results.filter((r) => r.status === 200);
  const withLinkedin = okRows.filter((r) => r.linkedin_url);
  const resolvedByUs = withLinkedin.filter((r) => !r.had_linkedin);
  const icps = new Map<string, number>();
  for (const r of okRows) if (r.icp) icps.set(r.icp, (icps.get(r.icp) ?? 0) + 1);
  const errors = new Map<string, number>();
  for (const r of results.filter((x) => x.status !== 200)) {
    const code = (r.error ?? "unknown").split(":")[0] as string;
    errors.set(code, (errors.get(code) ?? 0) + 1);
  }
  const degraded = okRows.filter((r) => r.identity_timeout);
  const msSorted = okRows.map((r) => r.ms).sort((a, b) => a - b);
  const p = (q: number): number => msSorted[Math.min(msSorted.length - 1, Math.floor(msSorted.length * q))] ?? 0;

  const elapsed = Math.round((Date.now() - started) / 1000);
  const summary = [
    "",
    `done in ${Math.floor(elapsed / 60)}m${elapsed % 60}s`,
    `ok            ${okRows.length}/${results.length}`,
    `linkedin      ${withLinkedin.length} (${resolvedByUs.length} newly resolved, ~${resolvedByUs.length} Apollo credits)`,
    `degraded      ${degraded.length} rows hit the Fundable timeout and were classified without a title` +
      (degraded.length ? " — re-run to pick them up, timeouts are not cached" : ""),
    `latency       p50 ${p(0.5)}ms  p95 ${p(0.95)}ms  max ${msSorted[msSorted.length - 1] ?? 0}ms`,
    errors.size ? `errors        ${[...errors].map(([c, n]) => `${c}=${n}`).join(", ")}` : "errors        none",
    stopAt === "linkedin" ? "" : `icps          ${[...icps].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");
  console.log(summary);
  writeFileSync(join(outDir, "summary.txt"), `${summary.trim()}\n`);

  // A row that errored is still in results.ndjson, so a plain re-run would skip
  // it. Naming the file is cheaper than explaining the flag.
  if (errors.size) {
    const failedPath = join(outDir, "failed.json");
    writeFileSync(failedPath, JSON.stringify(results.filter((r) => r.status !== 200), null, 2));
    console.log(`\n${results.length - okRows.length} failed rows in ${failedPath}`);
    console.log(`retry them with:  npx tsx scripts/backfill.ts --csv ${csv} --stop-at ${stopAt} --retry-failed`);
  }
}

// --retry-failed drops the failed rows from the resume set so the next run
// picks exactly them up, and nothing else.
if (flag("retry-failed")) {
  const stopAt = arg("stop-at", "email") as string;
  const outDir = resolve(ROOT, arg("out", `out/backfill-${stopAt}`) as string);
  const resultsPath = join(outDir, "results.ndjson");
  if (existsSync(resultsPath)) {
    const kept = readFileSync(resultsPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .filter((l) => (JSON.parse(l) as Result).status === 200);
    writeFileSync(resultsPath, kept.length ? `${kept.join("\n")}\n` : "");
    console.log(`retry-failed: kept ${kept.length} successful rows, cleared the rest\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
