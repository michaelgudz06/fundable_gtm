/**
 * POST /api/v1/personalize — the shared decision layer (SPEC-v2).
 *
 * Success body is EXACTLY { full_name, email, linkedin_url, icp, icp_use_cases,
 * email_body } (API-003) — or a documented PREFIX of it when the caller sends
 * `stop_at` (Jacob's ask #7): "linkedin" returns the first three keys, "icp"
 * the first five, "email" (the default, and what every pre-existing caller
 * gets) all six. Version
 * headers carry every operative registry so a bad answer is traceable to the
 * data that produced it. Errors never include partial business output.
 *
 * This file wires HTTP: auth, request validation (API-002), idempotency
 * (API-005), headers, telemetry. The decision pipeline itself lives in
 * lib/v2/personalize.ts.
 */

import { FundableError, newExaLedger, MODEL_PLAN, newLedger, startBudget } from "@fundable/shared";

import { checkAuth, checkRateLimit } from "../../../../lib/auth";
import { getStorage } from "../../../../lib/storage";
import { CLASSIFIER_PROMPT_VERSION } from "../../../../lib/v2/classify";
import { registryFingerprint } from "../../../../lib/v2/classify-cached";
import { validateTemplateSource } from "../../../../lib/v2/compose";
import { STOP_AT, decide, type StopAt, type Trace } from "../../../../lib/v2/personalize";
import { MESSAGE_TYPES, REGISTRY_VERSIONS, getTemplate, type MessageType } from "../../../../lib/v2/registry";

export const runtime = "nodejs";

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Bump when the success body's KEY SET changes.
 *
 * The registry fingerprint namespaces the cache against data changes, but the
 * response shape is a code change and moves independently. When this body went
 * from three keys to six, replays kept serving three-key bodies out of the old
 * deploy's cache for a full TTL — a caller reading full_name got null with a
 * 200 and no warning. Caught live on 2026-08-18; this constant is what stops
 * the next shape change repeating it.
 */
const IDEMPOTENCY_SHAPE = "v2-six-key";

