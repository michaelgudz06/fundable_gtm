# Fundable REST API — findings from building on it

Everything below was **probed live against production** on 2026-07-29/30 while
building the Personalization API. Each item is reproducible with the commands
shown.

These are ordered by how badly they fail. The first four fail **silently** —
`undefined`, `[object Object]`, or a confidently wrong fact in customer-facing
copy — rather than as an error a caller would notice.

---

## 1. A blank identifier returns the entire people dataset

**Severity: highest.** `POST /people` with an empty string in `linkedin_urls`
does not reject the request. It returns `meta.total_count: 365406` — the whole
unfiltered table — hands back an arbitrary person as `people[0]`, and bills 1
credit.

```bash
curl -s -X POST https://www.tryfundable.ai/api/v1/people \
  -H "Authorization: Bearer $FUNDABLE_API_KEY" -H "Content-Type: application/json" \
  -d '{"identifiers":{"linkedin_urls":[""]},"page_size":1}'
# -> success:true, total_count 365406, credits_used 1, an unrelated person in row 0
```

Any caller that passes a null/blank/whitespace LinkedIn URL — a missing CRM
field, a bad CSV cell — silently receives **a stranger's profile presented as
the person they asked for**. In an outbound tool that is a wrong name and a wrong
employer in a real email.

**Suggested fix:** reject an empty or whitespace-only identifier with 422, the
same way `identifiers.ids: []` is already rejected with `EMPTY_ARRAY_PARAMETER`.

---

## 2. The same deal contradicts itself on round size

For Anthropic, `latest_deal.total_round_raised` is **$50B** while
`latest_deal.description.short_description` — Fundable's own prose about the same
deal — says **$65 billion**.

Both are in the same response object. A caller has no way to tell which is
authoritative, and either choice can be quoted back to the company that raised.

**Suggested fix:** reconcile at ingest, or expose which field is canonical.

---

## 3. `page_size` defaults to 10, so documented batches silently truncate

`POST /companies` accepts up to 100 domains. With no explicit `page_size` it
returns **10 rows** — HTTP 200, no warning.

```bash
# 3 real domains, page_size 2 -> 2 companies returned, meta.total_count 3
curl -s -X POST .../companies -d '{"identifiers":{"domains":["stripe.com","figma.com","brex.com"]},"page_size":2}'
```

A naive caller batching 100 domains gets 10 companies and concludes the other 90
are unknown companies. The two cases *are* distinguishable, but only if you know
to check: `meta.total_count > data.companies.length` means paginated;
`total_count == length` but fewer than requested means genuinely not found.

**Suggested fix:** default `page_size` to the number of identifiers submitted, or
document the default prominently on the batch endpoints.

---

## 4. Unknown identifiers are dropped with no signal, and `total_count` cannot reveal it

Sent 5 domains (3 real, 2 impossible). Got HTTP 200, `success: true`, 3 companies.
Top-level keys were exactly `['data','meta','success']` — no `error`, no
`warnings`, no `unmatched`, no per-domain status anywhere.

**`meta.total_count` counts matches, not requests**, so on a pure not-found case
it equals the array length and the response looks perfectly healthy. Only an
explicit set-difference against what you sent surfaces the drop.

Related: **`www.`-prefixed domains match nothing.** `www.stripe.com` returned zero
results in the same call where a bare domain matched — indistinguishable from a
nonexistent company. Raw email domains need normalising first.

**Suggested fix:** return an `unmatched: []` array on batch lookups.

---

## 5. Result order is not request order

Sent investor ids `[Thrive, T. Rowe]`, got back `[T. Rowe Price, Thrive Capital]`
— reversed.

Worse for correctness: order is *otherwise* preserved. So index-zipping
`response[i]` to `request[i]` appears to work in any test batch that happens to
contain no unknown identifiers, then silently mis-attributes one company's
funding round to a different prospect the first time one is dropped in production.

**Suggested fix:** document that results must be joined by identifier, not index.

---

## 6. Field names differ between endpoints for the same object

| Same value | on `/companies` (`latest_deal`) | on `/deals` |
| --- | --- | --- |
| round label | `type` | `round_type` |
| investor ids | `investors` | `investor_ids` |
| descriptions | `description` (object) | `deal_descriptions` |

Verified by diffing the same deal (`15dad760`) across both endpoints — payloads
agree, key names do not. A shared type across the two reads `undefined` at
runtime with no type error.

Two further shape notes: `latest_deal.description` is an **object**
(`{short_description, long_description}`), not a string — rendering it directly
gives `[object Object]`. And there is a third round modifier, `intermediate`
(`"NONE" | "TWO" | …`), alongside `pre` and `extension`; rendering only the round
type prints "Series E" for what is actually a Series E-2.

---

## 7. No structured lead investor anywhere in the API

