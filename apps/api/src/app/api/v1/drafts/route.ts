/**
 * The review queue.
 *
 *   GET  /api/v1/drafts?status=pending_review   what a human needs to look at
 *   GET  /api/v1/drafts?status=approved         what a sender is allowed to send
 *   POST /api/v1/drafts                         record a decision
 *
 * The gate is the status, not this file. A sender asking for `approved` can
 * never be handed something unreviewed, so forgetting to review shows up as an
 * empty send batch rather than as an unreviewed email in someone's inbox.
 *
 * Transitions are guarded in storage: a draft can only be decided while it is
 * still pending, and only marked `sent` once approved. A retried webhook cannot
 * resurrect a rejected draft.
 */

import { checkAuth } from "../../../../lib/auth";
import { getStorage, type DraftStatus } from "../../../../lib/storage";

export const runtime = "nodejs";

const STATUSES: DraftStatus[] = ["pending_review", "approved", "rejected", "sent"];

function err(status: number, code: string, message: string) {
  return Response.json({ error: { code, message } }, { status });
}

export async function GET(req: Request): Promise<Response> {
  const auth = checkAuth(req);
  if (!auth.ok) return err(auth.status, auth.status === 401 ? "UNAUTHORIZED" : "NOT_CONFIGURED", auth.message);

  const url = new URL(req.url);
  const status = (url.searchParams.get("status") ?? "pending_review") as DraftStatus;
  if (!STATUSES.includes(status)) {
    return err(400, "INVALID_REQUEST", `status must be one of: ${STATUSES.join(", ")}`);
  }
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));

  const drafts = await getStorage().draftList(status, limit);
  return Response.json({
    status,
    count: drafts.length,
    drafts: drafts.map((d) => ({
      id: d.id,
      created_at: d.created_at,
      recipient_email: d.recipient_email,
      recipient_name: d.recipient_name,
      company_name: d.company_name,
      message_type: d.message_type,
      icp: d.icp,
      icp_use_cases: d.icp_use_cases,
      agreement: d.agreement,
      body_source: d.body_source,
      use_case_type: d.use_case_type,
      // What the sender should actually send: the reviewer's edit if there is
      // one, otherwise the machine's copy. `body` stays untouched so edit rate
      // remains measurable.
      send_body: d.edited_body ?? d.body,
      machine_body: d.body,
      edited: d.edited_body !== null,
      status: d.status,
      reviewed_by: d.reviewed_by,
      versions: d.versions,
    })),
  });
}

type Decision = {
  id?: string;
  decision?: "approve" | "reject" | "sent";
  reviewed_by?: string;
  note?: string;
  edited_body?: string;
};

export async function POST(req: Request): Promise<Response> {
  const auth = checkAuth(req);
  if (!auth.ok) return err(auth.status, auth.status === 401 ? "UNAUTHORIZED" : "NOT_CONFIGURED", auth.message);

  let body: Decision;
  try {
    body = (await req.json()) as Decision;
  } catch {
    return err(400, "INVALID_JSON", "Request body is not valid JSON.");
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return err(400, "INVALID_REQUEST", "`id` is required.");

  const map = { approve: "approved", reject: "rejected", sent: "sent" } as const;
  const decision = body.decision && map[body.decision];
  if (!decision) return err(400, "INVALID_REQUEST", "`decision` must be approve, reject or sent.");

  const updated = await getStorage().draftDecide(id, {
    status: decision,
    ...(body.reviewed_by ? { reviewed_by: body.reviewed_by } : {}),
    ...(body.note ? { review_note: body.note } : {}),
    ...(body.edited_body ? { edited_body: body.edited_body } : {}),
  });

  if (!updated) {
    // Either the id is unknown, or the draft is not in a state this transition
    // allows — approving something already rejected, or sending something never
    // approved. Both are the guard working.
    return err(
      409,
      "INVALID_TRANSITION",
      `Draft ${id} could not move to "${decision}". It may not exist, or may already have been decided.`
    );
  }

  return Response.json({
    id: updated.id,
    status: updated.status,
    reviewed_by: updated.reviewed_by,
    send_body: updated.edited_body ?? updated.body,
  });
}
