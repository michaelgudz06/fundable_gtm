#!/usr/bin/env npx tsx
/**
 * Verifies the database side of the Personalization API.
 *
 *   npx tsx scripts/verify-db.ts
 *
 * Run it before applying db/migrations/ to see exactly what is missing, and
 * again afterwards to confirm the schema and the round-trips are right.
 *
 * Two halves, and the second is the one that matters:
 *
 *   1. Schema — do the tables, columns and purge functions exist.
 *   2. Behaviour — drive the REAL NeonStorage the API uses and check the values
 *      come back the shape they went in.
 *
 * Half 2 exists because no unit test touches storage: all of them run against
 * NoopStorage, so a completely broken driver passes `npm test`. It also targets
 * the specific way this port could fail quietly — jsonb columns handed a JS
 * object bind as a Postgres array, so `payload` and `evidence` are where a bad
 * migration shows up first.
 *
 * (This replaces verify-supabase.ts. Its RLS assertions are gone rather than
 * ported: they checked that a browser-facing publishable key could not read
 * these tables, and Neon has no such key — the only principal is the owner role
 * in DATABASE_URL, which RLS does not apply to. The control is now "that string
 * never leaves the server", which no script can assert.)
 */

import { deepStrictEqual } from "node:assert";
import { neon } from "@neondatabase/serverless";
import { loadRootEnv } from "../packages/fundable-shared/src/env.js";
import { getStorage, type LogRow } from "../apps/api/src/lib/storage.js";

loadRootEnv();

const CONN = process.env.DATABASE_URL;

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

if (!CONN) {
  console.error("DATABASE_URL must be set in .env");
  process.exit(2);
}

const sql = neon(CONN);

/** Host only — the connection string carries a password, so never print it whole. */
const hostOf = (conn: string) => {
  try {
    return new URL(conn).host;
  } catch {
    return "(unparseable)";
  }
};

const EXPECTED: Record<string, string[]> = {
  pz_cache: [
    "id", "cache_key", "source", "payload", "fetched_at", "expires_at", "hit_count", "last_hit_at",
  ],
  pz_log: [
    "id", "created_at", "retain_until", "api_key_hash",
    "trigger", "channel", "person_email", "person_linkedin", "person_name",
    "sender_context", "max_facts", "template_provided",
    "company_id", "company_name", "company_domain", "person_id",
    "status", "confidence", "angle", "subject", "body",
    "evidence", "warnings", "verify_issues", "verify_retried",
    "fundable_credits", "exa_cost_usd", "llm_tokens", "latency_ms",
    "voice_id", "voice_provenance",
  ],
};

