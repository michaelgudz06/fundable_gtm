/**
 * Find a LinkedIn profile from an email, via the n8n `Resolve LinkedIn Profile`
 * workflow (`bpx0okgj6Tslhwcb`).
 *
 * The cascade lives in n8n, not here: Quick Enrich reverse-email → AI Ark people
 * search (name + company-domain checked) → Apollo people/match → Exa search
 * judged by Gemini. Four vendors, and re-implementing that in this repo would
 * mean four more credentials, four more clients, and four more things to keep in
 * sync with a workflow someone else edits. We call it and read the verdict.
 *
 * Two rules make this safe to run before classification:
 *
 *   1. `linkedinApproved` is the ONLY field that authorises use of the URL. Each
 *      branch of the workflow sets it deliberately — the Gemini judge is told
 *      "better to reject an uncertain result than connect with the wrong person"
 *      — so a URL arriving with `approved: false` is a rejected candidate, not a
 *      weak answer. Reading `linkedinUrl` alone would quietly undo that.
 *
 *   2. Everything here is FAIL-SOFT. No webhook configured, a timeout, a 500, a
 *      malformed body: all return null, and the caller classifies from email
 *      alone — which is exactly what it does today. A lead that cannot be
 *      resolved must still get an email; it must never get someone else's.
 *
 * Wrong-person risk is why this reads as conservative. A misresolved profile
 * produces a confident, personalized, wrong email — worse than sending nothing,
 * and the failure mode ID-003 already exists to prevent.
 */

import { fetchWithDeadline, LEG_TIMEOUT_MS, optionalEnv } from "@fundable/shared";

import { getStorage } from "../storage";

/** Same TTL as `personCached` — a person's profile URL is a stable fact. */
export const RESOLVE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type ResolvedLinkedIn = {
  linkedin_url: string;
  /** quick_enrich | ai_ark | apollo | exa */
  source: string;
  confidence: string;
  /** The workflow resolves these on the way past. Titles are the single biggest
   *  lever on classification accuracy (13% -> 36% core recall when present), so
   *  dropping them and re-fetching the same fact would be the expensive mistake. */
  title?: string;
  company?: string;
};

type WorkflowOutput = {
  linkedinUrl?: unknown;
  linkedinApproved?: unknown;
  linkedinConfidence?: unknown;
  linkedinSource?: unknown;
  linkedinReason?: unknown;
  quickEnrichTitle?: unknown;
  quickEnrichCompany?: unknown;
  aiArkTitle?: unknown;
  aiArkCompany?: unknown;
  apolloTitle?: unknown;
  apolloCompany?: unknown;
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * The workflow reports the winning source's title/company under that source's
 * own key and blanks the others, so the first non-empty pair is the answer.
 */
function harvest(out: WorkflowOutput): { title?: string; company?: string } {
  const pairs: Array<[string, string]> = [
    [str(out.quickEnrichTitle), str(out.quickEnrichCompany)],
    [str(out.aiArkTitle), str(out.aiArkCompany)],
    [str(out.apolloTitle), str(out.apolloCompany)],
  ];
  for (const [title, company] of pairs) {
    if (title || company) return { title: title || undefined, company: company || undefined };
  }
  return {};
}

/**
 * Why the result carries a `state`: null used to mean four different things —
 * cascade missed, n8n unconfigured, n8n down, judge rejected — and a caller
 * reading the response could not tell "this person isn't findable" from "the
 * integration is broken". The URL is still null in all of them; the state is
 * what makes the difference loud (it lands on X-Linkedin-Source).
 */
export type ResolveState = "found" | "miss" | "unconfigured" | "error";

/**
 * @param location the PERSON's location ("Vancouver, BC"), not a sales
 * territory. The workflow's Gemini judge uses it to tell two people with the
 * same name apart — its stated rule 2 — so omitting it makes a rejection more
 * likely, never a wrong match more likely.
 */
export async function resolveLinkedIn(args: {
  email: string;
  firstName: string;
  lastName: string;
  location?: string | undefined;
  deadlineAt?: number | undefined;
}): Promise<{ resolved: ResolvedLinkedIn | null; state: ResolveState }> {
  const url = optionalEnv("N8N_LINKEDIN_WEBHOOK_URL");
  // Unconfigured is a supported state, not an error: both live flows (website
  // visitors, n8n sign-ups) already arrive carrying a LinkedIn URL.
  if (!url) return { resolved: null, state: "unconfigured" };

  const storage = getStorage();
  // Keyed on the name too: the same mailbox asserted under a different name is a
  // different question, and the workflow matches on name.
  const key = `linkedin-resolve:${args.email.toLowerCase()}:${`${args.firstName} ${args.lastName}`.trim().toLowerCase()}`;
  const hit = (await storage.cacheGet(key, "fundable")) as { resolved: ResolvedLinkedIn | null } | null;
  if (hit && typeof hit === "object" && "resolved" in hit) {
    return { resolved: hit.resolved, state: hit.resolved ? "found" : "miss" };
  }

  let resolved: ResolvedLinkedIn | null = null;
  let state: ResolveState = "miss";
  try {
    const token = optionalEnv("N8N_LINKEDIN_WEBHOOK_TOKEN");
    const res = await fetchWithDeadline(
      url,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { "x-api-key": token } : {}),
        },
        body: JSON.stringify({
          userEmail: args.email,
          firstName: args.firstName,
          lastName: args.lastName,
          userLocation: args.location ?? "",
        }),
      },
      { leg: "n8n/resolve-linkedin", cap: LEG_TIMEOUT_MS.n8n, budget: { deadlineAt: args.deadlineAt } }
    );
    if (res.ok) {
      const raw: unknown = await res.json();
      // "Respond when last node finishes" returns the item; some n8n response
      // modes wrap it in an array. Accept both rather than pin the caller to one.
      const out = (Array.isArray(raw) ? raw[0] : raw) as WorkflowOutput | undefined;
      const link = str(out?.linkedinUrl);
      if (out && out.linkedinApproved === true && link) {
        resolved = {
          linkedin_url: link,
          source: str(out.linkedinSource) || "unknown",
          confidence: str(out.linkedinConfidence) || "unknown",
          ...harvest(out),
        };
        state = "found";
      }
    } else {
      // n8n answered but not with a verdict — a 4xx/5xx is the integration
      // misbehaving, not this person being unfindable. Not cached.
      return { resolved: null, state: "error" };
    }
  } catch {
    // Timeout, DNS, unparseable JSON. All mean "no profile today" — never a
    // hard failure, and never a guess. Deliberately not cached: an outage is
    // not an answer about this person.
    return { resolved: null, state: "error" };
  }

  await storage.cacheSet(key, "fundable", { resolved }, RESOLVE_TTL_MS);
  return { resolved, state };
}
