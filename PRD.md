> **Historical record.** These are the original 2026-07-27 requirements for the
> v1 personalizer (`POST /api/personalize` — person + trigger in, voice-matched
> copy + evidence out). The product was re-specified on 2026-07-30 as the v2 ICP
> decision layer: [docs/SPEC-v2.md](docs/SPEC-v2.md) is the current spec and
> [README.md](README.md) documents what shipped. Kept as the record of why this
> exists; nothing below is maintained.

# Fundable Personalization API — PRD

**Owner:** Michael Gudz · **Requested by:** Jacob Klionsky · **Date:** 2026-07-27
**Status:** Draft for approval
**One-liner:** An endpoint you hit before sending any automated email or LinkedIn
message. It takes a person and a trigger, returns copy personalized in your voice,
plus the evidence it used.

---

## 1. Why this exists

Jacob already described this product publicly, in his own words, on 2026-07-09:

> "An alert saying 'Company X raised $10M' is a helpful signal that a company is
> ready to scale. But on its own, it isn't enough to make good outbound. With
> Fundable we push our customers to build deal alerts where there is a **personal
> tie** to the company that raised... The context is helpful, but you still have to
> connect the dots to write a solid message, which takes time. So we've been giving
> customers a Claude skill that fixes the last step."

**This API is that Claude skill, productized as an endpoint.** Same last mile, but
callable from any sequencer, form handler, or workflow instead of living in a chat
session.

### Why it is not "just an Exa call"

Exa tells you what a person *said*. Fundable tells you what happened to their
*company* and who is behind it. The personal tie Jacob describes — a shared
investor, the same city, the same stage, a repeat founder — is a **join across two
datasets**, and Fundable owns the half no competitor has.

Exa alone produces the same generic personalization every competitor already ships
("saw your post about X"). Fundable-first produces the thing only Fundable can say
("Ribbit led your Series A, and they also led two of our customers").

---

## 2. Scope

### In scope (v1)

- One `POST /api/personalize` endpoint
- Resolution from email and/or LinkedIn URL
- Enrichment from Fundable (primary) and Exa (recency + long tail)
- Four trigger types: `sign-up`, `website-visitor`, `cold`, `post-raise`
- Two channels: `email`, `linkedin`
- Optional caller-supplied template, customized "on the edges"
- Evidence + confidence returned with every response
- Voice matched to Jacob from real sent examples

### Out of scope (v1)

- Sending anything. This returns copy; the caller sends it.
- Sequence/campaign management, reply handling, A/B testing
- A UI. It is an API. (A thin debug page is a stretch goal.)
- Multi-tenant voice profiles. v1 is Jacob's voice only.

### Non-goals worth stating

- **Not a data product.** It does not expose Fundable data directly; it returns prose.
- **Not a guaranteed personalizer.** When there is no honest angle it returns the
  template untouched and says so. See §7.

---

## 3. Users and use cases

| Trigger | Who fires it | What personalization should key on |
| --- | --- | --- |
| `sign-up` | Product, on new account | Their company's stage and what Fundable is useful for at that stage |
| `website-visitor` | Reverse-IP / form fill | Company-level only, no assumed intent (they did not identify themselves) |
| `cold` | Outbound sequence | The strongest personal tie available: investor overlap, city, stage, repeat founder |
| `post-raise` | Fundable deal alert | The raise itself, the lead investor, stated post-raise plans |

Jacob is the only user in v1. Design for one voice, but keep the voice in a config
file so a second one is a data change, not a refactor.

---

## 4. API contract

```http
POST /api/personalize
Authorization: Bearer <PERSONALIZE_API_KEY>
Content-Type: application/json
```

```jsonc
{
  "person": {
    "email": "eric@ramp.com",           // either is enough; both is better
    "linkedin": "https://www.linkedin.com/in/eglyman",
    "name": "Eric Glyman"               // optional, improves Exa matching
  },
  "trigger": "cold",                    // sign-up | website-visitor | cold | post-raise
  "channel": "email",                   // email | linkedin
  "template": "Hi {{first_name}},\n\n{{opener}}\n\nWe help...",  // optional
  "sender_context": "case_studies_v2",  // optional, named context block
  "max_facts": 3
}
```

### Response

```jsonc
{
  "status": "personalized",             // personalized | template_only | no_match
  "confidence": 0.82,                   // 0-1, see §7
  "subject": "Ribbit led your Series A",       // null when channel=linkedin
  "body": "Hi Eric,\n\n...",
  "angle": "investor_overlap",
  "evidence": [
    { "fact": "Ramp raised a $750M Series F on 2026-06-04",
      "source": "fundable", "endpoint": "/companies", "confidence": 1.0 },
    { "fact": "Became Co-CEO with Karim Atiyeh on 2026-06-25",
      "source": "exa", "url": "https://linkedin.com/posts/eglyman_...", "confidence": 0.9 }
  ],
  "resolved": {
    "person_id": "…", "company_id": "…",
    "company": "Ramp", "domain": "ramp.com"
  },
  "warnings": [],
  "usage": { "fundable_credits": 4, "exa_cost_usd": 0.007, "llm_tokens": 2140, "ms": 4200 }
}
```

