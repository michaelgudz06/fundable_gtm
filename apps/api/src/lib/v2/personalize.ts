/**
 * The /api/v1/personalize decision pipeline (SPEC-v2): identity → research +
 * classify → use-case selection → compose → claim gate → output validation.
 * Fail closed at every gate.
 *
 * The route wires HTTP — auth, request validation, idempotency, headers,
 * telemetry — and hands the validated request here. Errors come back as data
 * (status/code/message), never as Responses: HTTP envelopes are the route's.
 */

import {
  blockingIssues,
  DeadlineError,
  isFreemail,
  newLedger,
  normalizeDomain,
  normalizeLinkedIn,
  personByLinkedIn,
  verifyCopy,
  type ExaLedger,
  type Usage,
} from "@fundable/shared";

import { getStorage } from "../storage";
import { researchTarget, startResearch } from "./classify";
import { classifyCached } from "./classify-cached";
import {
  composeFromTemplate,
  composeNotCore,
  validateEmailBody,
  type ComposeContext,
} from "./compose";
import {
  approvedClaimTexts,
  icpByNumber,
  isDeferred,
  useCasesFor,
  type MessageType,
  type TemplateEntry,
  type UseCase,
} from "./registry";
import { resolveLinkedIn } from "./resolve-linkedin";

/** Per-leg upstream timings, reported on every response as X-Stage-Ms. */
export type Trace = {
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
  /** Which n8n cascade branch found the profile, "" when none ran. */
  linkedinSource: string;
  /** The Fundable lookup blew its 8s cap; the lead was classified without it. */
  identityTimedOut: boolean;
  /** Which run mode produced this body; reported as X-Stop-At. */
  stopAt: string;
};

/**
 * How far down the pipeline to run (Jacob's ask #7). Each mode is the one
 * above it plus a stage, so the response is a prefix of the six-key body —
 * never a different shape for the same stage.
 *
 *   linkedin -> { full_name, email, linkedin_url }
 *   icp      -> + { icp, icp_use_cases }
 *   email    -> + { email_body }   (the default; the pre-existing behaviour)
 */
export const STOP_AT = ["linkedin", "icp", "email"] as const;
export type StopAt = (typeof STOP_AT)[number];

export type Decision =
  | {
      ok: true;
      /** EXACTLY the six success keys (API-003). full_name, email and
       *  linkedin_url were added for Jacob's v2 shape; the three original keys
       *  are unchanged, so no existing reader breaks. */
      success: {
        full_name: string;
        email: string;
        linkedin_url: string | null;
        /** Absent only when stop_at="linkedin". */
        icp?: string;
        icp_use_cases?: UseCase[];
        /** Absent unless stop_at="email". */
        email_body?: string;
      };
      usage: Usage[];
      warnings: string[];
    }
  | { ok: false; status: number; code: string; message: string; details?: unknown };

const fail = (status: number, code: string, message: string, details?: unknown): Decision =>
  ({ ok: false, status, code, message, ...(details !== undefined ? { details } : {}) });

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
/** Exported only so the timeout-degrade regression test can reach it directly;
 *  composing that case through decide() would need the whole registry. */
export async function personCached(
  linkedin: string,
  ledger: ReturnType<typeof newLedger>
): Promise<{ person: Awaited<ReturnType<typeof personByLinkedIn>>["person"]; timedOut: boolean }> {
  const storage = getStorage();
  const key = `person:${normalizeLinkedIn(linkedin) ?? linkedin.trim().toLowerCase()}`;
  const hit = (await storage.cacheGet(key, "fundable")) as { person: unknown } | null;
  if (hit && typeof hit === "object" && "person" in hit) {
    return { person: hit.person as never, timedOut: false };
  }

  let person: Awaited<ReturnType<typeof personByLinkedIn>>["person"];
  try {
    ({ person } = await personByLinkedIn(linkedin, ledger));
  } catch (e) {
    // `LEG_TIMEOUT_MS.fundable` is documented as degrading to "not resolved",
    // and until this catch existed it did not. /people is 19s cold against an
    // 8s cap, so the FIRST request for any uncached person escaped as a 502 and
    // the caller lost the whole lead over a lookup it can survive without. The
    // live contract check caught it the moment prod ran on an empty cache
    // (2026-08-18) — two costly cases, both the ones that pass a linkedin_url.
    //
    // Degrading is safe for ID-004 specifically because it is all-or-nothing:
    // without the profile we take no title, no company, and no employer from
    // it, so there is nothing to conflict with and nothing to personalize
    // wrongly. The lead falls back to the email-domain research path that a
    // lead with no LinkedIn already takes.
    //
    // Only OUR deadline degrades. A FundableError — a dead key, a 4xx — is a
    // real misconfiguration and must still surface as a 502. Nothing is cached
    // here either: a timeout is not an answer about this person.
    if (e instanceof DeadlineError) return { person: null, timedOut: true };
    throw e;
  }

  await storage.cacheSet(key, "fundable", { person: person ?? null }, PERSON_TTL_MS);
  return { person, timedOut: false };
}

