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

export type UseCase = {
  id: string;
  name: string;
  why_relevant: string;
  example_alert: string;
};

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

const icpRegistry = icpRegistryJson as {
  version: string;
  cross_cutting_rules: string[];
  icps: IcpEntry[];
  not_core: { name: string };
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

const useCaseCatalog = useCaseCatalogJson as {
  version: string;
  use_cases: Record<string, UseCase[]>;
};
for (const icp of icpRegistry.icps) {
  const ucs = useCaseCatalog.use_cases[String(icp.number)];
  if (!ucs?.length) fail(`no use cases for ICP #${icp.number}`);
  if (ucs.length > 3) fail(`ICP #${icp.number} has more than 3 use cases (USE-003)`);
  for (const u of ucs) {
    if (!u.id || !u.name || !u.why_relevant || !u.example_alert) {
      fail(`ICP #${icp.number} use case missing a required field (USE-002)`);
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

/** Deterministic, primary-first, max three (USE-001..003). */
export function useCasesFor(icpNumber: number | null): UseCase[] {
  if (icpNumber === null) return [];
  return (useCaseCatalog.use_cases[String(icpNumber)] ?? []).slice(0, 3);
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