**`evidence` is non-negotiable.** Every claim in the copy traces to a source. It is
how a human audits before send and how we debug a bad message after.

---

## 5. Pipeline

```
1. RESOLVE      email domain ──► Fundable /companies (identifiers.domains)
                linkedin URL ──► Fundable /people   (identifiers.linkedin_urls)

2. ENRICH       Fundable: /companies, /deals (history), /investors (who led)
                Exa:      recent posts, role changes, press

3. TIE          compute personal ties against sender_context
                (shared investor, same city, same stage, repeat founder)

4. ANGLE        trigger + available facts ──► pick ONE angle, max_facts facts

5. WRITE        template + facts + voice ──► copy   (DeepSeek V4 Pro)

6. VERIFY       claim check against evidence; retry once; else downgrade status
```

Steps 1-3 are deterministic. Only 5 is generative, and 6 constrains it.

---

## 6. APIs and MCPs required

### Critical distinction

**MCP servers cannot be used by this API.** MCP is a protocol for agents in a chat
session; a production HTTP route needs REST endpoints with keys. Every capability
below is therefore specified as a **REST API**. MCPs are listed separately, as
development-time tooling only.

### 6.1 Fundable REST API — primary data source

`https://www.tryfundable.ai/api/v1` · `Authorization: Bearer <FUNDABLE_API_KEY>`

| Endpoint | Use | Verified behaviour |
| --- | --- | --- |
| `POST /companies` | domain → company; funding history, stage, headcount, industries | Batch: up to 100 domains in one call. Unknown domains are **silently dropped** — diff requested vs returned |
| `POST /people` | LinkedIn URL → person; title, about, education, founder/angel/investor flags | Exact URL match required. 1 credit per person |
| `POST /deals` | round history for step-ups and velocity | Accepts `company.company_ids[]` — batch up to 50 companies in one call. Charged **per deal returned** |
| `POST /investors` | who led the round, for investor-overlap ties | Rich: `deal_count_last_12_months`, `lead_deal_count`, `top_industries` |
| `GET /industry/search` | industry name → permalink | **0 credits.** Required: bad permalinks are silently dropped |
| `GET /location/search` | city name → permalink | **0 credits.** No relevance ranking — needs the curated alias table |

**Coverage reality, measured:**
- Domain → company: **excellent.** `ramp.com` returned $3.58B total raised, Series F
  $750M (2026-06-04), headcount band, industries, description.
- LinkedIn → person: **works, conditionally.** `/in/eglyman` matched for 1 credit.
  But the people dataset skews to funded-company staff and investors — **Jacob's own
  profile is not in it.** Strong exactly where it matters (someone at a company that
  raised), thin on the long tail. This is the single biggest driver of the fallback
  design in §7.

**Cost:** ~1 credit per company, per person, and per deal returned. A typical
enrichment is 3-6 credits.

**Blocker:** the Fundable **MCP** is plan-gated on Michael's account (`requestAccess`
returns "needs Pro+ or API plan"), and separately it is the wrong transport for a
production route. **The REST API is the path and it already works.** No action needed
from Jacob unless we want the MCP's richer internal tables (angels,
`linkedin_positions`, `organization_associations`) — which would materially improve
the repeat-founder tie.

### 6.2 Exa REST API — recency and long-tail fallback

`https://api.exa.ai/search` · `x-api-key: <EXA_API_KEY>`

Verified working. `category: "people"` returned Glyman's five most recent LinkedIn
posts with dates, including the Co-CEO announcement and the $750M raise. This is the
highest-value personalization material available anywhere, and Fundable does not
have it.

**Cost:** $0.007 per neural search (measured, returned in `costDollars`).

A key already exists in `~/Developer/work/fundable/funding-radar/.env` — use the
Fundable-owned one, not the Enactus key.

### 6.3 OpenRouter — the writer

`https://openrouter.ai/api/v1/chat/completions`

| Model | Role | Price (measured) |
| --- | --- | --- |
| `deepseek/deepseek-v4-pro` | writing the copy | $0.43/M in, $0.87/M out |
| `deepseek/deepseek-v4-flash` | angle selection, cheap classification | $0.14/M in, $0.28/M out |

Set `reasoning: { enabled: false }` — V4 is a reasoning model and will otherwise burn
the whole token budget on reasoning and return null content. (Learned the hard way in
Post Studio.)

### 6.4 Optional integrations (v1.1+)

| Service | Transport | Why |
| --- | --- | --- |
| Gmail | MCP available (`create_draft`) for agent use; Gmail REST API for the service | Drop the result straight into drafts instead of returning it |
| HubSpot | REST API | Prior touches, deal stage, owner. Avoid personalizing over a live conversation |
| Vercel | Deployment | Same as Post Studio |

