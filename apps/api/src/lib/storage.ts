/**
 * Storage behind a small interface so it stays swappable (spec §1.6).
 *
 * Two implementations: Neon over its serverless HTTP driver, and a no-op used
 * when DATABASE_URL is absent. Storage must never break a request — a
 * personalization that worked is not made a failure by a logging hiccup — so
 * every method catches, records the problem, and returns. The orchestrator
 * surfaces `lastError` as a response warning instead.
 *
 * That swappability was not theoretical: this file was Supabase-over-PostgREST
 * until the project behind it disappeared. Nothing above `getStorage()` changed
 * when it moved here.
 */

import { neon } from "@neondatabase/serverless";
import { LEG_TIMEOUT_MS, optionalEnv } from "@fundable/shared";

export type CacheSource = "fundable" | "exa";

export type LogRow = {
  api_key_hash: string | null;
  trigger: string;
  channel: string;
  person_email: string | null;
  person_linkedin: string | null;
  person_name: string | null;
  sender_context: string | null;
  max_facts: number;
  template_provided: boolean;
  company_id: string | null;
  company_name: string | null;
  company_domain: string | null;
  person_id: string | null;
  status: string;
  confidence: number | null;
  angle: string | null;
  subject: string | null;
  body: string | null;
  evidence: unknown[];
  warnings: unknown[];
  verify_issues: unknown[] | null;
  verify_retried: boolean;
  fundable_credits: number | null;
  exa_cost_usd: number | null;
  llm_tokens: number | null;
  latency_ms: number | null;
  voice_id: string | null;
  voice_provenance: string | null;
};

export interface Storage {
  cacheGet(key: string, source: CacheSource): Promise<unknown | null>;
  cacheSet(key: string, source: CacheSource, payload: unknown, ttlMs: number): Promise<void>;
  log(row: LogRow): Promise<void>;
  /** Most recent storage failure this request, for surfacing as a warning. */
  readonly lastError: string | null;
}

class NoopStorage implements Storage {
  readonly lastError = null;
  async cacheGet() {
    return null;
  }
  async cacheSet() {}
  async log() {}
}

class NeonStorage implements Storage {
  lastError: string | null = null;

  constructor(private readonly conn: string) {}

  /**
   * A fresh client per operation, because the abort signal has to be fresh too.
   * `AbortSignal.timeout` starts counting when it is created, so a signal built
   * once in the constructor would already be half-spent by the time `log()` runs
   * at the end of a 13-second request. HTTP mode holds no connection, so this
   * costs a closure.
   */
  private sql() {
    return neon(this.conn, {
      fetchOptions: { signal: AbortSignal.timeout(LEG_TIMEOUT_MS.storage) },
    });
  }

  private note(op: string, err: unknown) {
    this.lastError = `${op}: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`[storage] ${this.lastError}`);
  }

  async cacheGet(key: string, source: CacheSource): Promise<unknown | null> {
    try {
      const sql = this.sql();
      // Tagged template: `${key}` is a bind parameter, never interpolated text.
      const rows = await sql`
        select payload
          from public.pz_cache
         where cache_key = ${key}
           and source = ${source}
           and expires_at > now()
         limit 1
      `;
      return rows[0]?.payload ?? null;
    } catch (err) {
      this.note("cacheGet", err);
      return null;
    }
  }

  async cacheSet(key: string, source: CacheSource, payload: unknown, ttlMs: number): Promise<void> {
    try {
      const sql = this.sql();
      const now = new Date();
      // TTL stays in application code, per the migration's note on expires_at.
      const expiresAt = new Date(now.getTime() + ttlMs);
      // jsonb needs the string form plus an explicit cast — handing the driver a
      // JS object binds it as a Postgres array and the insert fails on type.
      await sql`
        insert into public.pz_cache (cache_key, source, payload, fetched_at, expires_at)
        values (${key}, ${source}, ${JSON.stringify(payload)}::jsonb, ${now.toISOString()}, ${expiresAt.toISOString()})
        on conflict (cache_key, source) do update
           set payload    = excluded.payload,
               fetched_at = excluded.fetched_at,
               expires_at = excluded.expires_at
      `;
    } catch (err) {
      this.note("cacheSet", err);
    }
  }

  async log(row: LogRow): Promise<void> {
    try {
      const sql = this.sql();
      // The column list is written out rather than derived from Object.keys(row):
      // a reordered or renamed field in LogRow should fail to compile here, not
      // silently write `subject` into `body`. "trigger" stays quoted to match
      // the migration.
      await sql.query(
        `insert into public.pz_log (
           api_key_hash, "trigger", channel,
           person_email, person_linkedin, person_name,
           sender_context, max_facts, template_provided,
           company_id, company_name, company_domain, person_id,
           status, confidence, angle, subject, body,
           evidence, warnings, verify_issues, verify_retried,
           fundable_credits, exa_cost_usd, llm_tokens, latency_ms,
           voice_id, voice_provenance
         ) values (
           $1, $2, $3,
           $4, $5, $6,
           $7, $8, $9,
           $10, $11, $12, $13,
           $14, $15, $16, $17, $18,
           $19::jsonb, $20::jsonb, $21::jsonb, $22,
           $23, $24, $25, $26,
           $27, $28
         )`,
        [
          row.api_key_hash, row.trigger, row.channel,
          row.person_email, row.person_linkedin, row.person_name,
          row.sender_context, row.max_facts, row.template_provided,
          row.company_id, row.company_name, row.company_domain, row.person_id,
          row.status, row.confidence, row.angle, row.subject, row.body,
          JSON.stringify(row.evidence), JSON.stringify(row.warnings),
          row.verify_issues === null ? null : JSON.stringify(row.verify_issues),
          row.verify_retried,
          row.fundable_credits, row.exa_cost_usd, row.llm_tokens, row.latency_ms,
          row.voice_id, row.voice_provenance,
        ]
      );
    } catch (err) {
      this.note("log", err);
    }
  }
}

/** Fundable data changes slowly; recent posts do not. Split TTLs per spec §2. */
export const CACHE_TTL_MS: Record<CacheSource, number> = {
  fundable: 30 * 24 * 60 * 60 * 1000,
  exa: 3 * 24 * 60 * 60 * 1000,
};

/** Per-request instance so `lastError` cannot leak across requests. */
export function getStorage(): Storage {
  const conn = optionalEnv("DATABASE_URL");
  if (!conn) return new NoopStorage();
  return new NeonStorage(conn);
}
