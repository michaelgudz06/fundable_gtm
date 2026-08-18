/**
 * The `pz_log` row `/api/v1/personalize` writes, and the per-request trace it
 * is built from.
 *
 * Lifted out of the route file ahead of Jacob's v2 asks, which add a stage,
 * three run modes and a review decision to a handler that was already 520 lines.
 */

import { MODEL_PLAN } from "@fundable/shared";

import type { getStorage } from "../storage";
import { CLASSIFIER_PROMPT_VERSION } from "./classify";
import { REGISTRY_VERSIONS } from "./registry";

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
};

/** A trace with every leg at zero — one per request, mutated as stages finish. */
export function newTrace(): Trace {
  return {
    identity: 0,
    research: 0,
    model: 0,
    bodySource: "none",
    classification: "none",
    agreement: "",
    modelServed: "",
    useCaseType: "none",
    linkedinSource: "",
    identityTimedOut: false,
  };
}

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
export async function record(
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
      // 'email' because that is what this route produces — the response key is
      // literally `email_body`. This said "v1/personalize" until 2026-08-16,
      // which is a route name, not a channel, and failed pz_log's CHECK on every
      // single insert. The route is recorded in `evidence.route` below instead.
      channel: "email",
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
          route: "v1/personalize",
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
