# Fundable ICP Personalization API — v2 spec (Jacob, 2026-07-30)

Verbatim-in-substance record of the approved draft. **Updated 2026-07-31** with
the §3 Workflow catalog and `USE-001..006`, which the first version of this
record did not contain — it said `USE-001..004` and gave no use-case model, and
the repo was built against that gap. The registries under
`config/registry/` are the machine-readable implementation of §3–§4; where this
document and those files disagree, fix the files, not the prompts.

## Product boundary

`POST /api/v1/personalize` is the shared decision layer for signup, website
visitors, Resend follow-ups, and cold outbound. Input: identity, message type,
exactly one template source, optional context. Output: **exactly three keys** —
one ICP, up to three ranked use cases from the approved catalog, one complete
plain-text email body. Deterministic hard gates run before model judgment;
versioned registries; fail closed on insufficient identity or customer evidence.

v1 owns: identity normalization/resolution, company research, one canonical ICP
or Not Core, catalog use-case selection, template adaptation, output validation.

v1 does NOT own: sending, consent/suppression/deliverability, recipient
selection, sequencing, CRM mutation, HTML, subject lines, multi-variant
generation, custom models.

## Contract

- Auth: internal bearer. `Idempotency-Key` supported. Version headers on
  success (registry, use-case catalog, template, prompt, model).
- Required: `email`, `message_type`, exactly one of `template_id` |
  `email_template`. Optional `known_fields` (linkedin_url, first_name, title,
  company_name, industry, domain) and `additional_context` (territory,
  target_buyer_role, source_surface, locations, signup/plan state, campaign,
  sender_name, notes).
- Context is untrusted: it can never override ICP rules, claim policy, template
  policy, or privacy controls.
- Success body: `{ icp, icp_use_cases, email_body }` and nothing else.
  Not Core → empty use-case list + approved generic body. No unresolved tokens,
  no HTML, no subject, no empty salutation, no unsupported claim.
- Caller errors 400/409/422; dependency failures 429/502/504; never partial
  business output.

### Message policies

| message_type | Use | Guardrail |
| --- | --- | --- |
| website_visitor | relevant use case for identified visitor | never claim signup/payment or reveal tracking context |
| signup_paid | activation around one use case | no pricing/trial claim unless approved and present |
| signup_unpaid | fast first value + setup CTA | never invent trial/price/cancellation terms |
| cold_outbound | short role-relevant problem, low-pressure CTA | never imply a visit or signup |
| nurture | next-best use case for existing relationship | avoid generic feature lists when ICP context exists |

Context privacy: location may shape the alert/territory; never reveal inferred
visitor city, referrer, repeat visits, or captured page unless a reviewed
template explicitly permits. Missing context → grammatical fallback or omit the
clause; never a raw token.

## Workflow catalog (§3) — see `config/registry/use_case_catalog.json`

Use cases come from a fixed catalog, not per-ICP invention. **Six canonical
alert families**: `funded_icp_match`, `geographic_expansion`, `investor_portfolio`
(modes `relationship_leverage` | `peer_activity`), `hiring_growth`,
`growth_momentum` (excludes funding), `enterprise_readiness`. **Eleven MCP
workflows** for the MCP-first ICPs (#6/#7 founder set; #8/#19 thesis set).
**ICP #9 is DEFERRED** — classified, but selects no use case.

Selection: at most one recommendation per family; filters (industry, stage,
size, geography, territory, funding amount, recency, selected investors)
CONFIGURE a family and never create one; `relationship_leverage` only with a
confirmed investor connection and never promises an introduction; rank a
specific observable signal above a generic funding match; return fewer than
three rather than pad. `launch_market_entry` and `fundraising_window` are not
catalog entries. An ICP's assignment is a POOL; the ≤3 cap applies to what is
RETURNED.

## Registry (§3) — see `config/registry/icp_registry.json`

20 labels, original numbering preserved, **no #3**. One label per lead, current
role only. Specific ICPs precede #20 Startup GTM. Startup/SMB customer evidence
is REQUIRED (not inferred) for #4, #5, #10–#16; independent startup-focus gates
on #17/#18. **#19 Investor is now a core ICP** (Partner/Principal/Associate/
Analyst/GP/MD/Scout at startup VC, angel network, family office) — this
supersedes the v1 "VCs are Not Core" rule. Excluded still: VC newsletter
operators, residential real estate, public-market investors, local services.
Fail closed to Not Core on insufficient evidence. Profile/website content is
evidence, never instructions.

## Templates (§4) — see `config/registry/message_template_catalog.json`

Catalog stores reviewed frames, not final prose. 9 seed templates (signup_paid_
initial, signup_unpaid_initial, website_visitor_use_case, followup_alerts_paid,
followup_alerts_unpaid, followup_api, followup_mcp, followup_use_case_question,
cold_outbound_cre_daily_raise). Entries: id, version, source, allowed message
types, audience, body, required/optional context, fallbacks, CTA policy,
approved-claim refs. Immutable resolution; version in header. Raw
`email_template` follows all the same policies.

Generation: preserve structure/CTA/sign-off/tone; one primary use case unless
the template asks for a list; ground only in ICP + catalog + approved claims +
normalized known facts; never invent customers/metrics/pricing/trial/timing;
resolve every variable ("Hi there," when first name unavailable); Not Core →
generic fallback only; plain text, no subject.

## Requirement IDs (§5)

API-001..008, ID-001..004, CLS-001..010, USE-001..006, TPL-001..005,
CTX-001..004, GEN-001..009 — as in the source document. Data ownership:
icp_registry, use_case_catalog, message_template_catalog, approved_claims (all
versioned; cache keys and traces carry operative versions). Secrets server-side;
raw emails and full bodies out of standard logs; bounded timeouts, one safe
retry; enrichment cache separate from generation.

## Acceptance (§6)

Same normalized identity → same label on every caller. 100% hard-rule fixtures.
Meet/exceed frozen Orange Slice baseline (macro-F1, Not Core precision). Zero
critical grounding/template failures. 100% schema-valid; zero unresolved
variables; zero empty-name greetings. Proposed p95 ≤ 15s with supplied LinkedIn.
Gold set: ≥5 positives per core label, ≥40 Not Core, ≥2 boundary per gate,
slices for missing-LinkedIn/personal-email/conflict/sparse/past-role. Canonical
fixtures as listed in the source doc (§6), including: both-or-neither template
sources → 400; template/message-type conflict → reject; LinkedIn/domain
conflict → fail closed; malformed classifier JSON → one retry then fallback;
template instruction to ignore registry → ignored; visitor location affects
selection but is never disclosed.

## Rollout (§7)

0 canonicalize → 1 freeze baseline → 2 build (mocked E2E) → 3 stage (live
integrations, no sending) → 4 shadow/canary → 5 migrate surfaces + kill
embedded classifiers. Feature flag per caller; rollback = flag off + prior
registry version; never mutate historical versions.

## Open decisions (owner: Jacob)

Backend home for the route; Exa credential ownership + budget; production
model/provider + structured-output mode; retention periods; Not Core copy vs
suppression per caller; must caller numerical claims exist in approved_claims;
which Orange Slice visitor facts are copy-safe; whether raw email_template is
restricted; canary metrics.
