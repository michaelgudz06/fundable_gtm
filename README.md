# Fundable Personalization API

An endpoint you hit before sending any automated email or LinkedIn message. It
takes a person and a trigger, and returns copy personalized in Jacob's voice
plus the evidence it used.

See [PRD.md](PRD.md) for the product rationale and the API contract.

**Status: Milestones 1 and 2 complete.** `POST /api/personalize` runs the full
pipeline for the **post-raise** trigger (resolve → enrich → angle → write →
verify, with evidence, confidence, caching, request logging), and the demo is
live: `POST /api/personalize/stream` narrates every stage as NDJSON, and
**`/demo`** renders it — request builder with presets, live pipeline log with
per-stage timing chips, result panel with the confidence meter (0.5/0.8 gates
marked), evidence cards, and a usage footer. The other three triggers return 501
until Milestone 3.

The demo is key-gated (same bearer key, held in memory only — a refresh forgets
it) and **copy-only**: it ends at the clipboard, no sending anywhere. A loudly
labeled sample mode shows the UI with a captured real run for anyone without the
key.

**M2 acceptance: <8s p95 on the presets — passed.** 20 warm preset runs through
the streaming endpoint: median 5.4s, **p95 6.9s**, max 7.1s, 20/20 personalized.
Getting there surfaced real OpenRouter tail latency (a 17.7s call one evening,
~15% of calls over 8s at the worst): the fix is a racing hedge in the shared
client — a second identical request fires after 2.5s (angle) / 3.5s (write) and
the first to finish wins, loser aborted. Costs ~one extra call on slow draws,
pays with the user's time back.

```bash
npm run dev          # next dev on :3111 (apps/api) — open /demo
```

```bash
curl -s -X POST localhost:3111/api/personalize \
  -H "Authorization: Bearer $PERSONALIZE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"person":{"email":"eric@ramp.com"},"trigger":"post-raise","channel":"email","max_facts":3}'
```

**M1 acceptance (2026-07-29): passed.** Two full 10-case live suites, each case
independently and adversarially audited against its returned evidence:

- Final suite: **zero unsupported claims across all 10 runs.** 7 personalized
  (every one carrying a dated Fundable fact), 3 honest downgrades (unknown
  domain → `no_match` with the template returned verbatim; two verify-blocked
  drafts → `template_only` rather than shipping a bad claim).
- The first suite caught one real defect (round/valuation conflation, see
  below) and the second caught one verifier false positive — both fixed with
  regression tests before sign-off.
- Typical warm request: 4-9s, 0-2 Fundable credits. Cold compile + uncached
  enrichment can run longer; the <8s p95 target is M2's criterion on cached
  demo presets.

---

## Layout

```
packages/fundable-shared/   @fundable/shared — Fundable client, alias tables,
                            claim checker, evidence verifier, OpenRouter client,
                            voice loader
apps/api/                   Next.js 16 app (:3111)
  src/app/api/personalize/  POST route: auth, rate limit, validation
  src/lib/pipeline/         resolve → facts → confidence → angle → write+verify
  src/lib/storage.ts        Storage interface: Supabase REST impl + no-op fallback
config/voice/jacob.json     Voice profile. A second voice is a data change.
config/sender/default.json  Named sender_context blocks (safe generic facts only)
supabase/migrations/        pz_cache + pz_log schema (applied + verified)
scripts/verify-supabase.ts  npm run verify:supabase
```

Pipeline stages (spec §2) and where each lives:

| Stage | Kind | File |
| --- | --- | --- |
| 1 RESOLVE | deterministic, cached 30d | `pipeline/resolve.ts` |
| 2 ENRICH | deterministic — Fundable + Exa (cached 3d) | `pipeline/facts.ts`, shared `exa.ts` |
| 3 TIE | deterministic — investor / city / stage / repeat-founder | `pipeline/ties.ts` |
| 4 ANGLE | V4-flash picks angle + facts by index | `pipeline/angle.ts` |
| 5 WRITE | V4-pro, closed fact set, voice from config | `pipeline/write.ts` |
| 6 VERIFY | code, one corrective retry, else template_only | `pipeline/write.ts` → shared `verify.ts` |

### Triggers

All four are live. Each is a different claim about *why* you are writing, so each
gets its own evidence policy in `pipeline/triggers.ts` — a table rather than
scattered conditionals, so what a trigger may use is auditable at a glance.

