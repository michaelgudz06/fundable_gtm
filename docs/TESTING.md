# Testing Jacob's v2 asks against production

Every command below is copy-pasteable. Run the preamble once per shell.

```bash
cd ~/Developer/work/fundable/personalize-api
export K=$(grep -m1 '^PERSONALIZE_API_KEY=' .env | cut -d= -f2- | tr -d '"')
export B=https://personalize-api-umber.vercel.app
```

`-D /dev/stderr` prints the response headers. They are where the diagnosis
lives — the body tells you the answer, the headers tell you how it was reached.

| header | meaning |
|---|---|
| `x-stop-at` | which run mode answered |
| `x-linkedin-source` | which n8n leg resolved the URL (`quick_enrich`, `apollo`, `ai_ark`) — absent means the caller supplied it or nothing resolved |
| `x-classification` | `fresh` = the model ran, `cached` = 30-day cache hit, `none` = no classification in this mode |
| `x-identity` | `timeout` means the Fundable `/people` lookup ran out its 8s cap |
| `x-handler-ms` | server-side time, excludes network |

---

## Status of the eight asks

| # | Ask | Status | Test |
|---|---|---|---|
| 1 | Mandatory `email`, `first_name`, `last_name` | done | [1](#1-mandatory-fields) |
| 2 | Optional `linkedin`, `company_name`, `role` | done | [2](#2-optional-identity-fields) |
| 3 | Optional `company_industry`, `location` | **`location` done, `company_industry` NOT built** | [3](#3-location-and-company_industry) |
| 4 | No LinkedIn → find-LinkedIn flow | done, n8n live | [4](#4-find-linkedin-via-n8n) |
| 5 | Classify into an ICP | done | [5](#5-classify-into-an-icp) |
| 6 | Email by ICP + format | done | [6](#6-email-by-icp--format) |
| 7 | Three run modes | done | [7](#7-three-run-modes) |
| 8 | LLM review before send | **partial — see below** | [8](#8-review-before-send) |

---

## 1. Mandatory fields

Missing `last_name` must be rejected before anything is spent.

```bash
curl -s -X POST "$B/api/v1/personalize" -H "authorization: Bearer $K" \
  -H 'content-type: application/json' \
  -d '{"email":"a@b.com","known_fields":{"first_name":"A"},"stop_at":"linkedin"}'
```

Expect **400** `` `known_fields.first_name` and `known_fields.last_name` are both required. ``

No bearer token must be rejected too:

```bash
curl -s -X POST "$B/api/v1/personalize" -H 'content-type: application/json' -d '{}'
```

Expect **401** `Missing bearer token.`

---

## 2. Optional identity fields

`role` is the existing `title`. Supplying `title` + `company_name` is the
**most accurate and cheapest** path — no identity lookup runs at all.

```bash
curl -s -D /dev/stderr -X POST "$B/api/v1/personalize" -H "authorization: Bearer $K" \
  -H 'content-type: application/json' \
  -d '{"email":"jacob@tryfundable.ai","known_fields":{"first_name":"Jacob","last_name":"Klionsky","title":"Co-Founder","company_name":"Fundable"},"stop_at":"icp"}'
```

Expect **ICP #6: Founder**, sub-second.

### The `linkedin_url` trap — test this one deliberately

Supplying `linkedin_url` routes identity to Fundable's `/people` index
**instead of** the n8n cascade. For anyone outside that index the lookup burns
its full 8s cap, returns no title, and the lead drops to the email-only path —
a *worse* label, slower.

```bash
curl -s -D /dev/stderr -X POST "$B/api/v1/personalize" -H "authorization: Bearer $K" \
  -H 'content-type: application/json' \
  -d '{"email":"jacob@tryfundable.ai","known_fields":{"first_name":"Jacob","last_name":"Klionsky"},"linkedin_url":"http://www.linkedin.com/in/jacob-klionsky","stop_at":"icp"}'
```

Measured on Jacob, same registry:

| sent | ICP | time |
|---|---|---|
| email + name | **#6 Founder** | 0.6s |
| email + name + `linkedin_url` | **#9** | 8.6s, `x-identity: timeout` |
| email + name + `title` | **#6 Founder** | 0.45s |

**Title > nothing > linkedin_url.** This is why `scripts/backfill.ts` ignores
the CSV's `linkedin_url` column unless `--use-csv-linkedin` is passed.

---

## 3. `location` and `company_industry`

`location` is accepted and feeds the identity cascade:

```bash
curl -s -X POST "$B/api/v1/personalize" -H "authorization: Bearer $K" \
  -H 'content-type: application/json' \
  -d '{"email":"jacob@tryfundable.ai","known_fields":{"first_name":"Jacob","last_name":"Klionsky","location":"New York"},"stop_at":"linkedin"}'
```

**`company_industry` is not built.** It is currently accepted and silently
ignored — the request returns 200 and the field changes nothing. This is the
last of the eight asks still open. When it lands it must be **research
targeting only** and must never reach the classifier as evidence;
`scripts/contract-check.ts` enforces that.

---

## 4. Find-LinkedIn via n8n

**Verified working in production, 2026-08-21.**

Cold run on a lead the API has never seen, no LinkedIn supplied:

```bash
curl -s -D /dev/stderr -X POST "$B/api/v1/personalize" -H "authorization: Bearer $K" \
  -H 'content-type: application/json' \
  -d '{"email":"vihaar@orangeslice.ai","known_fields":{"first_name":"Vihaar","last_name":"Bhagat"},"stop_at":"linkedin"}'
```

Measured: **5.04s**, `x-linkedin-source: quick_enrich`, `x-classification: fresh`,
resolved `https://www.linkedin.com/in/vihaarnandigala` from email + name alone.
Repeat the same call — it returns in ~0.28s with `x-classification: cached`.
The resolve cache is 30 days.

### Probing n8n directly

Bypasses the API, so it separates "n8n is down" from "our code is wrong":

```bash
curl -s -X POST "$(grep -m1 '^N8N_LINKEDIN_WEBHOOK_URL=' .env | cut -d= -f2- | tr -d '"')" \
  -H "x-api-key: $(grep -m1 '^N8N_LINKEDIN_WEBHOOK_TOKEN=' .env | cut -d= -f2- | tr -d '"')" \
  -H 'content-type: application/json' \
  -d '{"email":"vihaar@orangeslice.ai","first_name":"Vihaar","last_name":"Bhagat"}'
```

Read `quickEnrichFound` / `apolloFound` / `aiArkFound` in the response — they
tell you which leg of the cascade hit.

### Known behaviour: the fourth leg is effectively dead

The cascade is Quick Enrich → AI Ark → Apollo → Exa+Gemini. When the first
three all miss, the Exa+Gemini leg returns **unrelated LinkedIn articles**, not
a person, and it exceeds `LEG_TIMEOUT_MS.n8n = 6_000` anyway. On that path
`resolveLinkedIn()` returns null **silently** — indistinguishable from n8n
being unconfigured. Reproduce with a person none of the providers carry:

```bash
curl -s -X POST "$(grep -m1 '^N8N_LINKEDIN_WEBHOOK_URL=' .env | cut -d= -f2- | tr -d '"')" \
  -H "x-api-key: $(grep -m1 '^N8N_LINKEDIN_WEBHOOK_TOKEN=' .env | cut -d= -f2- | tr -d '"')" \
  -H 'content-type: application/json' \
  -d '{"email":"pieter@levels.io","first_name":"Pieter","last_name":"Levels"}'
```

A null LinkedIn is **fail-soft**: the lead still gets an ICP and an email from
email-only evidence. It is not an error.

---

## 5. Classify into an ICP

```bash
curl -s -D /dev/stderr -X POST "$B/api/v1/personalize" -H "authorization: Bearer $K" \
  -H 'content-type: application/json' \
  -d '{"email":"jacob@tryfundable.ai","known_fields":{"first_name":"Jacob","last_name":"Klionsky"},"stop_at":"icp"}'
```

Expect **ICP #6: Founder** plus three use cases
(`find_relevant_investors`, `research_investor_fit`, `build_investor_outreach`).

### Use `/api/v1/personalize`, not `/api/classify`

`/api/classify` never runs find-LinkedIn, so it classifies on weaker evidence
and returns a **different, worse** answer for the same person:

```bash
curl -s -X POST "$B/api/classify" -H "authorization: Bearer $K" \
  -H 'content-type: application/json' \
  -d '{"linkedin":"http://www.linkedin.com/in/jacob-klionsky","email":"jacob@tryfundable.ai"}'
```

Returns **ICP #9** with `"path":"email_only"` and the warning
`LinkedIn URL did not resolve in Fundable`. It is a debug endpoint — it also
returns `reasoning` and the HubSpot picklist label, which the v1 route does
not. Use it to explain a label, never to produce one.

*(This endpoint returned a bare 500 until 2026-08-21; if you see one, the
deploy is stale.)*

---

## 6. Email by ICP + format

Nine catalog templates across five message types. Each template pins which
message types it accepts:

| `template_id` | `message_type` |
|---|---|
| `signup_paid_initial` | `signup_paid` |
| `signup_unpaid_initial` | `signup_unpaid` |
| `website_visitor_use_case` | `website_visitor` |
| `followup_alerts_paid` | `nurture` |
| `followup_alerts_unpaid` | `nurture` |
| `followup_api` | `nurture` |
| `followup_mcp` | `nurture` |
| `followup_use_case_question` | `nurture` |
| `cold_outbound_cre_daily_raise` | `cold_outbound` |

```bash
curl -s -D /dev/stderr -X POST "$B/api/v1/personalize" -H "authorization: Bearer $K" \
  -H 'content-type: application/json' \
  -d '{"email":"jacob@tryfundable.ai","known_fields":{"first_name":"Jacob","last_name":"Klionsky"},"message_type":"website_visitor","template_id":"website_visitor_use_case"}'
```

Returns all six keys. A wrong `template_id` is a **422 `UNKNOWN_TEMPLATE`**;
a template/message-type mismatch is a 422 too. Jacob's spec lists "sign-up" as
one format but the catalog splits it into `signup_paid` and `signup_unpaid` —
**confirm with him which he means** rather than guessing.

---

## 7. Three run modes

One parameter, `stop_at`. Each mode returns a **prefix** of the same six keys,
never a different shape, so one reader handles all three.

```bash
for m in linkedin icp email; do
  echo "=== $m"
  curl -s -D /dev/stderr -X POST "$B/api/v1/personalize" -H "authorization: Bearer $K" \
    -H 'content-type: application/json' \
    -d "{\"email\":\"jacob@tryfundable.ai\",\"known_fields\":{\"first_name\":\"Jacob\",\"last_name\":\"Klionsky\"},\"stop_at\":\"$m\"}" \
    2>/dev/null | head -c 200; echo
done
```

| `stop_at` | keys returned | measured warm |
|---|---|---|
| `linkedin` | `full_name, email, linkedin_url` | 0.28s, `x-classification: none` |
| `icp` | + `icp, icp_use_cases` | 0.28s |
| `email` *(default)* | + `email_body` | 0.31s |

Omitting `stop_at` is byte-identical to the old behaviour — every existing
caller is unaffected.

Copy instructions are **rejected** in the short modes rather than accepted and
ignored:

```bash
curl -s -X POST "$B/api/v1/personalize" -H "authorization: Bearer $K" \
  -H 'content-type: application/json' \
  -d '{"email":"a@b.com","known_fields":{"first_name":"A","last_name":"B"},"stop_at":"icp","template_id":"signup_paid_initial"}'
```

Expect **400** `` `template_id`/`email_template` are only valid with stop_at="email". ``
An unknown mode is a 400 that lists the three valid values.

---

## 8. Review before send

**Partial, and the gap is the opposite of what you'd assume.**

There are two compose branches, and they are not equally protected:

| branch | writer | claim-checked? |
|---|---|---|
| catalog template (**the main path**) | deterministic substitution | `validateEmailBody` only — **no `verifyCopy`** |
| caller-supplied `email_template` | deterministic substitution | `verifyCopy` + `blockingIssues` → 422 |

So the path almost every request takes has no claim-checking, and the rarely
used caller-template path has all of it. Test the branch that *is* protected:

```bash
curl -s -X POST "$B/api/v1/personalize" -H "authorization: Bearer $K" \
  -H 'content-type: application/json' \
  -d '{"email":"jacob@tryfundable.ai","known_fields":{"first_name":"Jacob","last_name":"Klionsky"},"message_type":"cold_outbound","email_template":"Hi {{first_name}}, Fundable guarantees you will close your seed round in 30 days."}'
```

Expect **422 `UNSUPPORTED_CLAIM`** — that guarantee is not in
`config/registry/approved_claims.json`.

Wiring the same two checks onto the catalog branch is ~10 lines; the imports
are already at the top of `apps/api/src/lib/v2/personalize.ts`. The full
LLM review-and-retry loop (`apps/api/src/lib/pipeline/write.ts:178-284`) is
deliberately **not** wired in: v2 does not generate prose, it substitutes
variables into human-approved templates, so an LLM reviewer there is reviewing
text a human already signed off — latency against a 13.5s budget for no signal.
Wire it if and when v2 starts writing freely.

---

## Before a real backfill

```bash
npx tsx scripts/backfill.ts --csv <export>.csv --stop-at icp --limit 50 --dry-run
```

Two things to settle first:

1. **`PERSONALIZE_RATE_LIMIT_PER_HOUR` is 600**, below a 1306-row list. It is
   an in-memory sliding window held **per lambda instance**, so under
   concurrency it leaks and you may not hit the wall — do not rely on that.
   Raise it in Vercel rather than depending on the leak.
2. **Jacob's sign-off.** A full run spends *his* Apollo credits and n8n
   execution quota.

Run 50 rows both with and without `--use-csv-linkedin` before committing the
whole list. The delta tells you how much of the list is actually in Fundable's
people index, which is the variable the `linkedin_url` trap turns on.
