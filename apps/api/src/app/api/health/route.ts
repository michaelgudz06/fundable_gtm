/**
 * GET /api/health — unauthenticated, deliberately.
 *
 * Reports whether each dependency is configured. It never reveals a key, a host,
 * or a driver error, and never makes a paid call, so it is safe to leave open.
 *
 * `?deep=1` additionally queries the database. That is opt-in because the
 * overview page calls checkHealth() on every render: probing by default made the
 * public home page a poller against a scale-to-zero compute. Monitors that want
 * a real answer should ask for one.
 *
 * The logic lives in lib/health.ts because the overview page needs it too, and a
 * page self-fetching its own API over HTTP breaks as soon as the hostname is not
 * localhost.
 */

import { checkHealth } from "../../../lib/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request): Promise<Response> {
  const deep = new URL(req.url).searchParams.get("deep") === "1";
  const { ok, deps } = await checkHealth({ deep });
  return Response.json({ ok, deps, deep, checked_at: new Date().toISOString() });
}