| Trigger | Fires on | Notable policy |
| --- | --- | --- |
| `post-raise` | Fundable deal alert | Only trigger that penalizes a stale raise (>18mo) |
| `cold` | Outbound sequence / list | Ties weighted highest; the tie *is* the reason for writing |
| `sign-up` | Product sign-up (Clerk) | No Exa spend, no pitch; internal/test identities refused |
| `website-visitor` | Reverse-IP / form fill | **Cannot name a person at all** — see below |

`website-visitor` gets a second gate beyond the fact filter. Withholding the
`person` fact was not enough: the greeting name comes from the recipient block,
not from facts, so the first live run still opened *"Hi Eric,"* on an anonymous
company-level signal. `allowPersonIdentity: false` now withholds name, first
name, and title from the writer entirely, and the response says it did.

Status decisions live in one place (`pipeline/personalize.ts`): `no_match` when
nothing resolved, `template_only` when confidence < 0.5 or verification failed
(template returned **literally untouched**), `personalized` otherwise.

M1 cost note: post-raise facts all come from the `/companies` row — the embedded
`latest_deal` carries the round, date, and lead prose — so a typical uncached
request is 1-2 credits, under the PRD's 3-6 estimate. `/deals` + `/investors`
join in M3 for ties and history.

This is a copy of post-studio's shared code, not an import from it. Pointing
post-studio at this package is a deliberate follow-up task; nothing in this repo
touches that one.

## Setup

```bash
npm install
cp .env.example .env   # then fill it in
```

```bash
npm run typecheck
```

```bash
npm test
```

`npm test` is offline and needs no keys. The live suite spends real credits
(roughly 8 Fundable credits and under $0.01 of tokens per run):

```bash
npm run smoke
```

---

## What the live probe changed

The PRD's endpoint table was written from exploratory calls and got six things
wrong. Every one of them fails **silently** at runtime — as `undefined`,
`[object Object]`, or a confidently wrong fact in an email — rather than as a
type error. They are corrected in `packages/fundable-shared/src/fundable.ts`,
each with the guard that catches it.

| PRD said | Actually |
| --- | --- |
| `latest_deal.investor_ids` | The key is `latest_deal.investors`. `investor_ids` does not exist. |
| `latest_deal.description` is a string | It is an object: `{short_description, long_description}`. |
| Round label is `type` | `type` on `/companies`, **`round_type`** on `/deals`. Same object, two names. |
| `/people` needs an exact URL match | It matches on the `/in/<slug>`; scheme, `www.`, trailing slash and slug case are all ignored. |
| Batch up to 100 domains | True, **but `page_size` defaults to 10.** A 100-domain batch without it returns 10 rows and the other 90 look like unknown domains. |
| Lead investor available for the investor-overlap angle | **No structured lead field exists anywhere in the API.** The lead is named only in prose. |

Three further findings that shaped the code:

- **`www.` is silently dropped.** `www.ramp.com` matches nothing in the same call
  where `ramp.com` matches, and the miss is indistinguishable from a fake company.
- **A blank LinkedIn URL returns the entire 365k-row people dataset** and hands
  back an arbitrary stranger as `people[0]`, billed 1 credit. This is the worst
  failure mode in the API: confident personalization about someone who is not the
  prospect. Blank identifiers are rejected before the request, and a single-URL
  lookup returning more than one row is a hard error.
- **Result order is not request order.** Verified reversed on `/investors`. Worse,
  order is otherwise *preserved*, so index-zipping appears to work in any test
  batch with no unknown domains, then silently attributes one company's funding
  round to a different prospect in production. Every lookup here goes through a
  `Map` keyed on the identifier.

### The investor-overlap tie, and why it runs backwards

`/investors` exposes no portfolio companies, and `/deals` cannot be filtered by
investor — every shape returns 422. There is **no investor → companies direction
in the API at all**, so "this fund also backed one of our customers" cannot be
asked forwards.

`pipeline/ties.ts` inverts it: resolve the sender's own reference customers once,
cache their `all_investor_ids`, and intersect that cached set against the
prospect's `all_investor_ids` — which arrives free with the company lookup we
already made. `/investors` is then called only for the ids that survive, purely
to get fund names for the copy. **1-2 credits per prospect instead of 54.**

