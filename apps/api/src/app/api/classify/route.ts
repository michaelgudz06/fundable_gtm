/**
 * POST /api/classify — ICP classification as a service.
 *
 * The point (per Jacob): one classifier callable from every surface — website
 * sign-up, website visitor, cold outbound — so the same person gets the same
 * ICP everywhere, instead of each surface reimplementing the prompt and
 * drifting.
 *
 * This endpoint used to be the drift. It ran the legacy 17-label taxonomy whose
 * rule 3 reads "VCs, angels, and investors are not a target", while
 * /api/v1/personalize runs the v2 registry where #19 Investor is core — so the
 * same a16z GP came back `ICP #19: Investor` from one surface and
 * `Not Core ICP` from the other. That is the spec's first acceptance criterion
 * failing inside a single deployment, and the spec's own References call it the
 * unresolved "#19 conflict".
 *
 * It now classifies with classifyV2 against the same registry as the
 * personalize route. What it keeps that the other does not expose: the model's
 * reasoning, which path was taken, and the HubSpot picklist value.
 *
 * Two-tier, chosen automatically by what is known:
 *   title present  -> titled path (precise; role-gated registry)
 *   email only     -> Exa company research + conservative classification
 *   freemail/blank -> refuses rather than guessing
 *
 * When only email + LinkedIn are known, pass the LinkedIn URL: the title is
 * resolved from Fundable's people index first, which upgrades the lead onto the
 * precise path.
 */

import {
  ClassificationError,
  FundableError,
  newExaLedger,
  newLedger,
  normalizeEmail,
  personByLinkedIn,
  startBudget,
} from "@fundable/shared";

import { checkAuth, checkRateLimit } from "../../../lib/auth";
import { CLASSIFIER_PROMPT_VERSION } from "../../../lib/v2/classify";
import { classifyCached } from "../../../lib/v2/classify-cached";
import { hubspotLabelFor } from "../../../lib/v2/hubspot";
import { REGISTRY_VERSIONS } from "../../../lib/v2/registry";

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

  const email = typeof body.email === "string" ? normalizeEmail(body.email) : undefined;
  const linkedin = typeof body.linkedin === "string" ? body.linkedin.trim() : undefined;
  let title = typeof body.title === "string" ? body.title.trim() : undefined;
  let company = typeof body.company === "string" ? body.company.trim() : undefined;

  if (!email && !linkedin && !title) {
    return error(400, "INVALID_REQUEST", "Need at least one of: email, linkedin, title.");
  }
  if (!email) {
    // classifyV2 keys its gates off the address; without one there is nothing to
    // fail closed against.
    return error(400, "INVALID_REQUEST", "`email` is required to classify.");
  }

  const started = Date.now();
  const deadlineAt = startBudget();
  const fundable = newLedger(deadlineAt);
  const exa = newExaLedger(deadlineAt);
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
    // Same cached decision the personalize route uses. Without this, the
    // endpoint whose purpose is a consistent label re-voted on every call and
    // could disagree with the other surface — and with itself.
    result = await classifyCached({ email, title, company, deadlineAt }, exa);
  } catch (err) {
    // Infrastructure failure is a 502 the caller can retry — never a 200 with
    // a confident "Not Core ICP" they would persist (QA finding).
    if (err instanceof ClassificationError) {
      return error(502, "CLASSIFIER_UNAVAILABLE", err.message, { cause: err.cause_kind });
    }
    throw err;
  }

  const hubspot = hubspotLabelFor(result.icpNumber);
  if (hubspot.status === "missing_property_option") warnings.push(hubspot.note);

  return Response.json(
    {
      icp: result.label,
      icp_number: result.icpNumber,
      hubspot_label: hubspot.value,
      hubspot_label_status: hubspot.status,
      ...(hubspot.status === "missing_property_option" ? { hubspot_label_proposed: hubspot.proposed } : {}),
      reasoning: result.reasoning,
      path: result.path,
      agreement: result.agreement.total ? `${result.agreement.top}/${result.agreement.total}` : null,
      classification: result.cacheState,
      inputs: { email, ...(title ? { title } : {}), ...(company ? { company } : {}) },
      model: result.model,
      warnings: [...warnings, ...result.warnings],
      usage: {
        fundable_credits: fundable.credits,
        exa_cost_usd: Number(exa.usd.toFixed(6)),
        llm_tokens: result.usage.reduce((n, u) => n + (u.totalTokens ?? 0), 0),
        ms: Date.now() - started,
      },
    },
    {
      headers: {
        "X-Icp-Registry-Version": REGISTRY_VERSIONS.icp_registry,
        "X-Prompt-Version": CLASSIFIER_PROMPT_VERSION,
      },
    }
  );
}
