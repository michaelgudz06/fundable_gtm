/**
 * v1 auth: static bearer keys, Fundable-internal (spec §1.3).
 *
 * PERSONALIZE_API_KEY holds one or more keys, comma-separated — one per caller
 * (Michael, Jacob), so a key can be revoked without rotating everyone. Fails
 * CLOSED: if the var is unset the endpoint returns 503 rather than running
 * open. Comparison is constant-time over sha256 digests so key length never
 * leaks through timing.
 *
 * The rate limit is two layers, per key:
 *   1. Durable: count this key's pz_log rows in the last hour (Neon). Survives
 *      redeploys and spans lambda instances — this is the layer that actually
 *      protects spend. It counts handled requests, so a burst can overshoot by
 *      at most the in-flight concurrency.
 *   2. In-memory sliding window: per-instance, resets on redeploy. Catches
 *      what the durable layer can't see — requests that never reach record()
 *      (errors), and everything when the DB is unreachable (fail-open there,
 *      because storage being down must not take the API with it).
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { optionalEnv } from "@fundable/shared";

import { getStorage } from "./storage";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type AuthResult =
  | { ok: true; keyHash: string }
  | { ok: false; status: 401 | 503; message: string };

export function checkAuth(req: Request): AuthResult {
  const configured = (optionalEnv("PERSONALIZE_API_KEY") ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (!configured.length) {
    return {
      ok: false,
      status: 503,
      message: "PERSONALIZE_API_KEY is not configured on the server.",
    };
  }

  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match || !match[1]) {
    return { ok: false, status: 401, message: "Missing bearer token." };
  }

  // Every configured key is compared — no early exit — so which key matched
  // (or how many keys exist) never shows through timing.
  const presented = createHash("sha256").update(match[1]).digest();
  let matched = false;
  for (const key of configured) {
    const wanted = createHash("sha256").update(key).digest();
    if (timingSafeEqual(presented, wanted)) matched = true;
  }
  if (!matched) {
    return { ok: false, status: 401, message: "Invalid bearer token." };
  }

  return { ok: true, keyHash: sha256(match[1]) };
}

// Survives dev hot-reload: module state is reset on recompile, globalThis is not.
const WINDOWS: Map<string, number[]> = ((globalThis as Record<string, unknown>).__pzRate ??=
  new Map()) as Map<string, number[]>;

const HOUR_MS = 60 * 60 * 1000;

export type RateResult = { ok: true } | { ok: false; retryAfterS: number };

export async function checkRateLimit(keyHash: string): Promise<RateResult> {
  const limit = Number(optionalEnv("PERSONALIZE_RATE_LIMIT_PER_HOUR") ?? 60);
  if (!Number.isFinite(limit) || limit <= 0) return { ok: true };

  const now = Date.now();

  // Layer 1: durable, cross-instance. Null (no DB, query failed) falls through
  // to layer 2 — the request must not fail because telemetry is unreachable.
  const durable = await getStorage().countLogSince(keyHash, now - HOUR_MS);
  if (durable && durable.n >= limit) {
    return { ok: false, retryAfterS: Math.max(1, Math.ceil((durable.oldestMs + HOUR_MS - now) / 1000)) };
  }

  // Layer 2: in-memory, per-instance. Counts every gated attempt, including
  // ones the log never sees.
  const hits = (WINDOWS.get(keyHash) ?? []).filter((t) => now - t < HOUR_MS);

  if (hits.length >= limit) {
    const oldest = hits[0] ?? now;
    WINDOWS.set(keyHash, hits);
    return { ok: false, retryAfterS: Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000)) };
  }

  hits.push(now);
  WINDOWS.set(keyHash, hits);
  return { ok: true };
}

/** The plain JSON error envelope used by every route without version headers. */
export function jsonError(status: number, code: string, message: string, details?: unknown): Response {
  return Response.json(
    { error: { code, message, ...(details !== undefined ? { details } : {}) } },
    { status }
  );
}

/**
 * Auth + rate limit in one step — the preamble every route runs before reading
 * the body. On failure the caller returns `response` as-is.
 */
export async function gateRequest(
  req: Request
): Promise<{ ok: true; keyHash: string } | { ok: false; response: Response }> {
  const auth = checkAuth(req);
  if (!auth.ok) {
    return {
      ok: false,
      response: jsonError(auth.status, auth.status === 401 ? "UNAUTHORIZED" : "NOT_CONFIGURED", auth.message),
    };
  }
  const rate = await checkRateLimit(auth.keyHash);
  if (!rate.ok) {
    return {
      ok: false,
      response: Response.json(
        { error: { code: "RATE_LIMITED", message: `Over the hourly limit. Retry in ${rate.retryAfterS}s.` } },
        { status: 429, headers: { "Retry-After": String(rate.retryAfterS) } }
      ),
    };
  }
  return { ok: true, keyHash: auth.keyHash };
}