The tie is dormant in `config/sender/default.json` because `customer_domains` is
empty: a domain listed there may be **named in outbound copy**, so it needs
Jacob's sign-off on which customers are referenceable. `demo_overlap.json`
exists to exercise the mechanic, and is explicit that its companies are
well-known reference companies rather than customers — the tie fact says
"<Fund> is an investor in both X and Y", which is verifiable investor overlap and
asserts no customer relationship.

### Exa: two calls, not one, and a strict identity gate

The PRD said `category: "people"` returns recent LinkedIn posts. It does not — it
queries a dedicated person index and returns a structured **`workHistory`**, and
it rejects `startPublishedDate` outright. So recency and career history are two
separate calls.

The `workHistory` is a genuine unlock: it is what makes the **repeat-founder** tie
computable at all, since Fundable's own `employment_history` comes back empty even
for well-documented careers. Glyman's shows *Co-Founder at Paribus Co.
(2014-2019)* before Ramp.

It is also the most dangerous data in the pipeline. A semantic search for "Eric
Glyman" also returns "Jason Glyman" at score 0, and attributing a stranger's
career to the prospect would be the worst failure this product could have. So
`findPerson` requires both name tokens to match, enforces a score floor, refuses
single-token names **without spending a call**, and downgrades career facts when
the employer cannot be confirmed against the work history.

### The lead-investor angle needs a decision

The PRD calls investor overlap the highest-value angle, and cites
"Ribbit led your Series A" as the example. There is no lead-investor field: no
`lead_investor_id`, no role on a deal's `investor_ids`, and no deal-scoped
investor query. `investor_ids[0]` is **not** the lead — the same deal returns the
same set in a different order from different endpoints.

The lead is named only in `deal_descriptions.short_description`, as prose:

> "...raised $750 million in a Series F at a $44 billion valuation led by ICONIQ,
> GIC, and Ontario Teachers' Pension Plan."

`leadInvestorProse()` returns that sentence rather than a parsed name, on purpose.
Two options for M3, and this is Michael's call:

1. **Quote the sentence as evidence.** Safe, already citable, needs no extraction.
2. **LLM-extract the lead names from it.** Reads better, but naming the wrong fund
   as lead is exactly the credibility-destroying error the verify stage exists to
   prevent.

Separately, "this fund also backed one of our customers" cannot be answered
forwards — `/investors` exposes no portfolio companies and `/deals` cannot be
filtered by investor. It has to be **inverted**: resolve Fundable's own reference
customers once, cache each one's `all_investor_ids`, then intersect against the
prospect's `all_investor_ids`, which arrives free with the company lookup. That
keeps `/investors` spend at 1-2 credits per prospect instead of 54.

---

## Verification is in code, not in the prompt

`claims.ts` is the verbatim port from post-studio: it catches unsupported
*comparisons*, which was the right question for a post about a data slice.

`verify.ts` adds what cold outbound needs — does every factual assertion trace to
the closed evidence set. It blocks unsupported figures, years and months,
relationship claims ("great speaking last week"), em dashes, and forbidden
phrases. Unrecognised proper nouns are a **warning**, never a block, because that
check is heuristic and a false block would make the endpoint useless.

Honest rounding is allowed: evidence of `$3,577,000,000` supports "$3.6B" (within
1%), but not "$4B".

### M3 acceptance — 25-row cold list

Target was a `template_only` rate under 40%. **Measured 12%** (22 personalized, 3
no_match) across 25 real domains, using `trigger=cold` with the `demo_overlap`
sender context. Cost: 115 Fundable credits and $0.154 of Exa for the whole list
(~4.6 credits and $0.006 per row), p95 12s uncached.

**Read that 12% with a caveat.** `demo_overlap` lists four extremely
well-connected reference companies, so `investor_overlap` fired on 21 of 22
personalized rows and confidence pinned at 0.95 almost everywhere. Real reference
customers will be fewer and less ubiquitously funded, so expect a higher
downgrade rate in production. The number is honest but flattered by the fixture.

The audit also found a third verification defect, described below.

### Second-person compression — the pronoun that moves the claim

Three subject lines came back as *"dragoneer and t. rowe price backed both of
you"*. The bodies were correct ("an investor in both Revolut and Anthropic"), but
the subject dropped the reference company and put **the sender** in its place —
asserting the fund also backs Fundable. Nothing in evidence says that.

