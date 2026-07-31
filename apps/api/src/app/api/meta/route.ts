/**
 * GET /api/meta — what the demo's request builder needs to render itself:
 * the named sender-context blocks on disk and the voice provenance (so the UI
 * can show the placeholder-voice warning before a single run happens).
 *
 * Auth'd with the same bearer key: it doubles as the demo's "is this key right"
 * check on entry, and the sender-context names are internal config.
 */

import { provenanceWarning } from "@fundable/shared";

import { checkAuth } from "../../../lib/auth";
import { getVoice, senderContextIds } from "../../../lib/config-registry";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const auth = checkAuth(req);
  if (!auth.ok) {
    return Response.json(
      { error: { code: auth.status === 401 ? "UNAUTHORIZED" : "NOT_CONFIGURED", message: auth.message } },
      { status: auth.status }
    );
  }

  const voice = getVoice("jacob");
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
