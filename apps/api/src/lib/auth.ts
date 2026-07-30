/**
 * v1 auth: one static bearer key, Fundable-internal (spec §1.3).
 *
 * Fails CLOSED: if PERSONALIZE_API_KEY is unset the endpoint returns 503 rather
 * than running open. Comparison is constant-time over sha256 digests so key
 * length never leaks through timing.
 *
 * The rate limit is an in-memory sliding window — honest about its limits: it
 * resets on redeploy and is per-instance. Fine for a single-instance internal
 * tool; the durable per-key version (counting pz_log rows) is M5.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { optionalEnv } from "@fundable/shared";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type AuthResult =
  | { ok: true; keyHash: string }
  | { ok: false; status: 401 | 503; message: string };

export function checkAuth(req: Request): AuthResult {
  const expected = optionalEnv("PERSONALIZE_API_KEY");
  if (!expected) {
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

  const presented = createHash("sha256").update(match[1]).digest();
  const wanted = createHash("sha256").update(expected).digest();
  if (!timingSafeEqual(presented, wanted)) {
    return { ok: false, status: 401, message: "Invalid bearer token." };
  }

  return { ok: true, keyHash: sha256(match[1]) };
}

// Survives dev hot-reload: module state is reset on recompile, globalThis is not.
const WINDOWS: Map<string, number[]> = ((globalThis as Record<string, unknown>).__pzRate ??=
  new Map()) as Map<string, number[]>;

const HOUR_MS = 60 * 60 * 1000;

export type RateResult = { ok: true } | { ok: false; retryAfterS: number };

export function checkRateLimit(keyHash: string): RateResult {
  const limit = Number(optionalEnv("PERSONALIZE_RATE_LIMIT_PER_HOUR") ?? 60);
  if (!Number.isFinite(limit) || limit <= 0) return { ok: true };

  const now = Date.now();
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