There is no `lead_investor_id`, no role on `investor_ids`, no lead flag on a
deal, and no deal-scoped investor query (`/investors` with `deal.deal_ids` is
422 `UNKNOWN_PARAMETER`). `investor_ids[0]` is **not** the lead — the same deal
returns the same set in a different order from different endpoints.

The lead appears only as prose inside `deal_descriptions.short_description`
("...led by ICONIQ, GIC, and Ontario Teachers' Pension Plan").

This matters because "who led your round" is the highest-value personalization
angle available, and right now it can only be quoted, not queried.

**Suggested fix:** expose lead investors as structured data. This is the single
most valuable addition for any GTM use of the API.

---

## 8. No investor → companies direction

`/investors` exposes no portfolio companies (`include_portfolio` and
`portfolio_company_ids` are both rejected), and `/deals` cannot be filtered by
investor (tried `identifiers.investor_ids`, top-level `investor_ids`,
`filters.investor_ids`, top-level `investor` — all 422).

So "what else did this fund back" is unanswerable. We worked around it by
inverting the join: resolve our own reference companies once, cache their
`all_investor_ids`, and intersect against the prospect's `all_investor_ids`
(which arrives free with the company lookup). That took per-prospect cost from
54 credits to 1–2, but it only works because we control both sides.

---

## 9. `/people` is ~19s on a cold path and ~2.6s warm, which sets the ceiling for anything calling it live

Found on 2026-07-31 while replaying a real 29-lead list through the
Personalization API: p95 was 39s, and per-leg timing put ~32s of it inside the
single call that resolves a LinkedIn URL to a person. Reproduced straight
against production from a laptop, with nothing of ours in the path:

```bash
req() { curl -s -o /dev/null -w "%{time_total}s http=%{http_code}\n" \
  -X POST https://www.tryfundable.ai/api/v1/people \
  -H "Authorization: Bearer $FUNDABLE_API_KEY" -H 'content-type: application/json' \
  -d "{\"identifiers\":{\"linkedin_urls\":[\"$1\"]},\"page_size\":1,\"page\":0}"; }

req https://www.linkedin.com/in/jeremy-harper-8945b732   # 19.008s  <- first after idle
req https://www.linkedin.com/in/max-w-1161541b7          #  2.819s
# 4 concurrent, distinct slugs                           #  ~4.9-5.5s each
req https://www.linkedin.com/in/jacovides                #  2.569s  <- warm again
```

Single-row lookups, so this is not batch size. The pattern — one very slow call
after idle, fast calls after it — reads like a cold index or connection pool
rather than per-request work. `/companies` by domain does not show it.

Why it matters beyond us: 2.6s warm is already the floor for any interactive
surface that resolves a person mid-request, and 19s is past the point where a
webhook or an n8n step times out. Anything user-facing has to either cache or
resolve people out of band.

What we did on our side, which is a workaround and not a fix: cache person
lookups for 30 days (misses included) and stop making other upstream calls wait
behind this one. That took our p95 from 39.0s to 9.1s without changing a single
classification.

---

## Smaller notes

- `investor.location` can be `{}` — an empty object, not null — so
  `location.city.name` throws on real data while a truthiness check on
  `location` passes.
- `investment_stage` is a comma-joined **string** (`"Early Stage Venture, Late
  Stage Venture, Seed"`), not the array the name suggests.
- `lead_deal_count` is all-time while `deal_count_last_12_months` is
  trailing-12-month, so a ratio of the two can exceed 1.
- `person.first_name` and `last_name` are **null even on a successful hit** while
  `name` is populated — so a greeting name has to be derived from `name`.
- `person.employment_history` is `[]` even for well-documented careers.
- Many deal `date` values are exactly `T12:00:00.000Z` — a placeholder noon — so
  the value is day-precision only and rendering a time of day invents precision.
- `created_at` is ingest time, not round time.
- Currency casing is inconsistent within one deal:
  `valuation.valuation_currency` is `"USD"`, `financings[].currency` is `"usd"`.
- 422 responses carry no `meta` and no `data`, so code reading
  `meta.credits_used` for spend tracking crashes on the failure path. The 422
  body reports every problem in `error.details.errors[]` but mirrors only the
  first into `error.message`.
- A zero-match response grows an extra top-level `message` string that is absent
  on non-empty responses, so the envelope type needs it optional.

---

## What was good

Worth saying, since the above is all problems:

- **Domain → company coverage is excellent.** Every well-known domain tried
  resolved with description, employee band, industries, location, full funding
  history, and a populated `latest_deal`.
- **`all_investor_ids` at company level** (54 for Ramp vs 26 on the latest deal)
  is exactly the right shape for overlap work, and it costs nothing extra.
- **Credit accounting is honest and predictable** — billed per row returned,
  unknown identifiers are free, and `meta.credits_used` is always present on
  success.
- **Validation is strict rather than lenient.** Unknown request fields 422
  instead of being silently ignored, which caught several of our own mistakes
  early. Deliberate 422s are also a free way to introspect the schema, since
  they cost nothing.
