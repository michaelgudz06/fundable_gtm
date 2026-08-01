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

/**
 * A queued email awaiting a human decision.
 *
 * The status machine is the gate: a sender may only ever read `approved`, so a
 * draft nobody reviewed is unreachable to it. "Forgot to review" fails closed as
 * an empty result rather than as an unreviewed email arriving somewhere.
 */
export type DraftStatus = "pending_review" | "approved" | "rejected" | "sent";

export type DraftRow = {
  id: string;
  created_at: string;
  recipient_email: string;
  recipient_name: string | null;
  company_name: string | null;
  message_type: string;
  icp: string;
  icp_use_cases: unknown[];
  body_source: string | null;
  use_case_type: string | null;
  agreement: string | null;
  body: string;
  edited_body: string | null;
  status: DraftStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  versions: Record<string, unknown>;
};

export type NewDraft = Omit<DraftRow, "id" | "created_at" | "status" | "edited_body" | "reviewed_by" | "reviewed_at" | "review_note"> & {
  api_key_hash: string | null;
};

export interface Storage {
  cacheGet(key: string, source: CacheSource): Promise<unknown | null>;
  cacheSet(key: string, source: CacheSource, payload: unknown, ttlMs: number): Promise<void>;
  log(row: LogRow): Promise<void>;
  draftCreate(row: NewDraft): Promise<string | null>;
  draftList(status: DraftStatus, limit: number): Promise<DraftRow[]>;
  draftDecide(
    id: string,
    decision: { status: DraftStatus; reviewed_by?: string; review_note?: string; edited_body?: string }
  ): Promise<DraftRow | null>;
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
  async draftCreate() {
    return null;
  }
  async draftList() {
    return [];
  }
  async draftDecide() {
    return null;
  }
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

  async draftCreate(row: NewDraft): Promise<string | null> {
    try {
      const res = await fetch(`${this.url}/rest/v1/pz_draft`, {
        method: "POST",
        headers: this.headers({ Prefer: "return=representation" }),
        body: JSON.stringify(row),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 150)}`);
      const rows = (await res.json()) as { id: string }[];
      return rows[0]?.id ?? null;
    } catch (err) {
      this.note("draftCreate", err);
      return null;
    }
  }

  async draftList(status: DraftStatus, limit: number): Promise<DraftRow[]> {
    try {
      const qs = new URLSearchParams({
        status: `eq.${status}`,
        order: "created_at.desc",
        limit: String(limit),
        select: "*",
      });
      const res = await fetch(`${this.url}/rest/v1/pz_draft?${qs}`, { headers: this.headers() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as DraftRow[];
    } catch (err) {
      this.note("draftList", err);
      return [];
    }
  }

  async draftDecide(
    id: string,
    decision: { status: DraftStatus; reviewed_by?: string; review_note?: string; edited_body?: string }
  ): Promise<DraftRow | null> {
    try {
      const patch: Record<string, unknown> = {
        status: decision.status,
        reviewed_at: new Date().toISOString(),
        ...(decision.reviewed_by ? { reviewed_by: decision.reviewed_by } : {}),
        ...(decision.review_note ? { review_note: decision.review_note } : {}),
        ...(decision.edited_body ? { edited_body: decision.edited_body } : {}),
        ...(decision.status === "sent" ? { sent_at: new Date().toISOString() } : {}),
      };
      // Guarded transitions: a row can only be decided while it is still
      // pending, and only marked sent once approved. Without this, a retry or a
      // race could approve something already rejected.
      const allowedFrom = decision.status === "sent" ? "approved" : "pending_review";
      const qs = new URLSearchParams({ id: `eq.${id}`, status: `eq.${allowedFrom}` });
      const res = await fetch(`${this.url}/rest/v1/pz_draft?${qs}`, {
        method: "PATCH",
        headers: this.headers({ Prefer: "return=representation" }),
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 150)}`);
      const rows = (await res.json()) as DraftRow[];
      return rows[0] ?? null;
    } catch (err) {
      this.note("draftDecide", err);
      return null;
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
