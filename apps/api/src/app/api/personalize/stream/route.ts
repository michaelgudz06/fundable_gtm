/**
 * POST /api/personalize/stream — the same pipeline as /api/personalize, but the
 * response is NDJSON: one StageEvent per line as the pipeline runs, ending with
 * a `done` event carrying the full PersonalizeResponse (or an `error` event).
 *
 * NDJSON over POST rather than SSE because EventSource cannot POST a body, and
 * the demo consumes it with a fetch reader anyway. Auth, rate limiting, and
 * validation happen BEFORE the stream opens, so those failures are ordinary
 * JSON errors with real status codes; anything after the 200 travels in-band.
 */

import { FundableError } from "@fundable/shared";

import { checkAuth, checkRateLimit } from "../../../../lib/auth";
import { personalize } from "../../../../lib/pipeline/personalize";
import { parseRequest, type StageEvent } from "../../../../lib/pipeline/types";

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


  const encoder = new TextEncoder();
  const started = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: StageEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));

      try {
        const response = await personalize(parsed.req, auth.keyHash, send);
        // The pipeline emits its own `done` narration; the terminal event
        // carries the actual payload the result panel renders.
        send({ t: Date.now() - started, stage: "done", status: "done", response });
      } catch (err) {
        const detail =
          err instanceof FundableError
            ? `${err.message} (Fundable ${err.status})`
            : err instanceof Error
              ? err.message
              : "Unexpected error.";
        send({ t: Date.now() - started, stage: "error", status: "error", detail });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      // Defeat proxy buffering so events render as they happen.
      "X-Accel-Buffering": "no",
    },
  });
}