const idemCacheKey = (key: string, stopAt: StopAt): string =>
  `idem:${IDEMPOTENCY_SHAPE}:${stopAt}:${registryFingerprint()}:${key}`;

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
  stop_at?: unknown;
  linkedin_url?: unknown;
  message_type?: unknown;
  template_id?: unknown;
  email_template?: unknown;
  known_fields?: {
    first_name?: unknown;
    last_name?: unknown;
    title?: unknown;
    company_name?: unknown;
    company_domain?: unknown;
    /** Industry hint — steers research targeting only, never classifier evidence. */
    company_industry?: unknown;
    linkedin_url?: unknown;
    /** The PERSON's location, distinct from additional_context.territory. */
    location?: unknown;
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

export async function POST(req: Request): Promise<Response> {
  const started = Date.now();
  const trace: Trace = { identity: 0, research: 0, model: 0, bodySource: "none", classification: "none", agreement: "", modelServed: "", useCaseType: "none", linkedinSource: "", identityTimedOut: false, stopAt: "email" };
  const res = await handle(req, trace);
  res.headers.set("X-Handler-Ms", String(Date.now() - started));
  res.headers.set(
    "X-Stage-Ms",
    `identity=${trace.identity},research=${trace.research},model=${trace.model}`
  );
  // A Not Core lead gets the approved generic body even when the caller supplied
  // their own template — correct per spec, but invisible from the response body,
  // which is exactly how someone ends up believing their copy went out.
  res.headers.set("X-Stop-At", trace.stopAt);
  res.headers.set("X-Body-Source", trace.bodySource);
  res.headers.set("X-Classification", trace.classification);
  if (trace.modelServed) res.headers.set("X-Model-Served", trace.modelServed);
  res.headers.set("X-Use-Case-Type", trace.useCaseType);
  if (trace.agreement) res.headers.set("X-Classifier-Agreement", trace.agreement);
  if (trace.linkedinSource) res.headers.set("X-Linkedin-Source", trace.linkedinSource);
  // Says the identity lookup was skipped, not that it found nothing — the
  // difference matters to anyone reading linkedin_url off the response.
  if (trace.identityTimedOut) res.headers.set("X-Identity", "timeout");
  return res;
}

async function handle(req: Request, trace: Trace): Promise<Response> {
  const handlerStarted = Date.now();
  const auth = checkAuth(req);
  if (!auth.ok) return err(auth.status, auth.status === 401 ? "UNAUTHORIZED" : "NOT_CONFIGURED", auth.message);
  const rate = await checkRateLimit(auth.keyHash);
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
  // Both names are mandatory (Jacob, 2026-08-16). Checked here rather than in
  // decide() so a nameless lead costs nothing: no Fundable credit, no Exa
  // search, no model call. Measured against the real 1601-row export, 81.6% of
  // rows clear this gate and email — not the names — is the binding constraint.
  const kfIn = body.known_fields ?? {};
  const firstName = typeof kfIn.first_name === "string" ? kfIn.first_name.trim() : "";
  const lastName = typeof kfIn.last_name === "string" ? kfIn.last_name.trim() : "";
  if (!firstName || !lastName) {
    return err(400, "INVALID_REQUEST", "`known_fields.first_name` and `known_fields.last_name` are both required.");
  }

  // How far to run. Absent means the full pipeline, so every caller that
  // predates this parameter keeps its exact behaviour and its six-key body.
  if (body.stop_at !== undefined && !STOP_AT.includes(body.stop_at as StopAt)) {
    return err(400, "INVALID_REQUEST", `\`stop_at\` must be one of: ${STOP_AT.join(", ")}.`);
  }
  const stopAt: StopAt = (body.stop_at as StopAt) ?? "email";
  // Recorded as soon as it is known so every response after this point — the
  // idempotent replay included — reports the mode the caller ASKED for. The
  // replay used to say X-Stop-At: email on an icp replay (QA finding).
  trace.stopAt = stopAt;
  const composing = stopAt === "email";

  // message_type and the template pair drive composition only. Demanding them
  // from a caller who just wants a LinkedIn URL would be asking for a template
  // to render copy nobody requested. Still validated when present, so a typo in
  // a body carried over between modes is caught rather than silently dropped.
  const messageType = body.message_type as MessageType;
  const hasMessageType = typeof body.message_type === "string" && body.message_type.trim() !== "";
  if ((composing || hasMessageType) && !MESSAGE_TYPES.includes(messageType)) {
    return err(400, "INVALID_REQUEST", `\`message_type\` must be one of: ${MESSAGE_TYPES.join(", ")}.`);
  }
  const hasTemplateId = typeof body.template_id === "string" && body.template_id.trim() !== "";
  const hasRawTemplate = typeof body.email_template === "string" && body.email_template.trim() !== "";
  if (composing && hasTemplateId === hasRawTemplate) {
    // Both or neither — the spec's exactly-one rule, fixture-tested.
    return err(400, "INVALID_REQUEST", "Provide exactly one of `template_id` or `email_template`.");
  }
  if (!composing && (hasTemplateId || hasRawTemplate)) {
    // Fail loudly rather than accepting copy instructions and returning no copy.
    return err(400, "INVALID_REQUEST", `\`template_id\`/\`email_template\` are only valid with stop_at="email".`);
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

  const rawTemplate = hasRawTemplate ? (body.email_template as string).trim() : null;
  if (rawTemplate !== null) {
    const structural = validateTemplateSource(rawTemplate);
    if (structural.length) {
      return err(422, "TEMPLATE_VALIDATION_FAILED", "email_template failed validation.", structural);
    }
  }

  // ---- idempotency (API-005) ------------------------------------------------
  const storage = getStorage();
  const idemKey = req.headers.get("idempotency-key")?.trim();
  if (idemKey) {
    const cached = (await storage.cacheGet(idemCacheKey(idemKey, stopAt), "fundable")) as Record<string, unknown> | null;
    if (cached) {
      // Whitelisted rather than returned as-is: a replay must not be able to
      // surface a key the live contract does not promise — and the promised set
      // now depends on the mode, which is why the key is namespaced by it too.
      const canonical: Record<string, unknown> = {
        full_name: cached.full_name,
        email: cached.email,
        linkedin_url: cached.linkedin_url ?? null,
      };
      if (stopAt !== "linkedin") {
        canonical.icp = cached.icp;
        canonical.icp_use_cases = cached.icp_use_cases;
      }
      if (stopAt === "email") canonical.email_body = cached.email_body;
      return Response.json(canonical, { headers: { ...versionHeaders(), "X-Idempotent-Replay": "true" } });
    }
  }

  // One budget for the whole request; every upstream leg is clamped to what
  // remains of it, which is what makes p95 <= 15s structural rather than lucky.
  const deadlineAt = startBudget();
  const fundable = newLedger(deadlineAt);
  const exa = newExaLedger(deadlineAt);
  const kf = body.known_fields ?? {};
  const linkedin =
    typeof body.linkedin_url === "string"
      ? body.linkedin_url
      : typeof kf.linkedin_url === "string"
        ? kf.linkedin_url
        : undefined;

  try {
    const decision = await decide({
      email,
      messageType,
      template,
      rawTemplate,
      linkedin,
      firstName,
      lastName,
      location: typeof kf.location === "string" ? kf.location.trim() || undefined : undefined,
      knownFields: kf,
      additionalContext: body.additional_context ?? {},
      deadlineAt,
      fundable,
      exa,
      trace,
      stopAt,
    });
    if (!decision.ok) return err(decision.status, decision.code, decision.message, decision.details);

    const { success } = decision;
    if (idemKey) {
      await storage.cacheSet(idemCacheKey(idemKey, stopAt), "fundable", success, IDEMPOTENCY_TTL_MS);
    }

    await record(storage, auth.keyHash, {
      messageType: composing ? messageType : `stop_at:${stopAt}`,
      status: "ok",
      icp: success.icp ?? null,
      trace,
      handlerMs: Date.now() - handlerStarted,
      fundableCredits: fundable.credits,
      exaUsd: exa.usd,
      llmTokens: decision.usage.reduce((n, u) => n + (u.totalTokens ?? 0), 0),
      warnings: decision.warnings,
      validationIssues: [],
    });

    return Response.json(success, { headers: versionHeaders(trace.modelServed) });
  } catch (e) {
    if (e instanceof FundableError) return err(502, "UPSTREAM_FUNDABLE", `${e.message} (Fundable ${e.status})`);
    console.error("[v1/personalize]", e);
    return err(502, "DEPENDENCY_FAILURE", e instanceof Error ? e.message : "Unexpected dependency failure.");
  }
}
