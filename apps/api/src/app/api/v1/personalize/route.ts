/**
 * POST /api/v1/personalize — the shared decision layer (SPEC-v2).
 *
 * Success body is EXACTLY { icp, icp_use_cases, email_body } (API-003). Version
 * headers carry every operative registry so a bad answer is traceable to the
 * data that produced it. Errors never include partial business output.
 *
 * Pipeline: validate → template resolution → identity → research+classify →
 * use-case selection → compose → validate output. Fail closed at every gate.
 */

import {
  FundableError,
  newExaLedger,
  newLedger,
  normalizeDomain,
  personByLinkedIn,
  verifyCopy,
  blockingIssues,
} from "@fundable/shared";

import { checkAuth, checkRateLimit } from "../../../../lib/auth";
import { getStorage } from "../../../../lib/storage";
import { classifyV2, CLASSIFIER_PROMPT_VERSION } from "../../../../lib/v2/classify";
import { composeFromTemplate, composeNotCore, validateEmailBody, type ComposeContext } from "../../../../lib/v2/compose";
import {
  MESSAGE_TYPES,
  REGISTRY_VERSIONS,
  getTemplate,
  icpByNumber,
  useCasesFor,
  approvedClaimTexts,
  type MessageType,
} from "../../../../lib/v2/registry";

export const runtime = "nodejs";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function versionHeaders(): Record<string, string> {
  return {
    "X-Icp-Registry-Version": REGISTRY_VERSIONS.icp_registry,
    "X-Use-Case-Catalog-Version": REGISTRY_VERSIONS.use_case_catalog,
    "X-Template-Catalog-Version": REGISTRY_VERSIONS.template_catalog,
    "X-Approved-Claims-Version": REGISTRY_VERSIONS.approved_claims,
    "X-Prompt-Version": CLASSIFIER_PROMPT_VERSION,
    "X-Model": "deepseek/deepseek-v4-flash",
  };
}

function err(status: number, code: string, message: string, details?: unknown) {
  return Response.json(
    { error: { code, message, ...(details !== undefined ? { details } : {}) } },
    { status, headers: versionHeaders() }
  );
}

type RequestBody = {
  email?: unknown;
  linkedin_url?: unknown;
  message_type?: unknown;
  template_id?: unknown;
  email_template?: unknown;
  known_fields?: {
    first_name?: unknown;
    title?: unknown;
    company_name?: unknown;
    company_domain?: unknown;
    linkedin_url?: unknown;
  };
  additional_context?: Record<string, unknown>;
};

/**
 * Wall-clock time a caller sees is handler time + platform time (cold boot,
 * queueing, network). Only the first is ours to fix, and on the first run of a
 * real 29-lead list the two differed by more than a minute — so the split is
 * reported on every response instead of being guessed at from the outside.
 */
export async function POST(req: Request): Promise<Response> {
  const started = Date.now();
  const res = await handle(req);
  res.headers.set("X-Handler-Ms", String(Date.now() - started));
  return res;
}

