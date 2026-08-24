/**
 * One-shot: apply db/migrations/20260821000001_pz_log_relax_checks.sql.
 *
 * Statement-by-statement because Neon's HTTP driver takes one statement per
 * query. Safe to re-run: every statement is `drop constraint if exists`.
 * Verify afterwards with `npx tsx scripts/verify-db.ts` — its probe row is
 * v1-shaped, so it fails loudly if this migration has not landed.
 */
import { neon } from "@neondatabase/serverless";
import { loadRootEnv } from "@fundable/shared";

loadRootEnv();
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const sql = neon(url);

const statements = [
  "alter table public.pz_log drop constraint if exists pz_log_trigger_check",
  "alter table public.pz_log drop constraint if exists pz_log_channel_check",
  "alter table public.pz_log drop constraint if exists pz_log_status_check",
];

async function main() {
  for (const s of statements) {
    await sql.query(s);
    console.log("ok:", s);
  }
  const left = await sql.query(
    "select conname from pg_constraint where conrelid = 'public.pz_log'::regclass and contype = 'c'"
  );
  console.log("remaining CHECK constraints on pz_log:", JSON.stringify(left));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
