/**
 * Versioned registries per SPEC-v2 §5 data ownership.
 *
 * Statically imported so the bundler ships them (same serverless lesson as
 * config-registry.ts), validated at module load so a malformed registry fails
 * the build rather than a request. Every response carries these versions in
 * headers, so a bad classification can be pinned to the registry that made it.
 */

import icpRegistryJson from "../../../../../config/registry/icp_registry.json";
import useCaseCatalogJson from "../../../../../config/registry/use_case_catalog.json";
import templateCatalogJson from "../../../../../config/registry/message_template_catalog.json";
import approvedClaimsJson from "../../../../../config/registry/approved_claims.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IcpEntry = {
  number: number;
  /** Taxonomy label. Appears in `icp` output and the classifier prompt — never in prose. */
  name: string;
  /** Prose form for email bodies: bare noun phrase, no article, acronyms intact. */
  email_descriptor: string;
  roles: string;
  company: string;
  evidence_gate: "none" | "startup_customers_required" | "startup_focus";
  catch_all?: boolean;
  note?: string;
};

/**
 * The six canonical alert families (SPEC §3). This list is closed: an ICP
 * configures a family with filters, it never invents one. `launch_market_entry`
 * and `fundraising_window` are named in the spec as NOT catalog entries and are
 * rejected at build time below.
 */
export const ALERT_FAMILIES = [
  "funded_icp_match",
  "geographic_expansion",
  "investor_portfolio",
  "hiring_growth",
  "growth_momentum",
  "enterprise_readiness",
] as const;
export type AlertFamily = (typeof ALERT_FAMILIES)[number];

const FORBIDDEN_FAMILIES = ["launch_market_entry", "fundraising_window"];

/** `investor_portfolio` does two different jobs and must say which. */
export type PortfolioMode = "relationship_leverage" | "peer_activity";

/**
 * What a caller knows that can make a use case selectable.
 *
 * The old selector was `useCasesFor(icpNumber)` — a static slice with no way to
 * see context, so none of the spec's conditional rules could be expressed:
 * `relationship_leverage` only when an investor connection is confirmed,
 * "product and buyer context required" for #5/#16/#20, and "return fewer than
 * three rather than pad".
 */
export type UseCaseContext = {
  investor_connection?: boolean;
  product_context?: string | undefined;
  target_buyer_role?: string | undefined;
  territory?: string | undefined;
};

export type AlertUseCase = {
  id: AlertFamily;
  workflow_type: "alert";
  name: string;
  why_relevant: string;
  example_alert: string;
  configuration: {
    family: AlertFamily;
    portfolio_mode?: PortfolioMode;
    filters?: Record<string, string>;
  };
};

export type McpUseCase = {
  id: string;
  workflow_type: "mcp";
  name: string;
  why_relevant: string;
  example_prompt: string;
  configuration: { workflow: string };
};

/** USE-005: a caller must be able to tell an alert from an MCP workflow. */
export type UseCase = AlertUseCase | McpUseCase;

