/**
 * POST /api/personalize — PRD §4. Sync-only in v1 (spec §1.5); the streaming
 * variant for the demo UI is Milestone 2.
 *
 * All four triggers are live as of M3. Each has its own evidence policy in
 * pipeline/triggers.ts — notably website-visitor cannot reference the person.
 */

import { FundableError } from "@fundable/shared";

import { checkAuth, checkRateLimit } from "../../../lib/auth";
import { personalize } from "../../../lib/pipeline/personalize";
import { parseRequest } from "../../../lib/pipeline/types";

export const runtime = "nodejs";

function error(status: number, code: string, message: string, details?: unknown) {
  return Response.json(
    { error: { code, message, ...(details !== undefined ? { details } : {}) } },
    { status }
  );
}

export async function POST(req: Request): Promise<Response> {
  const auth = checkAuth(req);
  if (!auth.ok) {
    return error(auth.status, auth.status === 401 ? "UNAUTHORIZED" : "NOT_CONFIGURED", auth.message);
  }

  const rate = checkRateLimit(auth.keyHash);
  if (!rate.ok) {
    return Response.json(
      { error: { code: "RATE_LIMITED", message: `Over the hourly limit. Retry in ${rate.retryAfterS}s.` } },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterS) } }
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return error(400, "INVALID_JSON", "Request body is not valid JSON.");
  }

  const parsed = parseRequest(raw);
  if (!parsed.ok) {
    return error(400, "INVALID_REQUEST", "Request failed validation.", parsed.errors);
  }


  try {
    const response = await personalize(parsed.req, auth.keyHash);
    return Response.json(response);
  } catch (err) {
    if (err instanceof FundableError) {
      // Upstream trouble is not the caller's fault; say whose it is.
      return error(502, "UPSTREAM_FUNDABLE", `${err.message} (Fundable ${err.status})`);
    }
    console.error("[personalize]", err);
    return error(500, "INTERNAL", err instanceof Error ? err.message : "Unexpected error.");
  }
}
