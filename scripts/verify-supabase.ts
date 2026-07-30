#!/usr/bin/env npx tsx
/**
 * Verifies the Supabase side of the Personalization API over plain REST.
 *
 *   npx tsx scripts/verify-supabase.ts
 *
 * Run it before applying the migrations to see exactly what is missing, and
 * again afterwards to confirm the schema and the access rules are right.
 *
 * The RLS checks are the important ones. pz_log holds generated outbound copy
 * about real people, and the publishable key ships to the browser in the demo
 * UI. "RLS is enabled" is not the same claim as "the browser key cannot read
 * it", so this asserts the second one directly.
 */

import { loadRootEnv } from "../packages/fundable-shared/src/env.js";

loadRootEnv();

const URL_BASE = process.env.SUPABASE_URL;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const PUBLISHABLE = process.env.SUPABASE_PUBLISHABLE_KEY;

let failures = 0;
let warnings = 0;

const pass = (m: string) => console.log(`  \x1b[32mPASS\x1b[0m  ${m}`);
const fail = (m: string) => {
  failures++;
  console.log(`  \x1b[31mFAIL\x1b[0m  ${m}`);
};
const warn = (m: string) => {
  warnings++;
  console.log(`  \x1b[33mWARN\x1b[0m  ${m}`);
};
const head = (m: string) => console.log(`\n${m}`);

if (!URL_BASE || !SECRET) {
  console.error("SUPABASE_URL and SUPABASE_SECRET_KEY must be set in .env");
  process.exit(2);
}

type Probe = { status: number; body: string };

async function probe(path: string, key: string): Promise<Probe> {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  return { status: res.status, body: (await res.text()).slice(0, 300) };
}

/** Selecting a named column is how PostgREST tells us whether it exists. */
async function columnsExist(table: string, columns: string[]): Promise<void> {
  for (const col of columns) {
    const r = await probe(`${table}?select=${col}&limit=0`, SECRET!);
    if (r.status === 200) pass(`${table}.${col}`);
    else fail(`${table}.${col} — HTTP ${r.status} ${r.body}`);
  }
}

async function main() {
  console.log(`Verifying ${URL_BASE}`);

  // -------------------------------------------------------------------------
  head("Connectivity");
  const root = await probe("", SECRET);
  if (root.status === 200) pass("secret key authenticates against /rest/v1/");
  else {
    fail(`secret key rejected — HTTP ${root.status} ${root.body}`);
    console.log("\nCannot continue without a working secret key.");
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  head("Tables exist");
  const tables = ["pz_cache", "pz_log"];
  const missing: string[] = [];
  for (const t of tables) {
    const r = await probe(`${t}?select=*&limit=1`, SECRET);
    if (r.status === 200) pass(`${t} present`);
    else if (r.status === 404) {
      fail(`${t} MISSING — apply supabase/migrations/ in filename order`);
      missing.push(t);
    } else fail(`${t} — HTTP ${r.status} ${r.body}`);
  }

  if (missing.length === tables.length) {
    console.log(
      "\nNeither table exists yet. Apply both files in supabase/migrations/" +
        " (in filename order), then re-run this script."
    );
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  if (!missing.includes("pz_cache")) {
    head("pz_cache columns");
    await columnsExist("pz_cache", [
      "id", "cache_key", "source", "payload", "fetched_at", "expires_at", "hit_count", "last_hit_at",
    ]);
  }

  if (!missing.includes("pz_log")) {
    head("pz_log columns");
    await columnsExist("pz_log", [
      "id", "created_at", "retain_until", "api_key_hash",
      "trigger", "channel", "person_email", "person_linkedin", "person_name",
      "sender_context", "max_facts", "template_provided",
      "company_id", "company_name", "company_domain", "person_id",
      "status", "confidence", "angle", "subject", "body",
      "evidence", "warnings", "verify_issues", "verify_retried",
      "fundable_credits", "exa_cost_usd", "llm_tokens", "latency_ms",
      "voice_id", "voice_provenance",
    ]);
  }

  // -------------------------------------------------------------------------
  // The security property the migrations are supposed to guarantee.
  head("RLS — the browser key must not reach either table");
  if (!PUBLISHABLE) {
    warn("SUPABASE_PUBLISHABLE_KEY not set; skipping the RLS assertions");
  } else {
    for (const t of tables) {
      if (missing.includes(t)) continue;
      const r = await probe(`${t}?select=*&limit=1`, PUBLISHABLE);
      if (r.status === 200) {
        // Empty-but-200 still means the key got through the policy check.
        fail(
          `${t} is READABLE with the publishable key (HTTP 200). ` +
            `RLS is not denying anon — do not ship the demo UI until this fails.`
        );
      } else pass(`${t} denied to the publishable key (HTTP ${r.status})`);
    }
  }

  // -------------------------------------------------------------------------
  head("Retention default on pz_log");
  if (missing.includes("pz_log")) {
    warn("pz_log absent; skipping");
  } else {
    // Round-trip one row rather than trusting the DDL: retention is a promise.
    const insert = await fetch(`${URL_BASE}/rest/v1/pz_log`, {
      method: "POST",
      headers: {
        apikey: SECRET!,
        Authorization: `Bearer ${SECRET}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        trigger: "post-raise",
        channel: "email",
        status: "template_only",
        person_email: "verify-script@example.invalid",
        company_domain: "example.invalid",
      }),
    });

    if (!insert.ok) {
      fail(`could not insert a probe row — HTTP ${insert.status} ${(await insert.text()).slice(0, 300)}`);
    } else {
      const rows = (await insert.json()) as { id: string; created_at: string; retain_until: string }[];
      const row = rows[0];
      if (!row) {
        fail("insert returned no representation");
      } else {
        const days =
          (new Date(row.retain_until).getTime() - new Date(row.created_at).getTime()) / 86_400_000;
        if (Math.abs(days - 90) < 1) pass(`retain_until defaults to +${Math.round(days)} days`);
        else fail(`retain_until is +${days.toFixed(1)} days; expected +90`);

        // Clean up after ourselves — this is a real table, not a fixture.
        const del = await fetch(`${URL_BASE}/rest/v1/pz_log?id=eq.${row.id}`, {
          method: "DELETE",
          headers: { apikey: SECRET!, Authorization: `Bearer ${SECRET}` },
        });
        if (del.ok) pass("probe row removed");
        else warn(`probe row ${row.id} left behind — HTTP ${del.status}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  head("Purge functions");
  for (const fn of ["pz_cache_purge_expired", "pz_log_purge_expired"]) {
    const res = await fetch(`${URL_BASE}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: SECRET!, Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
      body: "{}",
    });
    if (res.ok) pass(`${fn}() callable (removed ${(await res.text()).trim()} expired rows)`);
    else fail(`${fn}() — HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  // -------------------------------------------------------------------------
  console.log(
    `\n${failures === 0 ? "\x1b[32mAll checks passed\x1b[0m" : `\x1b[31m${failures} check(s) failed\x1b[0m`}` +
      `${warnings ? `, ${warnings} warning(s)` : ""}.`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\nUnexpected error: ${(err as Error).message}`);
  process.exit(2);
});