export const MESSAGE_TYPES = [
  "website_visitor",
  "signup_paid",
  "signup_unpaid",
  "cold_outbound",
  "nurture",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export type TemplateEntry = {
  id: string;
  version: string;
  source: string;
  allowed_message_types: MessageType[];
  audience: string;
  required_context: string[];
  optional_context: string[];
  cta_policy: string;
  claim_refs: string[];
  body: string;
  /**
   * Alternative frames for leads whose primary use case is not an alert.
   * `body` remains the alert frame; these cover the MCP-first ICPs and the
   * case where no use case was selected at all (deferred #9, or every entry
   * dropped for missing context).
   */
  body_variants?: { mcp?: string; none?: string };
};

export type Claim = {
  id: string;
  status: "approved" | "pending_review";
  text: string;
  kind: string;
  source: string;
};

// ---------------------------------------------------------------------------
// Load + validate once
// ---------------------------------------------------------------------------

function fail(msg: string): never {
  throw new Error(`Registry validation failed: ${msg}`);
}

export type ExclusionCheck = {
  id: string;
  applies_to: number[];
  evidence_pattern: string;
  reason: string;
};

const icpRegistry = icpRegistryJson as {
  version: string;
  cross_cutting_rules: string[];
  icps: IcpEntry[];
  not_core: { name: string };
  exclusion_checks?: ExclusionCheck[];
};

if (!icpRegistry.icps?.length) fail("icp_registry has no icps");
if (icpRegistry.icps.some((i) => i.number === 3)) fail("there is intentionally no ICP #3");
if (!icpRegistry.icps.some((i) => i.number === 19)) fail("ICP #19 Investor missing");
if (!icpRegistry.icps.some((i) => i.catch_all)) fail("no catch-all (#20) defined");
{
  const nums = icpRegistry.icps.map((i) => i.number);
  if (new Set(nums).size !== nums.length) fail("duplicate ICP numbers");
}
for (const i of icpRegistry.icps) {
  // Prose descriptors are a build-time contract, not a nice-to-have: the
  // composer inflects the article itself, so a descriptor that carries its own
  // article ("an investing team") would compose to "a an investing team".
  // Trim first: the guards below describe the string the composer will USE, and
  // " an investing team" would otherwise slip past both and compose to "a an …".
  const descriptor = i.email_descriptor?.trim();
  if (!descriptor) fail(`ICP #${i.number} has no email_descriptor`);
  if (/^(a|an|the)\s/i.test(descriptor)) {
    fail(`ICP #${i.number} email_descriptor must not begin with an article: "${descriptor}"`);
  }
  if (/[.!?]$/.test(descriptor)) fail(`ICP #${i.number} email_descriptor must not be a sentence`);
  i.email_descriptor = descriptor;
}

// Exclusion patterns are compiled once, at load, so a malformed regex fails the
// build rather than throwing inside a request.
const EXCLUSIONS: { check: ExclusionCheck; re: RegExp }[] = (icpRegistry.exclusion_checks ?? []).map((check) => {
  if (!check.id || !check.applies_to?.length || !check.evidence_pattern || !check.reason) {
    fail(`exclusion check "${check.id}" is missing a required field`);
  }
  for (const n of check.applies_to) {
    if (!icpRegistry.icps.some((i) => i.number === n)) {
      fail(`exclusion check "${check.id}" targets unknown ICP #${n}`);
    }
  }
  try {
    return { check, re: new RegExp(check.evidence_pattern, "i") };
  } catch (e) {
    return fail(`exclusion check "${check.id}" has an invalid pattern: ${(e as Error).message}`);
  }
});

/**
 * Does the RESEARCH EVIDENCE disqualify this label?
 *
 * The cross-cutting exclusions — residential real estate, VC newsletter
 * operators, public-market investors, local services — were prompt prose, which
 * means "residential broker -> Not Core" rested entirely on the model choosing
 * to apply a rule it had been told. This checks the ones that are checkable.
 *
 * Deliberately reads ONLY research evidence. Matching caller-supplied fields
 * would let a caller force a rejection by writing the right words into a company
 * name, which is the mirror image of the injection this codebase already blocks.
 */
export function exclusionFor(icpNumber: number | null, evidence: string): ExclusionCheck | null {
  if (icpNumber === null || !evidence.trim()) return null;
  for (const { check, re } of EXCLUSIONS) {
    if (check.applies_to.includes(icpNumber) && re.test(evidence)) return check;
  }
  return null;
}

/** Exposed for tests: the compiled checks, so coverage can be asserted. */
export function exclusionChecks(): ExclusionCheck[] {
  return EXCLUSIONS.map((e) => e.check);
}

type AlertAssignment = {
  family: AlertFamily;
  why_relevant: string;
  example_alert: string;
  portfolio_mode?: PortfolioMode;
  requires_context?: string[];
  filters?: Record<string, string>;
};
type McpAssignment = { workflow: string; why_relevant: string; requires_context?: string[] };
type Assignment = AlertAssignment | McpAssignment;

const useCaseCatalog = useCaseCatalogJson as {
  version: string;
  alert_families: Record<string, { name: string; definition: string; excludes: string }>;
  mcp_workflows: Record<string, { name: string; example_prompt: string }>;
  assignments: Record<string, { mode: "alert_first" | "mcp_first" | "deferred"; use_cases: Assignment[] }>;
};

const isAlert = (a: Assignment): a is AlertAssignment => "family" in a;

// --- catalog integrity (USE-001..006) ---------------------------------------
for (const f of ALERT_FAMILIES) {
  if (!useCaseCatalog.alert_families[f]) fail(`alert family "${f}" missing from the catalog`);
}
for (const f of Object.keys(useCaseCatalog.alert_families)) {
  if (!(ALERT_FAMILIES as readonly string[]).includes(f)) fail(`unknown alert family "${f}"`);
}
for (const f of FORBIDDEN_FAMILIES) {
  if (useCaseCatalog.alert_families[f]) fail(`"${f}" is explicitly not a catalog entry (SPEC §3)`);
}

for (const icp of icpRegistry.icps) {
  const a = useCaseCatalog.assignments[String(icp.number)];
  if (!a) fail(`no assignment for ICP #${icp.number}`);

  if (a.mode === "deferred") {
    // USE-006: #9 is classified but selects no use case. An empty list used to
    // fail the BUILD, which is why the deferral could not be expressed at all.
    if (a.use_cases.length) fail(`ICP #${icp.number} is deferred but lists use cases`);
    continue;
  }
  if (!a.use_cases.length) fail(`ICP #${icp.number} has no use cases and is not deferred`);

  // USE-003: at most ONE recommendation per family. Enforced on the POOL, so a
  // duplicate can never reach the selector in the first place.
  const families = a.use_cases.filter(isAlert).map((u) => u.family);
  if (new Set(families).size !== families.length) {
    fail(`ICP #${icp.number} lists the same alert family twice (USE-003)`);
  }

  for (const u of a.use_cases) {
    if (!u.why_relevant) fail(`ICP #${icp.number} use case missing why_relevant`);
    if (isAlert(u)) {
      if (!(ALERT_FAMILIES as readonly string[]).includes(u.family)) {
        fail(`ICP #${icp.number} references unknown family "${u.family}"`);
      }
      if (!u.example_alert) fail(`ICP #${icp.number}/${u.family} missing example_alert`);
      if (u.family === "investor_portfolio" && !u.portfolio_mode) {
        fail(`ICP #${icp.number} uses investor_portfolio without a portfolio_mode`);
      }
      if (u.family !== "investor_portfolio" && u.portfolio_mode) {
        fail(`ICP #${icp.number}/${u.family} sets portfolio_mode, which only investor_portfolio has`);
      }
      // "growth_momentum excludes funding" is a definition, so it is checked
      // against the copy that will actually be read, not just asserted in prose.
      if (u.family === "growth_momentum" && /\b(rais(e|ed|ing)|funding|round|series [a-d])\b/i.test(u.example_alert)) {
        fail(`ICP #${icp.number}/growth_momentum example mentions funding, which the family excludes`);
      }
      // relationship_leverage must never promise an introduction.
      if (/\bwarm intro|introduction\b/i.test(u.example_alert)) {
        fail(`ICP #${icp.number}/${u.family} promises an introduction`);
      }
    } else {
      if (!useCaseCatalog.mcp_workflows[u.workflow]) {
        fail(`ICP #${icp.number} references unknown MCP workflow "${u.workflow}"`);
      }
    }
  }
}

const templateCatalog = templateCatalogJson as {
  version: string;
  greeting_fallback: string;
  generic_fallbacks: Record<MessageType, string>;
  templates: TemplateEntry[];
};
if (!templateCatalog.templates?.length) fail("template catalog empty");
for (const mt of MESSAGE_TYPES) {
  if (!templateCatalog.generic_fallbacks[mt]) fail(`no generic fallback for ${mt}`);
}
{
  const ids = templateCatalog.templates.map((t) => t.id);
  if (new Set(ids).size !== ids.length) fail("duplicate template ids");
}

const approvedClaims = approvedClaimsJson as { version: string; claims: Claim[] };
for (const t of templateCatalog.templates) {
  for (const ref of t.claim_refs) {
    const claim = approvedClaims.claims.find((c) => c.id === ref);
    if (!claim) fail(`template ${t.id} references unknown claim ${ref}`);
    // Fail-closed at BUILD time: a template may not reference an unapproved claim.
    if (claim.status !== "approved") {
      fail(`template ${t.id} references claim ${ref} with status ${claim.status}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const REGISTRY_VERSIONS = {
  icp_registry: icpRegistry.version,
  use_case_catalog: useCaseCatalog.version,
  template_catalog: templateCatalog.version,
  approved_claims: approvedClaims.version,
} as const;

export function icpEntries(): IcpEntry[] {
  return icpRegistry.icps;
}

export function crossCuttingRules(): string[] {
  return icpRegistry.cross_cutting_rules;
}

/** Canonical output label: "ICP #2: CRE Broker" | "Not Core ICP". */
export function icpLabel(number: number | null): string {
  if (number === null) return "Not Core ICP";
  const e = icpRegistry.icps.find((i) => i.number === number);
  return e ? `ICP #${e.number}: ${e.name}` : "Not Core ICP";
}

export function icpByNumber(number: number): IcpEntry | null {
  return icpRegistry.icps.find((i) => i.number === number) ?? null;
}

/** The prose form for email copy. Never use `name` in a sentence. */
export function icpDescriptor(number: number | null): string | null {
  if (number === null) return null;
  return icpByNumber(number)?.email_descriptor ?? null;
}

/** True when the caller supplied everything an entry says it needs. */
function contextSatisfied(required: string[] | undefined, ctx: UseCaseContext): boolean {
  if (!required?.length) return true;
  return required.every((key) => {
    if (key === "investor_connection") return ctx.investor_connection === true;
    if (key === "product_context") return !!ctx.product_context?.trim();
    if (key === "target_buyer_role") return !!ctx.target_buyer_role?.trim();
    if (key === "territory") return !!ctx.territory?.trim();
    return false; // an unknown requirement is never satisfied — fail closed
  });
}

/**
 * Deterministic selection (USE-001..006).
 *
 * The catalog's per-ICP list is a POOL in the spec's own ranked order, not the
 * answer. This applies the rules the spec states and nothing else:
 *
 *  - a deferred ICP (#9) and Not Core both select nothing
 *  - an entry whose required context is missing is DROPPED, not substituted —
 *    "return fewer than three rather than pad"
 *  - at most one per family (already guaranteed on the pool, re-checked here so
 *    the invariant holds even if the two ever drift)
 *  - at most three, in catalog order, which is the spec's ranking: a specific
 *    observable signal is listed above the generic funding match wherever §3
 *    puts it there
 *
 * No model is involved, so the same lead and the same context always produce the
 * same list.
 */
export function useCasesFor(icpNumber: number | null, ctx: UseCaseContext = {}): UseCase[] {
  if (icpNumber === null) return [];
  const assignment = useCaseCatalog.assignments[String(icpNumber)];
  if (!assignment || assignment.mode === "deferred") return [];

  const out: UseCase[] = [];
  const seenFamilies = new Set<AlertFamily>();

  for (const entry of assignment.use_cases) {
    if (out.length >= 3) break;
    if (!contextSatisfied(entry.requires_context, ctx)) continue;

    if (isAlert(entry)) {
      if (seenFamilies.has(entry.family)) continue;
      seenFamilies.add(entry.family);
      const family = useCaseCatalog.alert_families[entry.family]!;
      out.push({
        id: entry.family,
        workflow_type: "alert",
        name: family.name,
        why_relevant: entry.why_relevant,
        example_alert: entry.example_alert,
        configuration: {
          family: entry.family,
          ...(entry.portfolio_mode ? { portfolio_mode: entry.portfolio_mode } : {}),
          ...(entry.filters ? { filters: entry.filters } : {}),
        },
      });
    } else {
      const workflow = useCaseCatalog.mcp_workflows[entry.workflow]!;
      out.push({
        id: entry.workflow,
        workflow_type: "mcp",
        name: workflow.name,
        why_relevant: entry.why_relevant,
        example_prompt: workflow.example_prompt,
        configuration: { workflow: entry.workflow },
      });
    }
  }
  return out;
}

/** Whether an ICP is classified but deliberately selects no use case (USE-006). */
export function isDeferred(icpNumber: number | null): boolean {
  return icpNumber !== null && useCaseCatalog.assignments[String(icpNumber)]?.mode === "deferred";
}

export function getTemplate(id: string): TemplateEntry | null {
  return templateCatalog.templates.find((t) => t.id === id) ?? null;
}

export function genericFallback(mt: MessageType): string {
  return templateCatalog.generic_fallbacks[mt];
}

export function greetingFallback(): string {
  return templateCatalog.greeting_fallback;
}

export function approvedClaimTexts(refs: string[]): string[] {
  return approvedClaims.claims
    .filter((c) => refs.includes(c.id) && c.status === "approved")
    .map((c) => c.text);
}