export async function decide(input: {
  email: string;
  messageType: MessageType;
  /** Resolved catalog template; null when the caller sent raw email_template. */
  template: TemplateEntry | null;
  /** The caller's own template text (already structurally validated), or null. */
  rawTemplate: string | null;
  linkedin: string | undefined;
  /** Both mandatory as of 2026-08-16 — the route rejects a lead without them. */
  firstName: string;
  lastName: string;
  /** The PERSON's location ("Vancouver, BC"), not a sales territory. Only the
   *  find-LinkedIn cascade reads it, to tell two people of the same name apart;
   *  it never reaches the composer. */
  location: string | undefined;
  knownFields: Record<string, unknown>;
  additionalContext: Record<string, unknown>;
  deadlineAt: number;
  fundable: ReturnType<typeof newLedger>;
  exa: ExaLedger;
  trace: Trace;
  /** How far to run. Defaults to the full pipeline for callers predating it. */
  stopAt?: StopAt;
}): Promise<Decision> {
  const { email, messageType, template, rawTemplate, deadlineAt, fundable, exa, trace } = input;
  const { firstName, lastName, location } = input;
  const stopAt: StopAt = input.stopAt ?? "email";
  trace.stopAt = stopAt;
  const fullName = `${firstName} ${lastName}`;
  let linkedin = input.linkedin;
  const kf = input.knownFields;
  const ctxIn = input.additionalContext;

  // ---- identity (ID-001..004) ----------------------------------------------
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
  // Not started for stop_at="linkedin": that mode returns before classification,
  // so the research would be an Exa charge nobody reads and a floating promise
  // whose rejection has no handler once we have returned.
  const researchTask = preTarget && stopAt !== "linkedin" ? startResearch(preTarget, exa) : undefined;

  if (linkedin) {
    const tIdentity = Date.now();
    const { person, timedOut } = await personCached(linkedin, fundable);
    trace.identity = Date.now() - tIdentity;
    trace.identityTimedOut = timedOut;
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
        return fail(
          409,
          "IDENTITY_CONFLICT",
          `Email domain "${emailDomain}" conflicts with the LinkedIn profile's current employer "${employerDomain}". Failing closed rather than personalizing for the wrong identity.`
        );
      }
      // For a personal address the profile's employer is the best evidence we
      // have — better than the caller's assertion, and far better than a name.
      if (employerDomain && isFreemail(emailDomain)) researchDomain = employerDomain;
    }
  } else {
    // Step 1 of Jacob's flow: no LinkedIn, so go find one. Skipped entirely
    // when the caller supplied a URL, which both live surfaces do.
    //
    // No personCached follow-up on the resolved URL. The cascade already
    // returns the title and company that lookup would have supplied, and
    // spending another 8s leg plus a Fundable credit to re-learn a fact we are
    // holding would be the whole latency budget for nothing.
    const tResolve = Date.now();
    const found = await resolveLinkedIn({ email, firstName, lastName, location, deadlineAt });
    trace.identity = Date.now() - tResolve;
    if (found) {
      linkedin = found.linkedin_url;
      trace.linkedinSource = found.source;
      // Gap-filling only: the caller's own assertion still wins, because they
      // know their lead and the cascade is inferring.
      title = title ?? found.title;
      company = company ?? found.company;
    }
  }

  if (stopAt === "linkedin") {
    return { ok: true, success: { full_name: fullName, email, linkedin_url: linkedin ?? null }, usage: [], warnings: [] };
  }

  // ---- classification -------------------------------------------------------
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

  if (stopAt === "icp") {
    return {
      ok: true,
      success: { full_name: fullName, email, linkedin_url: linkedin ?? null, icp: cls.label, icp_use_cases: useCases },
      usage: cls.usage,
      warnings: cls.warnings,
    };
  }

  // ---- compose (GEN-001..009, CTX-001..004) ---------------------------------
  // Context is typed and allowlisted (CTX-001): unknown keys are ignored, and
  // nothing here can override policy because policy never reads it.
  const ctx: ComposeContext = {
    first_name: firstName,
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
    if (issues.length) return fail(502, "OUTPUT_VALIDATION_FAILED", "Generic fallback failed validation.", issues);
    emailBody = b;
    trace.bodySource = "generic_fallback";
  } else if (template) {
    const { body: b, issues } = composeFromTemplate({ template, useCases, ctx });
    if (issues.length) return fail(502, "OUTPUT_VALIDATION_FAILED", "Composed body failed validation.", issues);
    emailBody = b;
    trace.bodySource = "catalog_template";
  } else {
    // Raw email_template: same variable/claim/privacy policies as catalog copy.
    const raw = rawTemplate ?? "";
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
    if (issues.length) return fail(422, "TEMPLATE_VALIDATION_FAILED", "email_template failed validation.", issues);

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
      return fail(422, "UNSUPPORTED_CLAIM", "email_template produced claims outside the approved set.", verdicts);
    }
    emailBody = b;
    trace.bodySource = "caller_template";
  }

  const finalIssues = validateEmailBody(emailBody);
  if (finalIssues.length) {
    return fail(502, "OUTPUT_VALIDATION_FAILED", "Final body failed validation.", finalIssues);
  }

  // ---- success: EXACTLY six keys (API-003) ----------------------------------
  return {
    ok: true,
    success: {
      full_name: fullName,
      email,
      // Either the caller's URL or the one the cascade approved — never a
      // candidate it rejected, and null when neither exists.
      linkedin_url: linkedin ?? null,
      icp: cls.label,
      icp_use_cases: useCases,
      email_body: emailBody,
    },
    usage: cls.usage,
    warnings: cls.warnings,
  };
}