async function handle(req: Request): Promise<Response> {
  const auth = checkAuth(req);
  if (!auth.ok) return err(auth.status, auth.status === 401 ? "UNAUTHORIZED" : "NOT_CONFIGURED", auth.message);
  const rate = checkRateLimit(auth.keyHash);
  if (!rate.ok) {
    return Response.json(
      { error: { code: "RATE_LIMITED", message: `Retry in ${rate.retryAfterS}s.` } },
      { status: 429, headers: { ...versionHeaders(), "Retry-After": String(rate.retryAfterS) } }
    );
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return err(400, "INVALID_JSON", "Request body is not valid JSON.");
  }

  // ---- validation (API-002) -------------------------------------------------
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return err(400, "INVALID_REQUEST", "A valid `email` is required.");
  }
  const messageType = body.message_type as MessageType;
  if (!MESSAGE_TYPES.includes(messageType)) {
    return err(400, "INVALID_REQUEST", `\`message_type\` must be one of: ${MESSAGE_TYPES.join(", ")}.`);
  }
  const hasTemplateId = typeof body.template_id === "string" && body.template_id.trim() !== "";
  const hasRawTemplate = typeof body.email_template === "string" && body.email_template.trim() !== "";
  if (hasTemplateId === hasRawTemplate) {
    // Both or neither — the spec's exactly-one rule, fixture-tested.
    return err(400, "INVALID_REQUEST", "Provide exactly one of `template_id` or `email_template`.");
  }

  const template = hasTemplateId ? getTemplate((body.template_id as string).trim()) : null;
  if (hasTemplateId && !template) {
    return err(422, "UNKNOWN_TEMPLATE", `Template "${body.template_id}" is not in the catalog.`);
  }
  if (template && !template.allowed_message_types.includes(messageType)) {
    return err(
      422,
      "TEMPLATE_MESSAGE_TYPE_CONFLICT",
      `Template "${template.id}" allows [${template.allowed_message_types.join(", ")}], not "${messageType}".`
    );
  }

  // ---- idempotency (API-005) ------------------------------------------------
  const storage = getStorage();
  const idemKey = req.headers.get("idempotency-key")?.trim();
  if (idemKey) {
    const cached = await storage.cacheGet(`idem:${idemKey}`, "fundable");
    if (cached) {
      return Response.json(cached, { headers: { ...versionHeaders(), "X-Idempotent-Replay": "true" } });
    }
  }

  const fundable = newLedger();
  const exa = newExaLedger();
  const kf = body.known_fields ?? {};
  const ctxIn = body.additional_context ?? {};
  const linkedin =
    typeof body.linkedin_url === "string"
      ? body.linkedin_url
      : typeof kf.linkedin_url === "string"
        ? kf.linkedin_url
        : undefined;

  try {
    // ---- identity (ID-001..004) --------------------------------------------
    let title = typeof kf.title === "string" ? kf.title.trim() : undefined;
    let company = typeof kf.company_name === "string" ? kf.company_name.trim() : undefined;
    const emailDomain = normalizeDomain(email).domain;

    if (linkedin) {
      const { person } = await personByLinkedIn(linkedin, fundable);
      if (person) {
        title = title ?? person.title ?? undefined;
        company = company ?? person.current_company?.name ?? undefined;
        // ID-004: fail closed on a material email-domain vs employer conflict.
        const employerDomain = person.current_company?.domain
          ? normalizeDomain(person.current_company.domain).domain
          : null;
        if (employerDomain && employerDomain !== emailDomain) {
          return err(
            409,
            "IDENTITY_CONFLICT",
            `Email domain "${emailDomain}" conflicts with the LinkedIn profile's current employer "${employerDomain}". Failing closed rather than personalizing for the wrong identity.`
          );
        }
      }
    }

    // ---- classification -----------------------------------------------------
    // company_domain is the caller's assertion about the employer. It never
    // overrides a corporate email domain and never participates in the identity
    // check above; it exists so a lead with a personal address is still
    // researchable instead of failing closed for want of a lookup.
    const companyDomain =
      typeof kf.company_domain === "string" && kf.company_domain.trim()
        ? normalizeDomain(kf.company_domain).domain
        : undefined;
    const cls = await classifyV2({ email, title, company, companyDomain }, exa);
    const entry = cls.icpNumber !== null ? icpByNumber(cls.icpNumber) : null;
    const useCases = useCasesFor(cls.icpNumber);

    // ---- compose (GEN-001..009, CTX-001..004) -------------------------------
    // Context is typed and allowlisted (CTX-001): unknown keys are ignored, and
    // nothing here can override policy because policy never reads it.
    const ctx: ComposeContext = {
      first_name: typeof kf.first_name === "string" ? kf.first_name.trim() || undefined : undefined,
      company_name: company,
      territory: typeof ctxIn.territory === "string" ? ctxIn.territory.trim() || undefined : undefined,
      target_buyer_role:
        typeof ctxIn.target_buyer_role === "string" ? ctxIn.target_buyer_role.trim() || undefined : undefined,
      sender_name: typeof ctxIn.sender_name === "string" ? ctxIn.sender_name.trim() || undefined : undefined,
      icp_descriptor: entry?.email_descriptor,
    };

    let emailBody: string;
    if (cls.icpNumber === null) {
      const { body: b, issues } = composeNotCore({ messageType, ctx });
      if (issues.length) return err(502, "OUTPUT_VALIDATION_FAILED", "Generic fallback failed validation.", issues);
      emailBody = b;
    } else if (template) {
      const { body: b, issues } = composeFromTemplate({ template, useCases, ctx });
      if (issues.length) return err(502, "OUTPUT_VALIDATION_FAILED", "Composed body failed validation.", issues);
      emailBody = b;
    } else {
      // Raw email_template: same variable/claim/privacy policies as catalog copy.
      const raw = (body.email_template as string).trim();
      const { body: b, issues } = composeFromTemplate({
        template: {
          id: "caller_raw_template",
          version: "caller",
          source: "caller",
          allowed_message_types: [messageType],
          audience: "caller-defined",
          required_context: [],
          optional_context: [],
          cta_policy: "caller-defined",
          claim_refs: [],
          body: raw,
        },
        useCases,
        ctx,
      });
      if (issues.length) return err(422, "TEMPLATE_VALIDATION_FAILED", "email_template failed validation.", issues);

      // Claim policy: everything factual must trace to the use case, approved
      // claims, or the caller's own template text (their claims are theirs).
      const evidence = [
        ...useCases.map((u) => ({ fact: `${u.name}. ${u.why_relevant} Example: ${u.example_alert}`, source: "sender_context" as const, confidence: 1 })),
        ...approvedClaimTexts(["capability-deal-alerts", "capability-realtime-tracking", "capability-buyer-contacts", "capability-mcp", "capability-api"]).map(
          (t) => ({ fact: t, source: "sender_context" as const, confidence: 1 })
        ),
      ];
      const verdicts = blockingIssues(
        verifyCopy({
          copy: b,
          evidence,
          template: raw,
          allowedNames: [ctx.first_name, ctx.company_name, ctx.sender_name, "Fundable"].filter(
            (x): x is string => !!x
          ),
          senderCompany: "Fundable",
        })
      );
      if (verdicts.length) {
        return err(422, "UNSUPPORTED_CLAIM", "email_template produced claims outside the approved set.", verdicts);
      }
      emailBody = b;
    }

    const finalIssues = validateEmailBody(emailBody);
    if (finalIssues.length) {
      return err(502, "OUTPUT_VALIDATION_FAILED", "Final body failed validation.", finalIssues);
    }

    // ---- success: EXACTLY three keys (API-003) ------------------------------
    const success = {
      icp: cls.label,
      icp_use_cases: useCases,
      email_body: emailBody,
    };

    if (idemKey) {
      await storage.cacheSet(`idem:${idemKey}`, "fundable", success, IDEMPOTENCY_TTL_MS);
    }

    return Response.json(success, { headers: versionHeaders() });
  } catch (e) {
    if (e instanceof FundableError) return err(502, "UPSTREAM_FUNDABLE", `${e.message} (Fundable ${e.status})`);
    console.error("[v1/personalize]", e);
    return err(502, "DEPENDENCY_FAILURE", e instanceof Error ? e.message : "Unexpected dependency failure.");
  }
}
