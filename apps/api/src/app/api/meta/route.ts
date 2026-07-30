/**
 * GET /api/meta — what the demo's request builder needs to render itself:
 * the named sender-context blocks on disk and the voice provenance (so the UI
 * can show the placeholder-voice warning before a single run happens).
 *
 * Auth'd with the same bearer key: it doubles as the demo's "is this key right"
 * check on entry, and the sender-context names are internal config.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadVoice, provenanceWarning } from "@fundable/shared";

import { checkAuth } from "../../../lib/auth";

export const runtime = "nodejs";

function senderContextIds(): string[] {
  // Same root-walk as the pipeline's sender loader: cwd is apps/api under
  // `next dev`, the repo root in other harnesses.
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    try {
      const candidate = join(dir, "config", "sender");
      const files = readdirSync(candidate).filter((f) => f.endsWith(".json"));
      if (files.length) {
        // Validate each parses; a broken block should not appear pickable.
        return files
          .filter((f) => {
            try {
              JSON.parse(readFileSync(join(candidate, f), "utf8"));
              return true;
            } catch {
              return false;
            }
          })
          .map((f) => f.replace(/\.json$/, ""))
          .sort();
      }
    } catch {
      /* keep walking */
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return [];
}

export async function GET(req: Request): Promise<Response> {
  const auth = checkAuth(req);
  if (!auth.ok) {
    return Response.json(
      { error: { code: auth.status === 401 ? "UNAUTHORIZED" : "NOT_CONFIGURED", message: auth.message } },
      { status: auth.status }
    );
  }

  const voice = loadVoice("jacob");
  return Response.json({
    sender_contexts: senderContextIds(),
    voice: {
      id: voice.id,
      provenance: voice.provenance,
      warning: provenanceWarning(voice),
    },
    triggers_implemented: ["post-raise", "sign-up", "website-visitor", "cold"],
  });
}