No figure, date, or name is wrong in that sentence. The pronoun reassigns who the
claim is about, which is why the numeric and entity checks could not see it. Fixed
at all three layers, same pattern as the conflation bug: a `pronoun_scope`
blocking check in `verify.ts` (which consults evidence for a sender-side investor
rather than assuming there is none), an explicit prompt rule, and a subject-line
rule plus a bad example in the voice profile.

Also fixed from the same audit: the proper-noun check glued `"…Anthropic."` to
`"Fundable maps…"` and reported `"Anthropic. Fundable"` as an invented entity.
Sentences are now split before extraction — a noisy warning is worse than none,
because reviewers learn to skip them.

### Conflation — two true facts welded into a false claim

The M1 acceptance audit caught the writer producing *"closed an equity round on
February 27, at a disclosed valuation of $91.5B"* — round fact true, valuation
fact true, the join unsupported: nothing said that round was priced at that
valuation. For a company whose valuation moved after its last round, the join is
simply false. A second variant surfaced the same day: *"stripe's $91.5b round"* —
the valuation figure worn as an amount raised. Defense is layered three deep:

1. **Source** (`pipeline/facts.ts`): the valuation folds into the raise fact only
   when Fundable's own `latest_valuation_date` is the same day as the deal —
   then the join *is* the data. Otherwise it stays a separate fact whose wording
   says it is "not the price of the latest financing".
2. **Prompt** (`pipeline/write.ts`): the writer is told never to weld two facts
   into a third claim.
3. **Verifier** (shared `verify.ts`, kind `conflation`, blocking): a sentence
   binding a round to a valuation needs a single fact stating both, and a figure
   in raise position ("$X round", "raise(d) $X") must be supported as an amount
   raised, not merely present somewhere in the evidence.

Related, surfaced by the same audit: Fundable's structured `total_round_raised`
can contradict its own deal prose (seen live: Anthropic $50B vs "$65 billion").
Both facts stay — each is individually citable — but the response carries a
warning naming the discrepancy.

Anything still blocking after one corrective retry downgrades the response to
`template_only` and returns the caller's template untouched. That is the whole
promise of the product, so it is enforced here rather than requested in a prompt.

## Voice

`config/voice/jacob.json` is marked `"provenance": "placeholder"`. It was adapted
from post-studio's LinkedIn voice, which was derived from Jacob's real posts —
but **cold email is a different register**, so the transferable parts were kept
(analyst tone, no em dashes, never inflate a number) and the LinkedIn mechanics
were dropped (the 12-word truncation hook, the three-line fold, the comment-gated
CTA).

While provenance is `placeholder`, `provenanceWarning()` returns a warning the API
must include in every response. It returns `null` on its own once Jacob's 10-20
real sent emails land and provenance flips to `real_examples`.

## Supabase

Project `tcknxpyysoqrnsvkxfic`, confirmed reachable and authenticating with both
the secret and publishable keys. `.mcp.json` in this repo points the `supabase`
MCP server at it (the global `~/.mcp.json` still points at a deleted project, so
the project-scoped entry is what you want for this repo).

**Both migrations are applied and verified** (2026-07-29). `pz_cache` and `pz_log`
exist, every column the pipeline writes is present, and the storage layer is
unblocked for M5.

```bash
npm run verify:supabase
```

Re-runnable any time. It checks both tables, all 40 columns, that `retain_until`
really defaults to +90 days (it inserts a row, measures the delta, and deletes it,
rather than trusting the DDL), and that both purge functions are callable.

It also asserts the security property the migrations exist for: **the publishable
key is denied on both tables** (verified HTTP 401). `pz_log` holds generated
outbound copy about real people and the publishable key ships to the browser in
the demo UI, so "RLS is enabled" is not the same claim as "the browser key cannot
read it". The script checks the second one.

To re-apply from scratch, paste both files in filename order into the dashboard
SQL editor, or use `apply_migration` from a session where the Supabase MCP is
authenticated (`claude /mcp` → `supabase` → Authenticate).

## Guardrails this repo keeps

- No sending capability anywhere. Drafts only, and only in the n8n layer later.
- Never invent a Fundable permalink — alias-table or search-verified only.
- Diff requested vs returned on every batch call; surface drops as warnings.
- Facts reach the writer as a closed set; verification happens in code.
- `.env` is git-ignored and `.env.example` carries placeholders only.
- Exclude `@tryfundable.ai` and Jacob's aliases from any test run that writes
  somewhere real.