### 6.5 MCPs — development only

Used while building and testing, **not** in the request path:

- **Exa MCP** — exploring what enrichment is available before committing to REST calls
- **Vercel MCP** — deploys, logs, runtime errors
- **Gmail MCP** — reading Jacob's real sent emails to build the voice profile (§9)
- **Fundable MCP** — currently plan-gated; would only be for exploration

### 6.6 Cost per call

| Component | Typical | Notes |
| --- | --- | --- |
| Fundable | 3-6 credits | company + person + deals |
| Exa | $0.007 | one search, sometimes two |
| DeepSeek V4 | ~$0.003 | ~2.5k tokens in, ~400 out |
| **Total** | **< $0.02 + ~5 credits** | Cache per person to amortize |

---

## 7. The two failure modes that decide whether this ships

### 7.1 Confident wrongness

An LLM handed thin data will invent a plausible detail. "Congrats on the Series A" to
someone who did not raise is **worse than no personalization at all** — it burns the
relationship and makes Fundable look like it has bad data.

Mitigations, in order:

1. **Facts are passed as a closed set.** The writer may only reference supplied facts.
2. **Claim verification after generation.** Every factual assertion is checked against
   `evidence`. One corrective retry.
3. **Graceful downgrade.** If a claim cannot be verified, `status` drops to
   `template_only` and the untouched template is returned with a warning. The endpoint
   never silently ships an unverifiable claim.

This is the same failure mode and the same fix already built and proven in Post Studio
(`src/lib/claims.ts`), where the model produced unsupported comparisons roughly half
the time until it was constrained in code rather than in the prompt.

### 7.2 Uneven coverage

A sign-up from a solo founder at an unfunded company yields almost nothing. That is
fine and expected. It must be *visible*, not papered over.

**Confidence score:**

| Score | Meaning | Behaviour |
| --- | --- | --- |
| 0.8-1.0 | Company + person resolved, a specific dated fact available | Full personalization |
| 0.5-0.8 | Company only, or facts are generic | Light personalization, company-level |
| < 0.5 | Nothing specific found | `template_only`, return template untouched |

Callers can threshold on this. The right default for a sequencer is: below 0.5, send
the generic version.

---

## 8. Latency

Resolve + enrich + write is 3-6 API calls and **4-6 seconds** measured. That rules out
the request path of a live send.

- **Async by default.** Caller POSTs, gets a job id, polls or receives a webhook.
- **Sync mode** available with `?wait=true` for batch/offline use.
- **Cache per person** (30-day TTL). Funding facts change slowly; recent posts do not,
  so cache the Fundable half longer than the Exa half.

---

## 9. What is needed from Jacob

1. **10-20 real sent emails**, ideally across trigger types. This is the hard
   requirement, not a nice-to-have. Post Studio's voice only landed because there were
   eight real posts to anchor on, and **cold email voice is a completely different
   register from LinkedIn post voice** — shorter, no hook-and-authority structure, no
   comment CTA. Without real examples, v1 will read like generic AI outbound.
2. **The templates** currently in use, so "customize on the edges" has real edges.
3. **`sender_context`**: which customers/case studies to reference, and which
   investors Fundable has worked with (this powers the investor-overlap tie, the
   highest-value angle).
4. **Which trigger to build first.** Recommend `post-raise`: best Fundable coverage by
   construction, so it shows the product at its strongest.

---

## 10. Milestones

| # | Deliverable | Estimate |
| --- | --- | --- |
| 0 | Reuse Post Studio's Fundable client, alias tables, voice scaffold, claim checker | ~0, exists |
| 1 | `/api/personalize`: resolve + Fundable enrich + one trigger + evidence + confidence | 1 day |
| 2 | Exa enrichment, tie computation, remaining three triggers | 1 day |
| 3 | Voice tuning against Jacob's real emails; LinkedIn channel | 1 day, gated on §9.1 |
| 4 | Async queue, caching, auth, debug page | 1 day |

**A demoable v1 is one focused day**, because roughly 60% of the plumbing already
exists in Post Studio. Milestone 3 is the one that determines whether Jacob actually
uses it, and it is blocked on getting real emails from him.

---

## 11. Success criteria

- Jacob sends messages generated by this without editing the personalization.
- Zero fabricated facts in the first 100 calls (auditable via `evidence`).
- p95 latency under 8s in sync mode.
- `template_only` rate under 40% on real cold lists. Higher means enrichment is too
  narrow; much lower probably means the confidence gate is too loose.

## 12. Open questions

1. Does `template_only` still return a *lightly* adjusted template (first name, company)
   or the literal input? Recommend: literal, so callers can trust the distinction.
2. Do we log generated copy? Useful for tuning, but it is outbound content about real
   people — decide retention explicitly.
3. Is this Fundable-internal tooling or a customer-facing feature? It changes auth,
   rate limiting, and whether voice must be multi-tenant. §2 assumes internal.