async function main() {
  console.log(`Verifying ${hostOf(CONN!)}`);

  // -------------------------------------------------------------------------
  head("Connectivity");
  try {
    const rows = await sql`select version() as v, current_database() as db`;
    const row = rows[0] as { v: string; db: string } | undefined;
    pass(`connected to ${row?.db} — ${row?.v.split(",")[0]}`);
  } catch (err) {
    fail(`cannot connect — ${(err as Error).message}`);
    console.log("\nCannot continue without a working connection.");
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  head("Tables exist");
  const present = new Set(
    (
      await sql`select table_name from information_schema.tables where table_schema = 'public'`
    ).map((r) => (r as { table_name: string }).table_name)
  );
  const missing: string[] = [];
  for (const t of Object.keys(EXPECTED)) {
    if (present.has(t)) pass(`${t} present`);
    else {
      fail(`${t} MISSING — apply db/migrations/ in filename order`);
      missing.push(t);
    }
  }
  if (missing.length === Object.keys(EXPECTED).length) {
    console.log("\nNeither table exists. Apply both files in db/migrations/, then re-run.");
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  for (const [table, columns] of Object.entries(EXPECTED)) {
    if (missing.includes(table)) continue;
    head(`${table} columns`);
    const actual = new Set(
      (
        await sql`select column_name from information_schema.columns
                   where table_schema = 'public' and table_name = ${table}`
      ).map((r) => (r as { column_name: string }).column_name)
    );
    const absent = columns.filter((c) => !actual.has(c));
    if (absent.length === 0) pass(`all ${columns.length} columns present`);
    else fail(`missing: ${absent.join(", ")}`);
  }

  // -------------------------------------------------------------------------
  // Everything below drives the real NeonStorage, not hand-written SQL.
  const storage = getStorage();
  const stamp = `verify-db-${process.pid}`;

  head("pz_cache round-trip (through NeonStorage)");
  if (missing.includes("pz_cache")) {
    warn("pz_cache absent; skipping");
  } else {
    const key = `${stamp}|https://linkedin.com/in/nobody`;
    // Nested object + array: if the ::jsonb cast were wrong this comes back
    // mangled or the insert fails outright.
    const payload = { company: { name: "Example Inc", raised: 1_000_000 }, tags: ["a", "b"] };

    await storage.cacheSet(key, "fundable", payload, 60_000);
    if (storage.lastError) fail(`cacheSet — ${storage.lastError}`);

    const got = await storage.cacheGet(key, "fundable");
    if (storage.lastError) {
      fail(`cacheGet — ${storage.lastError}`);
    } else {
      // Structural compare, not stringified: jsonb does not preserve key order,
      // so `JSON.stringify(a) === JSON.stringify(b)` fails on identical data.
      try {
        deepStrictEqual(got, payload);
        pass("payload round-trips as jsonb, structure intact");
      } catch {
        fail(`payload came back as ${JSON.stringify(got)}`);
      }
    }

    // The (cache_key, source) upsert: a second write must replace, not duplicate.
    await storage.cacheSet(key, "fundable", { ...payload, tags: ["c"] }, 60_000);
    const updated = (await storage.cacheGet(key, "fundable")) as { tags?: string[] } | null;
    if (updated?.tags?.[0] === "c") pass("second write upserts on (cache_key, source)");
    else fail(`upsert did not replace the row — tags are ${JSON.stringify(updated?.tags)}`);

    const [{ n }] = (await sql`
      select count(*)::int as n from public.pz_cache where cache_key = ${key}
    `) as [{ n: number }];
    if (n === 1) pass("exactly one row for the key");
    else fail(`${n} rows for one cache_key — the unique constraint is not holding`);

    // Expiry is the reason the cache is safe to trust; prove the filter works.
    await storage.cacheSet(`${key}-expired`, "exa", payload, -60_000);
    const expired = await storage.cacheGet(`${key}-expired`, "exa");
    if (expired === null) pass("an expired row reads as a miss");
    else fail("expired row was returned as a hit");

    await sql`delete from public.pz_cache where cache_key like ${`${stamp}%`}`;
    pass("probe rows removed");
  }

  // -------------------------------------------------------------------------
  head("pz_log round-trip (through NeonStorage)");
  if (missing.includes("pz_log")) {
    warn("pz_log absent; skipping");
  } else {
    const row: LogRow = {
      api_key_hash: stamp,
      trigger: "post-raise",
      channel: "email",
      person_email: "verify-script@example.invalid",
      person_linkedin: null,
      person_name: null,
      sender_context: null,
      max_facts: 3,
      template_provided: false,
      company_id: null,
      company_name: null,
      company_domain: "example.invalid",
      person_id: null,
      status: "template_only",
      confidence: 0.75,
      angle: null,
      subject: null,
      body: null,
      evidence: [{ fact: "raised a Series A", source: "fundable", confidence: 1 }],
      warnings: ["probe row"],
      verify_issues: null,
      verify_retried: false,
      fundable_credits: 1,
      exa_cost_usd: 0.0025,
      llm_tokens: 100,
      latency_ms: 1234,
      voice_id: null,
      voice_provenance: "placeholder",
    };

    await storage.log(row);
    if (storage.lastError) {
      fail(`log — ${storage.lastError}`);
    } else {
      const found = (await sql`
        select id, created_at, retain_until, evidence, warnings, confidence, exa_cost_usd
          from public.pz_log where api_key_hash = ${stamp}
      `) as {
        id: string;
        created_at: string;
        retain_until: string;
        evidence: unknown;
        warnings: unknown;
        confidence: string;
        exa_cost_usd: string;
      }[];

      if (found.length !== 1) {
        fail(`expected 1 logged row, found ${found.length}`);
      } else {
        const r = found[0]!;
        pass("all 28 columns accepted");

        // The failure this port was most likely to ship: an object bound as an
        // array reads back as a string or a flattened list.
        const ev = r.evidence as { fact?: string }[];
        if (Array.isArray(ev) && ev[0]?.fact === "raised a Series A") pass("evidence round-trips as jsonb objects");
        else fail(`evidence came back as ${JSON.stringify(r.evidence)}`);

        if (Array.isArray(r.warnings) && r.warnings[0] === "probe row") pass("warnings round-trips as jsonb");
        else fail(`warnings came back as ${JSON.stringify(r.warnings)}`);

        if (Number(r.confidence) === 0.75) pass("confidence keeps its numeric(3,2) value");
        else fail(`confidence came back as ${r.confidence}`);

        // Retention is a promise, so check the default rather than trusting DDL.
        const days = (new Date(r.retain_until).getTime() - new Date(r.created_at).getTime()) / 86_400_000;
        if (Math.abs(days - 90) < 1) pass(`retain_until defaults to +${Math.round(days)} days`);
        else fail(`retain_until is +${days.toFixed(1)} days; expected +90`);
      }

      await sql`delete from public.pz_log where api_key_hash = ${stamp}`;
      pass("probe row removed");
    }
  }

  // -------------------------------------------------------------------------
  head("Purge functions");
  for (const fn of ["pz_cache_purge_expired", "pz_log_purge_expired"] as const) {
    try {
      const rows = await sql.query(`select public.${fn}() as removed`);
      pass(`${fn}() callable (removed ${(rows[0] as { removed: number }).removed} expired rows)`);
    } catch (err) {
      fail(`${fn}() — ${(err as Error).message}`);
    }
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
