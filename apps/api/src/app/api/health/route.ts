/**
 * GET /api/health — unauthenticated, deliberately.
 *
 * Reports whether each dependency is configured and, for Supabase alone, whether
 * it answers. It never reveals a key or the Supabase project ref, and never makes
 * a paid call, so it is safe to leave open.
 *
 * The logic lives in lib/health.ts because the overview page needs it too, and a
 * page self-fetching its own API over HTTP breaks as soon as the hostname is not
 * localhost.
 */

import { checkHealth } from "../../../lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { ok, deps } = await checkHealth();
  return Response.json({ ok, deps, checked_at: new Date().toISOString() });
}
