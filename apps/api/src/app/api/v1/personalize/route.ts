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
  isFreemail,
  MODEL_PLAN,
  newLedger,
  normalizeDomain,
  normalizeEmail,
  startBudget,
  normalizeLinkedIn,
  personByLinkedIn,
  verifyCopy,
  blockingIssues,
} from "@fundable/shared";

import { checkAuth, checkRateLimit } from "../../../../lib/auth";
import { getStorage } from "../../../../lib/storage";
import { researchTarget, startResearch, CLASSIFIER_PROMPT_VERSION } from "../../../../lib/v2/classify";
import { classifyCached, registryFingerprint } from "../../../../lib/v2/classify-cached";
import {
  composeFromTemplate,
  composeNotCore,
  validateEmailBody,
  validateTemplateSource,
  type ComposeContext,
} from "../../../../lib/v2/compose";
import {
  MESSAGE_TYPES,
  REGISTRY_VERSIONS,
  getTemplate,
  icpByNumber,
  useCasesFor,
  isDeferred,
  approvedClaimTexts,
  type MessageType,
} from "../../../../lib/v2/registry";

import { createHash } from "node:crypto";

export const runtime = "nodejs";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

function versionHeaders(servedModel?: string): Record<string, string> {
  return {
    "X-Icp-Registry-Version": REGISTRY_VERSIONS.icp_registry,
    "X-Use-Case-Catalog-Version": REGISTRY_VERSIONS.use_case_catalog,
    "X-Template-Catalog-Version": REGISTRY_VERSIONS.template_catalog,
    "X-Approved-Claims-Version": REGISTRY_VERSIONS.approved_claims,
    "X-Prompt-Version": CLASSIFIER_PROMPT_VERSION,
    // The model we ASKED for. `X-Model-Served` reports what came back — they
    // differ when a provider routes elsewhere, and a trace that cannot tell them
    // apart attributes a label to the wrong model.
    "X-Model": MODEL_PLAN,
    ...(servedModel ? { "X-Model-Served": servedModel } : {}),
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
 * One row per request, for the metrics the spec asks for and nothing emitted:
 * label distribution, Not Core rate, cache hit rate, output-validation failures,
 * latency, cost, and which registry versions produced the answer.
 *
 * Deliberately PII-minimised. The legacy pipeline writes person_email and the
 * full body into this same table; this route writes NEITHER. What a metric needs
 * is the shape of the decision, not who it was about — and a log that answers
 * "what is our Not Core rate this week" without storing a single address is
 * strictly better than one that cannot be shared.
 */
async function record(
  storage: ReturnType<typeof getStorage>,
  keyHash: string,
  fields: {
    messageType: string;
    status: string;
    icp: string | null;
    trace: Trace;
    handlerMs: number;
    fundableCredits: number;
    exaUsd: number;
    llmTokens: number;
    warnings: string[];
    validationIssues: unknown[];
  }
): Promise<void> {
  try {
    await storage.log({
      api_key_hash: keyHash,
      trigger: fields.messageType,
      channel: "v1/personalize",
      // PII columns stay null on this route. See the note above.
      person_email: null,
      person_linkedin: null,
      person_name: null,
      sender_context: null,
      max_facts: 0,
      template_provided: fields.trace.bodySource === "caller_template",
      company_id: null,
      company_name: null,
      company_domain: null,
      person_id: null,
      status: fields.status,
      confidence: null,
      angle: fields.icp,
      subject: null,
      body: null,
      evidence: [
        {
          registry: REGISTRY_VERSIONS.icp_registry,
          use_cases: REGISTRY_VERSIONS.use_case_catalog,
          templates: REGISTRY_VERSIONS.template_catalog,
          claims: REGISTRY_VERSIONS.approved_claims,
          prompt: CLASSIFIER_PROMPT_VERSION,
          model_requested: MODEL_PLAN,
          model_served: fields.trace.modelServed || null,
          classification: fields.trace.classification,
          agreement: fields.trace.agreement || null,
          body_source: fields.trace.bodySource,
          use_case_type: fields.trace.useCaseType,
          stage_ms: {
            identity: fields.trace.identity,
            research: fields.trace.research,
            model: fields.trace.model,
          },
        },
      ],
      warnings: fields.warnings,
      verify_issues: fields.validationIssues.length ? fields.validationIssues : null,
      verify_retried: false,
      fundable_credits: fields.fundableCredits,
      exa_cost_usd: Number(fields.exaUsd.toFixed(6)),
      llm_tokens: fields.llmTokens,
      latency_ms: fields.handlerMs,
      voice_id: null,
      voice_provenance: null,
    });
  } catch {
    // Telemetry must never fail a send. A dropped metric is a worse day than a
    // dropped email only for us.
  }
}

/** Per-leg upstream timings, reported on every response as X-Stage-Ms. */
type Trace = {
  identity: number;
  research: number;
  model: number;
  /** Which body the caller actually received — see X-Body-Source. */
  bodySource: "caller_template" | "catalog_template" | "generic_fallback" | "none";
  /** Whether the label came from the classifier or from the stable cache. */
  classification: "fresh" | "cached" | "none";
  /** Vote agreement, e.g. "3/3" — surfaced so a caller can gate review on it. */
  agreement: string;
  /** The model the provider actually served, not the one we asked for. */
  modelServed: string;
  /** alert | mcp | none — which frame the body was composed from. */
  useCaseType: string;
};

/** Fundable's own TTL for person records elsewhere in this codebase. */
const PERSON_TTL_MS = 30 * 24 * 60 * 60 * 1000;


/**
 * Identity lookups are cached because the upstream endpoint is slow on a cold
 * path (19s measured, against 2.6s warm) and a lead list re-run — a retry, a
 * second campaign, an n8n replay — asks the same question about the same people.
 *
 * A miss is cached too: "this LinkedIn URL is not in Fundable" is a stable
 * answer, and without it every unknown lead pays the slow path on every send.
 */
async function personCached(
  linkedin: string,
  ledger: ReturnType<typeof newLedger>
): Promise<{ person: Awaited<ReturnType<typeof personByLinkedIn>>["person"] }> {
  const storage = getStorage();
  const key = `person:${normalizeLinkedIn(linkedin) ?? linkedin.trim().toLowerCase()}`;
  const hit = (await storage.cacheGet(key, "fundable")) as { person: unknown } | null;
  if (hit && typeof hit === "object" && "person" in hit) {
    return { person: hit.person as never };
  }
  const { person } = await personByLinkedIn(linkedin, ledger);
  await storage.cacheSet(key, "fundable", { person: person ?? null }, PERSON_TTL_MS);
  return { person };
}

export async function POST(req: Request): Promise<Response> {
  const started = Date.now();
  const trace: Trace = { identity: 0, research: 0, model: 0, bodySource: "none", classification: "none", agreement: "", modelServed: "", useCaseType: "none" };
  const res = await handle(req, trace);
  res.headers.set("X-Handler-Ms", String(Date.now() - started));
  res.headers.set(
    "X-Stage-Ms",
    `identity=${trace.identity},research=${trace.research},model=${trace.model}`
  );
  // A Not Core lead gets the approved generic body even when the caller supplied
  // their own template — correct per spec, but invisible from the response body,
  // which is exactly how someone ends up believing their copy went out.
  res.headers.set("X-Body-Source", trace.bodySource);
  res.headers.set("X-Classification", trace.classification);
  if (trace.modelServed) res.headers.set("X-Model-Served", trace.modelServed);
  res.headers.set("X-Use-Case-Type", trace.useCaseType);
  if (trace.agreement) res.headers.set("X-Classifier-Agreement", trace.agreement);
  return res;
}

async function handle(req: Request, trace: Trace): Promise<Response> {
  const handlerStarted = Date.now();
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

  if (hasRawTemplate) {
    const structural = validateTemplateSource((body.email_template as string).trim());
    if (structural.length) {
      return err(422, "TEMPLATE_VALIDATION_FAILED", "email_template failed validation.", structural);
    }
  }

  // ---- idempotency (API-005) ------------------------------------------------
  const storage = getStorage();
  const idemKey = req.headers.get("idempotency-key")?.trim();
  if (idemKey) {
    const cached = (await storage.cacheGet(`idem:${registryFingerprint()}:${idemKey}`, "fundable")) as Record<string, unknown> | null;
    if (cached) {
      const canonical = {
        icp: cached.icp,
        icp_use_cases: cached.icp_use_cases,
        email_body: cached.email_body,
      };
      return Response.json(canonical, { headers: { ...versionHeaders(), "X-Idempotent-Replay": "true" } });
    }
  }

  // One budget for the whole request; every upstream leg is clamped to what
  // remains of it, which is what makes p95 <= 15s structural rather than lucky.
  const deadlineAt = startBudget();
  const fundable = newLedger(deadlineAt);
  const exa = newExaLedger(deadlineAt);
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
    const companyDomain =
      typeof kf.company_domain === "string" && kf.company_domain.trim()
        ? normalizeDomain(kf.company_domain).domain
        : undefined;

    // Research asks about the company; the identity lookup asks about the
    // person. Neither needs the other's answer when the caller already told us
    // the title — and the identity leg is the slow one (measured at 19s cold,
    // 2.6s warm against Fundable /people), so the two are started together.
    let researchDomain = companyDomain;
    const preTarget = title
      ? researchTarget({ emailDomain, companyDomain: researchDomain, company })
      : null; // no title yet: the freemail gate may make research unnecessary
    const researchTask = preTarget ? startResearch(preTarget, exa) : undefined;

    if (linkedin) {
      const tIdentity = Date.now();
      const { person } = await personCached(linkedin, fundable);
      trace.identity = Date.now() - tIdentity;
      if (person) {
        title = title ?? person.title ?? undefined;
        company = company ?? person.current_company?.name ?? undefined;
        // ID-004: fail closed on a material email-domain vs employer conflict.
        //
        // "Material" excludes a personal address. gmail.com is not a competing
        // employer claim — it is the absence of one — so treating the mismatch
        // as a conflict would 409 every consumer-mailbox lead whose profile
        // resolves, which is precisely the population the research fallback
        // exists to serve. Their employer is taken from the profile instead.
        const employerDomain = person.current_company?.domain
          ? normalizeDomain(person.current_company.domain).domain
          : null;
        if (employerDomain && !isFreemail(emailDomain) && employerDomain !== emailDomain) {
          return err(
            409,
            "IDENTITY_CONFLICT",
            `Email domain "${emailDomain}" conflicts with the LinkedIn profile's current employer "${employerDomain}". Failing closed rather than personalizing for the wrong identity.`
          );
        }
        // For a personal address the profile's employer is the best evidence we
        // have — better than the caller's assertion, and far better than a name.
        if (employerDomain && isFreemail(emailDomain)) researchDomain = employerDomain;
      }
    }

    // ---- classification -----------------------------------------------------
    // company_domain (read above) is the caller's assertion about the employer.
    // It never overrides a corporate email domain and never participates in the
    // identity check; it exists so a lead with a personal address is still
    // researchable instead of failing closed for want of a lookup.
    const cls = await classifyCached(
      { email, title, company, companyDomain: researchDomain, researchTask, deadlineAt },
      exa
    );
    trace.classification = cls.cacheState;
    trace.research = cls.timings.research;
    trace.model = cls.timings.model;
    if (cls.agreement.total) trace.agreement = `${cls.agreement.top}/${cls.agreement.total}`;
    if (cls.model) trace.modelServed = cls.model;
    const entry = cls.icpNumber !== null ? icpByNumber(cls.icpNumber) : null;
    // CTX-001: typed context only. These three are the conditions the catalog's
    // requires_context refers to; anything else in additional_context is ignored.
    const useCases = useCasesFor(cls.icpNumber, {
      investor_connection: ctxIn.investor_connection === true,
      product_context: typeof ctxIn.product_context === "string" ? ctxIn.product_context.trim() : undefined,
      target_buyer_role: typeof ctxIn.target_buyer_role === "string" ? ctxIn.target_buyer_role.trim() : undefined,
      territory: typeof ctxIn.territory === "string" ? ctxIn.territory.trim() : undefined,
    });

    trace.useCaseType = useCases[0]?.workflow_type ?? "none";
    if (isDeferred(cls.icpNumber)) {
      // USE-006: classified, but the spec defers use-case selection for this ICP
      // until product and delivery context are known. The lead still gets copy —
      // it just makes no use-case claim.
      trace.useCaseType = "deferred";
    }

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
      trace.bodySource = "generic_fallback";
    } else if (template) {
      const { body: b, issues } = composeFromTemplate({ template, useCases, ctx });
      if (issues.length) return err(502, "OUTPUT_VALIDATION_FAILED", "Composed body failed validation.", issues);
      emailBody = b;
      trace.bodySource = "catalog_template";
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
        ...useCases.map((u) => ({
          fact: `${u.name}. ${u.why_relevant} Example: ${
            u.workflow_type === "mcp" ? u.example_prompt : u.example_alert
          }`,
          source: "sender_context" as const,
          confidence: 1,
        })),
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
      trace.bodySource = "caller_template";
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
      await storage.cacheSet(`idem:${registryFingerprint()}:${idemKey}`, "fundable", success, IDEMPOTENCY_TTL_MS);
    }

    await record(storage, auth.keyHash, {
      messageType,
      status: "ok",
      icp: cls.label,
      trace,
      handlerMs: Date.now() - handlerStarted,
      fundableCredits: fundable.credits,
      exaUsd: exa.usd,
      llmTokens: cls.usage.reduce((n, u) => n + (u.totalTokens ?? 0), 0),
      warnings: cls.warnings,
      validationIssues: [],
    });

    return Response.json(success, { headers: versionHeaders(trace.modelServed) });
  } catch (e) {
    if (e instanceof FundableError) return err(502, "UPSTREAM_FUNDABLE", `${e.message} (Fundable ${e.status})`);
    console.error("[v1/personalize]", e);
    return err(502, "DEPENDENCY_FAILURE", e instanceof Error ? e.message : "Unexpected dependency failure.");
  }
}
