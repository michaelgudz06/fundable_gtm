# Handoff — what I need from you, and what I'd decide

Short version: the machine works and is measured. What it's missing is **your
voice and your judgement calls**, and neither is something I can supply.

---

## The one thing that matters

### Your sent emails (or the `jacob voice` skill)

**10–20 real cold emails you've sent**, ideally across trigger types.

Right now the voice profile is inferred from your LinkedIn posts, because that's
all there was. Cold email is a different register — your posts open with a number
designed to survive truncation; a cold email opens quietly and asks once. So the
copy currently reads competent and generic rather than like you.

Every API response carries a warning saying exactly this, and it disappears on
its own the moment the profile is derived from real examples.

**This is the difference between a working demo and something you'd actually
send.** Everything below is smaller.

---

## Two decisions that are yours

### 1. Which customers may be named in outbound?

The highest-value angle available is investor overlap — *"Insight Partners is an
investor in both your company and X."* It's the one thing a competitor with only
web search cannot produce, because it needs your investor graph.

It's currently **dormant.** `config/sender/default.json` has an empty
`customer_domains`, because a domain listed there **can appear in an email**, and
that's your call to make, not mine.

Give me a list of referenceable customers and the angle switches on.

### 2. Lead investor: quote it, or extract it?

Your API has no structured lead-investor field (see `FINDINGS.md` §7). The lead
exists only as prose: *"...raised $750 million in a Series F at a $44 billion
valuation led by ICONIQ, GIC, and Ontario Teachers' Pension Plan."*

- **Quote the sentence** — safe, already citable, zero extraction risk. Reads
  slightly stiff.
- **Extract the names** — reads better, and naming the wrong fund as lead is
  exactly the credibility-destroying error the verification layer exists to
  prevent.

I built it to quote, on the principle that the safe default should be the
default. Say the word and I'll switch it.

---

## What I'd tell you if you asked me to be blunt

**The confidence gate may be too loose.** Your own PRD says a `template_only`
rate *much* lower than 40% probably means exactly that. I measured 12%, and the
confidence distribution across 147 logged calls clusters hard at the top (35 at
0.95, 33 at 0.90).

Two explanations and I can't yet distinguish them:

1. My test fixture used four ubiquitously-funded reference companies, so
   investor-overlap fired on almost every row.
2. The gate genuinely is too loose.

**A real cold list of yours settles it in one run.** That's worth more than any
feature I could add this week.

---

## Not built, deliberately

| | Why |
|---|---|
| **Sending anything** | Not a milestone, ever. This returns copy. A human sends it, and the n8n layer only creates drafts. |
| **Async queue + webhooks** | Needed for sequencer volume, not for manual use or the demo. No caller needs it yet. |
| **Multi-tenant voice** | v1 is internal tooling, one voice. A second voice is a config file, not a refactor. |
| **Deployment** | Runs on localhost. See the caveats in the README before deploying — the rate limit is in-memory and would become meaningless on serverless. |

---

## A gift for whoever owns the API

`FINDINGS.md` documents **eight reproducible issues** found while building on
Fundable's REST API, four of which fail silently rather than erroring. The worst:
a blank identifier in `/people` returns the entire 365k-row dataset and hands
back an arbitrary stranger as row 0, billed 1 credit.

That one produces a wrong name and a wrong employer in a real customer email, and
nothing in the response indicates a problem. Worth forwarding.

---

## If you want to use it this week

The realistic path is the n8n wiring, which is roughly an afternoon:

```
Fundable deal alert → n8n webhook → POST /api/personalize
  → if confidence ≥ 0.5: create a Gmail draft in your account + note on the HubSpot contact
  → else: notify with the template so you decide
```

Your experience becomes: **a draft appears in your inbox.** You read it, edit if
you want, hit send. You never see this API.

I'd need access to the n8n instance and permission to create drafts (drafts only)
in your Gmail.
