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
 */

import { optionalEnv } from "@fundable/shared";

export type Dep = {
  name: string;
  configured: boolean;
  /** null = deliberately not probed, because probing costs money. */
  reachable: boolean | null;
  detail: string;
};

async function checkSupabase(): Promise<Dep> {
  const name = "Supabase (cache + log)";
  const url = optionalEnv("SUPABASE_URL");
  const secret = optionalEnv("SUPABASE_SECRET_KEY");

  if (!url || !secret) {
    return {
      name,
      configured: false,
      reachable: null,
      detail: "SUPABASE_URL or SUPABASE_SECRET_KEY not set — cache and request log no-op",
    };
  }

  try {
    // Zero-row select: proves the table exists and RLS admits the secret key,
    // without reading anyone's data.
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/pz_log?select=id&limit=0`, {
      headers: { apikey: secret, Authorization: `Bearer ${secret}` },
      cache: "no-store",
    });
    return {
      name,
      configured: true,
      reachable: res.ok,
      detail: res.ok ? "pz_cache + pz_log reachable" : `HTTP ${res.status} — are the migrations applied?`,
    };
  } catch (err) {
    return { name, configured: true, reachable: false, detail: (err as Error).message.slice(0, 120) };
  }
}

export async function checkHealth(): Promise<{ ok: boolean; deps: Dep[] }> {
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
    await checkSupabase(),
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
