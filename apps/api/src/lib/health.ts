/**
 * Dependency health, as a function.
 *
 * Both `/api/health` and the overview page use this. The page originally
 * self-fetched `http://localhost:3111/api/health`, which works locally and
 * breaks the moment the app runs anywhere else — calling the function directly
 * removes the hostname question entirely.
 *
 * Paid upstreams are checked for CONFIGURATION only. A health check that spends
 * credits on every page load is a bug, not a feature.
 *
 * The database follows the same rule now, for a reason that is not about money.
 * The overview page is `force-dynamic` and calls this on every render, so while
 * the probe ran by default the PUBLIC HOME PAGE was a database poller: a crawler
 * hitting `/` was enough to keep a scale-to-zero Neon compute permanently awake.
 * The probe is therefore opt-in — `/api/health?deep=1` — and the default answer
 * describes configuration alone.
 */

import { neon } from "@neondatabase/serverless";
import { LEG_TIMEOUT_MS, optionalEnv } from "@fundable/shared";

export type Dep = {
  name: string;
  configured: boolean;
  /** null = deliberately not probed (costs money, or would wake the database). */
  reachable: boolean | null;
  detail: string;
};

async function checkNeon(deep: boolean): Promise<Dep> {
  const name = "Neon (cache + log)";
  const conn = optionalEnv("DATABASE_URL");

  if (!conn) {
    return {
      name,
      configured: false,
      reachable: null,
      detail: "DATABASE_URL not set — cache and request log no-op",
    };
  }

  if (!deep) {
    return {
      name,
      configured: true,
      reachable: null,
      detail: "DATABASE_URL set (not probed — add ?deep=1 to actually query)",
    };
  }

  try {
    const sql = neon(conn, {
      fetchOptions: { signal: AbortSignal.timeout(LEG_TIMEOUT_MS.storage) },
    });
    // Proves the connection works AND both tables exist, without reading a row
    // of anyone's data.
    const rows = await sql`
      select to_regclass('public.pz_cache') is not null
         and to_regclass('public.pz_log')   is not null as ready
    `;
    const ready = (rows[0] as { ready: boolean } | undefined)?.ready === true;
    return {
      name,
      configured: true,
      reachable: ready,
      detail: ready ? "pz_cache + pz_log reachable" : "connected, but a table is missing — apply db/migrations/",
    };
  } catch (err) {
    // Deliberately not echoed to the caller: this endpoint is unauthenticated,
    // and driver errors carry the database host.
    console.warn(`[health] Neon probe failed: ${(err as Error).message}`);
    return {
      name,
      configured: true,
      reachable: false,
      detail: "unreachable — check DATABASE_URL and that db/migrations are applied",
    };
  }
}

export async function checkHealth(opts: { deep?: boolean } = {}): Promise<{ ok: boolean; deps: Dep[] }> {
  const deps: Dep[] = [
    {
      name: "Fundable REST",
      configured: !!optionalEnv("FUNDABLE_API_KEY"),
      reachable: null,
      detail: optionalEnv("FUNDABLE_API_KEY")
        ? "key present (not probed — every call costs credits)"
        : "FUNDABLE_API_KEY missing — resolution and enrichment will fail",
    },
    {
      name: "Exa",
      configured: !!optionalEnv("EXA_API_KEY"),
      reachable: null,
      detail: optionalEnv("EXA_API_KEY")
        ? "key present (not probed — $0.007 per search)"
        : "EXA_API_KEY missing — recency + repeat-founder tie unavailable",
    },
    {
      name: "OpenRouter (DeepSeek V4)",
      configured: !!optionalEnv("OPENROUTER_API_KEY"),
      reachable: null,
      detail: optionalEnv("OPENROUTER_API_KEY")
        ? "key present (not probed — tokens cost money)"
        : "OPENROUTER_API_KEY missing — angle selection and writing will fail",
    },
    await checkNeon(opts.deep === true),
    {
      name: "This API's own auth",
      configured: !!optionalEnv("PERSONALIZE_API_KEY"),
      reachable: null,
      detail: optionalEnv("PERSONALIZE_API_KEY")
        ? "bearer key set — endpoints are protected"
        : "PERSONALIZE_API_KEY missing — endpoints fail closed with 503",
    },
  ];

  return { ok: !deps.some((d) => !d.configured || d.reachable === false), deps };
}
