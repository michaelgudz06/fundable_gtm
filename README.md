# Fundable Personalization API

> "An alert saying 'Company X raised $10M' is a helpful signal… But on its own, it
> isn't enough to make good outbound. The context is helpful, but you still have
> to connect the dots to write a solid message, which takes time. So we've been
> giving customers a Claude skill that fixes the last step."
> — Jacob Klionsky, 2026-07-09

**This is that skill as an endpoint.** One POST: person + reason for writing in,
copy + the evidence behind every claim out. It sends nothing.

Built by Michael Gudz. Internal tooling, Jacob's voice only.

---

## Run it

```bash
git clone <this repo> && cd personalize-api
npm install
cp .env.example .env     # then fill in the five keys
npm run dev              # http://localhost:3111
```

Three pages: **`/`** overview + live dependency health · **`/guide`** the full
operator guide · **`/demo`** the live tool.

```bash
npm test                 # 67 offline tests, no keys needed
npm run verify:supabase  # checks the cache/log tables and their RLS
```

## Call it

```bash
curl -s -X POST http://localhost:3111/api/personalize \
  -H "Authorization: Bearer $PERSONALIZE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"person":{"email":"eric@ramp.com"},"trigger":"post-raise","channel":"email","max_facts":3}'
```

```jsonc
{
  "status": "personalized",          // personalized | template_only | no_match
  "confidence": 0.9,                 // gate your sequencer on >= 0.5
  "subject": "ramp's $750m series f",
  "body": "Hi Eric,\n\nRamp raised a $750M Series F…",
  "angle": "the_raise",              // log this — reply-rate-by-angle later
  "evidence": [ { "fact": "…", "source": "fundable", "endpoint": "/companies", "confidence": 1 } ],
  "warnings": [ … ],                 // always surface these to the reviewer
  "usage": { "fundable_credits": 2, "exa_cost_usd": 0, "llm_tokens": 1707, "ms": 4200 }
}
```

`POST /api/personalize/stream` returns the same thing as NDJSON, one stage event
per line, for the demo's live view. `GET /api/health` is unauthenticated and makes
no paid calls.

---

## What it does

Four triggers, each a different claim about *why* you're writing — so each is
allowed different evidence. All four live.

| Trigger | Fires on | Notable |
| --- | --- | --- |
| `post-raise` | Fundable deal alert | Only one that penalizes a stale raise (>18mo) |
| `cold` | Outbound sequence / list | Leads with a computed tie; a shared investor beats everything |
| `sign-up` | Product sign-up | No pitch, no Exa spend; refuses internal/test identities |
| `website-visitor` | Reverse-IP / form fill | **Cannot name a person at all** — opens "Hi," by design |

Six stages, five of them deterministic:

| | Stage | Kind |
| --- | --- | --- |
| 1 | RESOLVE | email domain → company, LinkedIn → person. Cached 30d. |
| 2 | ENRICH | Fundable facts + Exa recency/career history. Exa cached 3d. |
| 3 | TIE | shared investor · same city · same stage · repeat founder |
| 4 | ANGLE | DeepSeek V4-flash picks one angle + facts, by index |
| 5 | WRITE | DeepSeek V4-pro. **The only generative step.** |
| 6 | VERIFY | code, not prompt. One retry, then it refuses. |

## The guarantee

An LLM handed thin data invents a plausible detail. *"Congrats on the Series A"*
to someone who never raised is worse than sending nothing — it tells the
recipient your data is wrong while you're selling them your data.

So verification runs in **code**:

- Facts reach the writer as a closed set, passed by index.
- Every figure, date, name and event is checked against that set. Rounding is
  allowed; a new number is not.
- **Two true facts may not be welded into a third claim.** "$750M raised" plus
  "$44B valuation" does not license "raised at a $44B valuation" unless one fact
  says so.
- Relationship claims ("great speaking last week") are blocked outright.
- A shared-investor fact may not be compressed into second person ("backed both
  of you") — that silently asserts the fund also backs *us*.
- Anything unresolved after one corrective retry **downgrades** to
  `template_only` and returns your template untouched.

## Measured

| | |
| --- | --- |
| Unsupported claims | **0** across two 10-case adversarial audits; 147 logged calls total |
| p95 latency | **6.9s** warm (20 runs) |
| `template_only` rate | **12%** on a 25-row cold list (target was <40%) — *but see below* |
| Cost per message | ~4.6 Fundable credits, $0.006 Exa, ~$0.003 tokens |
| Tests | 67 offline |

**Read the 12% sceptically.** The PRD says a rate *much* lower than 40% probably
means the confidence gate is too loose — and my fixture used four
ubiquitously-funded reference companies, so investor-overlap fired on nearly every
row. A real cold list would settle whether it's the fixture or the gate. Flagged
in `HANDOFF.md`.

---

## Status

**Built:** all four triggers, evidence + confidence, claim verification, ties,
Exa enrichment, Supabase cache + request log with 90-day retention, bearer auth,
rate limit, internal-identity guard, streaming, demo UI, operator guide.

**Not built, deliberately:** sending (never), async queue + webhooks (no caller
needs it yet), multi-tenant voice (v1 is internal).

**Blocked on Jacob:** the voice. See **`HANDOFF.md`** — that's the file to read
first if you're Jacob.

## Docs

| File | For |
| --- | --- |
| **`HANDOFF.md`** | **Jacob** — what I need, the two decisions, and my blunt read |
| **`FINDINGS.md`** | Whoever owns the Fundable API — 8 reproducible issues, 4 silent |
| `/guide` (in-app) | Whoever runs a demo — checklist, script, troubleshooting |
| `BUILD_LOG.md` | Engineers — every contract correction and defect, with reasoning |
| `PRD.md` | The original spec |

## Before deploying this anywhere

- The **rate limit is in-memory**, so on serverless each instance keeps its own
  counter and 120/hour becomes meaningless. It would need to count `pz_log` rows.
- The **latency hedge doubles LLM calls** on slow draws. Fine at demo volume.
- `config/sender/EXAMPLE_not_real_customers.json` contains well-known companies
  that are **not** Fundable customers. It exists to exercise the investor-overlap
  mechanic. Do not point production at it.
- Verification is pattern-based. Three adversarial audits found three distinct
  defect classes; a fourth would likely find a fourth. **Re-run the audit after
  any prompt or voice change** — treat that as part of the change.

## Layout

```
packages/fundable-shared/   Fundable client, alias tables, claim checker,
                            evidence verifier, Exa client, OpenRouter, voice loader
apps/api/                   Next.js 16 on :3111
  src/app/api/personalize/  the endpoint (+ /stream)
  src/lib/pipeline/         resolve → facts → ties → confidence → angle → write+verify
  src/lib/pipeline/triggers.ts   per-trigger evidence policy, in one table
config/voice/jacob.json     the voice. Data, not code.
config/sender/              named sender_context blocks
supabase/migrations/        pz_cache + pz_log (applied + verified)
```

No secrets are committed. `.env` is git-ignored; `.env.example` carries
placeholders only.
