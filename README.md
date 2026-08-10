# Fundable ICP Personalization API

One decision layer for signup, website visitors, Resend follow-ups and cold
outbound: identity in, one ICP + up to three use cases + one plain-text email
body out. It sends nothing. Built to [`docs/SPEC-v2.md`](docs/SPEC-v2.md).

Live: `https://personalize-api-umber.vercel.app` · built by Michael Gudz.

---

## The contract

```
POST /api/v1/personalize      Authorization: Bearer <PERSONALIZE_API_KEY>
```

```jsonc
{
  "email": "reed@example-cre.com",
  "linkedin_url": "https://www.linkedin.com/in/...",
  "message_type": "website_visitor",         // | signup_paid | signup_unpaid | cold_outbound | nurture
  "template_id": "website_visitor_use_case", // XOR email_template
  "known_fields": {
    "first_name": "Reed",
    "title": "VP, Investment Sales",         // the field that decides whether this works
    "company_name": "Example CRE",
    "company_domain": "example-cre.com"      // used when the address is personal
  },
  "additional_context": {
    "sender_name": "Jacob",
    "territory": "Bay Area",
    "target_buyer_role": "COO",
    "product_context": "what you sell",       // required by ICP #5, #16, #20
    "investor_connection": true               // required for relationship_leverage
  }
}
```

Success is **exactly three keys** — `icp`, `icp_use_cases`, `email_body`.
`Not Core ICP` returns an empty use-case list and the approved generic body,
never an error.

### Headers worth logging

| header | why |
|---|---|
| `X-Icp-Registry-Version` + 3 more | pins an answer to the data that produced it |
| `X-Body-Source` | `caller_template` \| `catalog_template` \| `generic_fallback` — a Not Core lead silently gets the generic even if you supplied your own template |
| `X-Classifier-Agreement` | `3/3` or `2/3` — route `2/3` to human review |
| `X-Classification` | `fresh` \| `cached` |
| `X-Use-Case-Type` | `alert` \| `mcp` \| `deferred` \| `none` |
| `X-Handler-Ms`, `X-Stage-Ms` | our time vs the platform's, and which upstream leg spent it |

### Which errors are verdicts

| status | do |
|---|---|
| `409 IDENTITY_CONFLICT` | **stop** — do not fall back to generic, you don't know who this is |
| `400` / `422` | your request or template is wrong; retrying won't help |
| `502` | a dependency failed. **Not** a classification. Retry with backoff |
| `429` | back off; `Retry-After` is set |

Also: `POST /api/classify` — same registry, but returns the reasoning, the path
taken, and the HubSpot picklist value.

---

## Running it

```bash
npm run verify     # typecheck every workspace + 121 offline tests + build
npm test           # offline only
npm run dev        # localhost:3111
```

Live suites (need a deployment and real upstream spend):

```bash
npx tsx scripts/contract-check.ts                     # 26 API-behaviour cases
npx tsx scripts/run-testset.ts                        # 29 hand-labelled rows
npx tsx scripts/run-icp-benchmark.ts --csv <export>   # accuracy vs a labelled export
npx tsx scripts/evaluate-gold-set.ts                  # macro-F1 vs the frozen baseline
npx tsx scripts/debug-classify.ts --preset cre        # why did THIS lead get THAT label
```

---

## Editing behaviour

Most of what you'd want to change is **JSON, not code**:

| to change | edit |
|---|---|
| who qualifies as an ICP | `config/registry/icp_registry.json` (`roles`, `company`, `evidence_gate`) |
| the use cases offered | `config/registry/use_case_catalog.json` |
| the email frames | `config/registry/message_template_catalog.json` |
| what may be claimed | `config/registry/approved_claims.json` |

**Bump the file's `version` after editing.** Labels are cached against it; an
edit without a bump keeps serving old answers for 30 days. The registries
validate at module load, so a malformed edit fails the build rather than a
request.

The classifier's system prompt is *built* from the registry
([`classify.ts`](apps/api/src/lib/v2/classify.ts)) — only the framing and output
format are English in the TypeScript. The two Exa research questions live in
[`icp.ts`](packages/fundable-shared/src/icp.ts) and are load-bearing: rewording
the first one moved CRE recall from 1/15 to 8/15.

---

## Known limits

- **A caller's own `email_template` text is not claim-checked.** `approved_claims`
  is fail-closed for *catalog* copy; text you supply is yours, by design.
- **The rate limit is per-instance and in-memory.** A guard rail, not a quota.
- **Suppression, sending and visitor identification are not ours.** The API has
  no idea who is already a customer.
- **The accept path is input-bound.** 12% core recall without a job title, 61%
  with title and company — see [`docs/WORKFLOW.md`](docs/WORKFLOW.md).

## Where things are

| | |
|---|---|
| [`docs/WORKFLOW.md`](docs/WORKFLOW.md) | visitor → email, end to end, with the measured numbers |
| [`docs/TESTSET.md`](docs/TESTSET.md) | the 29-row acceptance run and what it does *not* prove |
| [`docs/SPEC-v2.md`](docs/SPEC-v2.md) | the spec this is built to |
| [`FINDINGS.md`](FINDINGS.md) | 9 reproducible defects in the upstream Fundable API |
| [`PRD.md`](PRD.md) · [`BUILD_LOG.md`](BUILD_LOG.md) | **history** — the v1 personalizer (`/api/personalize`, still in the tree) and its build log |
| [`AGENTS.md`](AGENTS.md) | the rules every agent session in this repo must follow |
