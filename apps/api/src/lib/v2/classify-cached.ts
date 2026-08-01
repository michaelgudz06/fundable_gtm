/**
 * The one place a label is decided.
 *
 * This existed inside the personalize route, which meant /api/classify — the
 * endpoint whose entire purpose is "the same person gets the same ICP
 * everywhere" — re-voted on every call. Borderline leads are genuinely
 * uncertain (measured: 7 of 10 CRE leads returned a different label across
 * three identical runs before voting and caching existed), so an uncached
 * surface can disagree with the cached one AND with itself.
 *
 * Both routes now go through here. The cache is keyed on the evidence and on
 * every version that can change the answer, so:
 *
 *   - same identity + same evidence -> byte-identical label, on every surface
 *   - change a registry, a catalog, the model, the research question or the
 *     vote count, and every affected lead is reclassified
 *   - change nothing, and the answer cannot drift
 */

import { createHash } from "node:crypto";

import { normalizeEmail, MODEL_PLAN, type ExaLedger } from "@fundable/shared";

import { getStorage } from "../storage";
import { classifyV2, CLASSIFIER_DECISION_VERSION, type ResearchTask, type V2Classification } from "./classify";
import { REGISTRY_VERSIONS } from "./registry";

const CLASSIFICATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Every version that can change an answer, in one string.
 *
 * A key carrying only the ICP registry left four other levers unversioned: swap
 * the model, reword the research question, or edit the use-case, template or
 * claims catalogs, and 30 days of cached verdicts keep being served as if
 * nothing moved.
 */
export function registryFingerprint(): string {
  return [
    REGISTRY_VERSIONS.icp_registry,
    REGISTRY_VERSIONS.use_case_catalog,
    REGISTRY_VERSIONS.template_catalog,
    REGISTRY_VERSIONS.approved_claims,
    MODEL_PLAN,
  ].join("|");
}

export function classificationKey(input: {
  email: string;
  title?: string | undefined;
  company?: string | undefined;
  companyDomain?: string | undefined;
}): string {
  const material = [
    normalizeEmail(input.email),
    (input.title ?? "").trim().toLowerCase(),
    (input.company ?? "").trim().toLowerCase(),
    (input.companyDomain ?? "").trim().toLowerCase(),
  ].join("|");
  const digest = createHash("sha256").update(material).digest("hex").slice(0, 32);
  return `cls:${registryFingerprint()}:${CLASSIFIER_DECISION_VERSION}:${digest}`;
}

type Cached = {
  icpNumber: number | null;
  label: string;
  reasoning: string;
  path: V2Classification["path"];
  agreementTop: number;
  agreementTotal: number;
};

export type CachedClassification = V2Classification & { cacheState: "fresh" | "cached" };

export async function classifyCached(
  input: {
    email: string;
    title?: string | undefined;
    company?: string | undefined;
    companyDomain?: string | undefined;
    researchTask?: ResearchTask | undefined;
    deadlineAt?: number | undefined;
  },
  exa: ExaLedger
): Promise<CachedClassification> {
  const storage = getStorage();
  const key = classificationKey(input);

  const hit = (await storage.cacheGet(key, "fundable")) as Cached | null;
  if (hit && typeof hit.label === "string") {
    return {
      icpNumber: hit.icpNumber ?? null,
      label: hit.label,
      // The reasoning is cached too: a caller that logged "why" on the first
      // call and got "cached" on the second would have an unexplainable record.
      reasoning: hit.reasoning ?? "cached",
      path: hit.path ?? "titled",
      usage: [],
      warnings: [],
      timings: { research: 0, model: 0 },
      agreement: { top: hit.agreementTop ?? 0, total: hit.agreementTotal ?? 0 },
      model: "",
      cacheState: "cached",
    };
  }

  const fresh = await classifyV2(input, exa);
  await storage.cacheSet(
    key,
    "fundable",
    {
      icpNumber: fresh.icpNumber,
      label: fresh.label,
      reasoning: fresh.reasoning,
      path: fresh.path,
      agreementTop: fresh.agreement.top,
      agreementTotal: fresh.agreement.total,
    } satisfies Cached,
    CLASSIFICATION_TTL_MS
  );
  return { ...fresh, cacheState: "fresh" };
}
