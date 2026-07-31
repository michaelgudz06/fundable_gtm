/**
 * POST /api/classify — ICP classification as a service.
 *
 * The point (per Jacob): one classifier callable from every surface — website
 * sign-up, website visitor, cold outbound — so the same person gets the same
 * ICP everywhere, instead of each surface reimplementing the prompt and
 * drifting.
 *
 * Two-tier, chosen automatically by what is known:
 *   title present  -> titled path (precise; role-gated taxonomy)
 *   email only     -> Exa company research + conservative email-only prompt
 *   freemail/blank -> refuses rather than guessing
 *
 * When only email + LinkedIn are known (the stated constraint), pass the
 * LinkedIn URL: the title is resolved from Fundable's people index first, which
 * upgrades the lead onto the titled path.
 */

import {
  ClassificationError,
  classifyIcp,
  newExaLedger,
  newLedger,
  personByLinkedIn,
  FundableError,
} from "@fundable/shared";

import { checkAuth, checkRateLimit } from "../../../lib/auth";

export const runtime = "nodejs";

function error(status: number, code: string, message: string, details?: unknown) {
  return Response.json(
    { error: { code, message, ...(details !== undefined ? { details } : {}) } },
    { status }
  );
}

type Body = {
  email?: string;
  linkedin?: string;
  /** Caller-known title/company skip the LinkedIn resolution entirely. */
  title?: string;
  company?: string;
};

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

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return error(400, "INVALID_JSON", "Request body is not valid JSON.");
  }

  const email = typeof body.email === "string" ? body.email.trim() : undefined;
  const linkedin = typeof body.linkedin === "string" ? body.linkedin.trim() : undefined;
  let title = typeof body.title === "string" ? body.title.trim() : undefined;
  let company = typeof body.company === "string" ? body.company.trim() : undefined;

  if (!email && !linkedin && !title) {
    return error(400, "INVALID_REQUEST", "Need at least one of: email, linkedin, title.");
  }

  const started = Date.now();
  const fundable = newLedger();
  const exa = newExaLedger();
  const warnings: string[] = [];

  // LinkedIn -> title upgrade. This is what makes "email + linkedin only" land
  // on the precise path instead of the conservative one.
  if (!title && linkedin) {
    try {
      const { person, warnings: w } = await personByLinkedIn(linkedin, fundable);
      warnings.push(...w);
      if (person?.title) {
        title = person.title;
        company = company ?? person.current_company?.name ?? undefined;
        warnings.push(`Title resolved from LinkedIn via Fundable: "${person.title}".`);
      } else if (person) {
        warnings.push("LinkedIn resolved to a person but no title on record; using the email-only path.");
      } else {
        warnings.push("LinkedIn URL did not resolve in Fundable; using the email-only path.");
      }
    } catch (err) {
      if (err instanceof FundableError) {
        warnings.push(`LinkedIn resolution failed (${err.message}); using the email-only path.`);
      } else {
        throw err;
      }
    }
  }

  let result;
  try {
    result = await classifyIcp({ email, title, company }, exa);
  } catch (err) {
    // Infrastructure failure is a 502 the caller can retry — never a 200 with
    // a confident "Not Core ICP" they would persist (QA finding).
    if (err instanceof ClassificationError) {
      return error(502, "CLASSIFIER_UNAVAILABLE", err.message, { cause: err.cause_kind });
    }
    throw err;
  }

  return Response.json({
    icp: result.icp,
    hubspot_label: result.hubspot_label,
    reasoning: result.reasoning,
    path: result.path,
    inputs: result.inputs,
    model: result.model,
    warnings: [...warnings, ...result.warnings],
    usage: {
      fundable_credits: fundable.credits,
      exa_cost_usd: Number(exa.usd.toFixed(6)),
      llm_tokens: result.usage?.totalTokens ?? 0,
      ms: Date.now() - started,
    },
  });
}
