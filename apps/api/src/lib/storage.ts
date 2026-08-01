/**
 * Storage behind a small interface so it stays swappable (spec §1.6).
 *
 * Two implementations: Supabase over plain PostgREST (no SDK dependency for two
 * tables), and a no-op used when SUPABASE_URL is absent. Storage must never
 * break a request — a personalization that worked is not made a failure by a
 * logging hiccup — so every method catches, records the problem, and returns.
 * The orchestrator surfaces `lastError` as a response warning instead.
 */

import { optionalEnv } from "@fundable/shared";

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

class SupabaseStorage implements Storage {
  lastError: string | null = null;

  constructor(
    private readonly url: string,
    private readonly secret: string
  ) {}

  private headers(extra: Record<string, string> = {}) {
    return {
      apikey: this.secret,
      Authorization: `Bearer ${this.secret}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  private note(op: string, err: unknown) {
    this.lastError = `${op}: ${err instanceof Error ? err.message : String(err)}`;
    console.warn(`[storage] ${this.lastError}`);
  }

  async cacheGet(key: string, source: CacheSource): Promise<unknown | null> {
    try {
      const qs = new URLSearchParams({
        cache_key: `eq.${key}`,
        source: `eq.${source}`,
        expires_at: `gt.${new Date().toISOString()}`,
        select: "payload",
        limit: "1",
      });
      const res = await fetch(`${this.url}/rest/v1/pz_cache?${qs}`, { headers: this.headers() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = (await res.json()) as { payload: unknown }[];
      return rows[0]?.payload ?? null;
    } catch (err) {
      this.note("cacheGet", err);
      return null;
    }
  }

  async cacheSet(key: string, source: CacheSource, payload: unknown, ttlMs: number): Promise<void> {
    try {
      const res = await fetch(
        // Upsert on the (cache_key, source) unique constraint.
        `${this.url}/rest/v1/pz_cache?on_conflict=cache_key,source`,
        {
          method: "POST",
          headers: this.headers({ Prefer: "resolution=merge-duplicates" }),
          body: JSON.stringify({
            cache_key: key,
            source,
            payload,
            fetched_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + ttlMs).toISOString(),
          }),
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 150)}`);
    } catch (err) {
      this.note("cacheSet", err);
    }
  }

  async log(row: LogRow): Promise<void> {
    try {
      const res = await fetch(`${this.url}/rest/v1/pz_log`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(row),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 150)}`);
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
  const url = optionalEnv("SUPABASE_URL");
  const secret = optionalEnv("SUPABASE_SECRET_KEY");
  if (!url || !secret) return new NoopStorage();
  return new SupabaseStorage(url.replace(/\/$/, ""), secret);
}
