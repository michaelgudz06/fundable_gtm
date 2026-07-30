/**
 * GET /api/health — unauthenticated, deliberately.
 *
 * It reports whether each dependency is CONFIGURED and, for the two cheap ones,
 * whether it actually answers. It never reveals a key, never reveals the
 * Supabase project ref, and never makes a paid call — so it is safe to leave
 * open and it is what the overview page renders its status column from.
 *
 * "Configured" and "reachable" are reported separately on purpose: a missing key
 * and a broken upstream are different problems with different fixes.
 */

import { optionalEnv } from "@fundable/shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Dep = {
  name: string;
  configured: boolean;
  reachable: boolean | null; // null = not probed (would cost money)
  detail: string;
};

async function checkSupabase(): Promise<Dep> {
  const url = optionalEnv("SUPABASE_URL");
  const secret = optionalEnv("SUPABASE_SECRET_KEY");
  if (!url || !secret) {
    return {
      name: "Supabase (cache + log)",
      configured: false,
      reachable: null,
      detail: "SUPABASE_URL or SUPABASE_SECRET_KEY not set — cache and request log no-op",
    };
  }
  try {
    // Zero-row select: confirms the table exists and RLS lets the secret key in.
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/pz_log?select=id&limit=0`, {
      headers: { apikey: secret, Authorization: `Bearer ${secret}` },
      cache: "no-store",
    });
    return {
      name: "Supabase (cache + log)",
      configured: true,
      reachable: res.ok,
      detail: res.ok ? "pz_cache + pz_log reachable" : `HTTP ${res.status} — are the migrations applied?`,
    };
  } catch (err) {
    return {
      name: "Supabase (cache + log)",
      configured: true,
      reachable: false,
      detail: (err as Error).message.slice(0, 120),
    };
  }
}

export async function GET(): Promise<Response> {
  const deps: Dep[] = [];

  // Fundable + Exa + OpenRouter: configured-only. Probing them costs credits or
  // cash on every page load, and a health check that spends money is a bug.
  deps.push({
    name: "Fundable REST",
    configured: !!optionalEnv("FUNDABLE_API_KEY"),
    reachable: null,
    detail: optionalEnv("FUNDABLE_API_KEY")
      ? "key present (not probed — every call costs credits)"
      : "FUNDABLE_API_KEY missing — resolution and enrichment will fail",
  });

  deps.push({
    name: "Exa",
    configured: !!optionalEnv("EXA_API_KEY"),
    reachable: null,
    detail: optionalEnv("EXA_API_KEY")
      ? "key present (not probed — $0.007 per search)"
      : "EXA_API_KEY missing — recency + repeat-founder tie unavailable",
  });

  deps.push({
    name: "OpenRouter (DeepSeek V4)",
    configured: !!optionalEnv("OPENROUTER_API_KEY"),
    reachable: null,
    detail: optionalEnv("OPENROUTER_API_KEY")
      ? "key present (not probed — tokens cost money)"
      : "OPENROUTER_API_KEY missing — angle selection and writing will fail",
  });

  deps.push(await checkSupabase());

  deps.push({
    name: "This API's own auth",
    configured: !!optionalEnv("PERSONALIZE_API_KEY"),
    reachable: null,
    detail: optionalEnv("PERSONALIZE_API_KEY")
      ? "bearer key set — endpoints are protected"
      : "PERSONALIZE_API_KEY missing — endpoints fail closed with 503",
  });

  const blocking = deps.filter((d) => !d.configured || d.reachable === false);
  return Response.json({
    ok: blocking.length === 0,
    deps,
    // Never the ref itself: the overview page only needs to know it is wired.
    checked_at: new Date().toISOString(),
  });
}
