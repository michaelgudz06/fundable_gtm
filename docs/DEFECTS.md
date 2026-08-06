# Defects in this service

Reproducible defects in the personalization API itself. Upstream Fundable API
defects live in [`FINDINGS.md`](../FINDINGS.md) — keep the two separate, because
one is ours to fix and the other is someone else's to forward.

---

## D-1 · ICP #19 accepts investment firms in the wrong asset class

**Found** 2026-08-06, registry 2.4.0 · **Class** silent false positive · **Open**

### What happens

A partner at a private investment firm is labelled `ICP #19: Investor` regardless
of what the firm actually invests in. Real estate, credit, infrastructure — any
non-startup asset class satisfies the label today.

### Reproducing case

```bash
npx tsx scripts/debug-classify.ts --preset investor
```

Poojan Mehta, `Partner/Co-Founder` at `personstpartners.com`. Research resolves
the company correctly:

> Person Street Partners is a boutique **real estate investment management firm**
> based in Raleigh, North Carolina … focusing on the **industrial and rental
> housing** sectors throughout the Carolinas.

Verdict returned: `ICP #19: Investor`. The classifier's own stated reason names
the conflict and proceeds anyway:

> "fitting the Investor ICP **despite the CRE focus**"

That is the model reasoning past a company gate it explicitly recognised did not
fit. The research was correct; the acceptance was not.

### What the registry says

`config/registry/icp_registry.json`, ICP #19:

```json
"company": "startup VC fund, angel network, or family office.",
"evidence_gate": "none"
```

A Carolinas real-estate fund is none of the three permitted company types.

### Why nothing caught it

Two structural gaps, both in `config/registry/icp_registry.json`:

1. **#19 carries no evidence gate.** `"evidence_gate": "none"`. Unlike #4, #5 and
   #10–#16, which require confirmable startup-customer evidence, #19 depends
   entirely on the model honouring prose plus the deterministic post-checks.

2. **No post-check covers asset class.** Only two `exclusion_checks` apply to
   #19 — `vc_newsletter_operator` and `public_market_investor`. Neither pattern
   matches a private real-estate fund: it is not a newsletter, and it is not
   hedge funds, mutual funds or public equities. The `residential_real_estate`
   check would plausibly match "rental housing", but it is scoped
   `"applies_to": [2]` and therefore cannot fire for #19.

The 21 hard-rule fixtures include `exclusion-public-market` and
`investor-wrong-role`. Neither covers wrong asset class, so 21/21 stays green
while this is broken.

### Why it matters more than an ordinary miss

The failure is invisible to every metric currently in use. Macro-F1, exact
accuracy and Not Core precision are all computed against a gold set built from
Orange Slice proposals ratified by a reviewer who could see them. Where the
reference makes the same mistake — and "partner at an investment firm ⇒ investor"
is exactly the mistake a reference would also make — both sides agree and the row
scores as a success.

This is the abstract warning in [`STATUS.md`](STATUS.md) ("these measure
agreement with Orange Slice, not accuracy") with a concrete instance attached. It
is also the strongest available argument for the blind-labelled sample, since
blind labelling is the only method that would have surfaced it.

Downstream, a real-estate investor receives startup-VC messaging — use cases
about tracking funded startups, sent to someone who buys industrial property.

### Options, none applied

Recorded only. The registry change is the owner's call.

- Add an `exclusion_checks` entry for non-startup asset classes scoped
  `"applies_to": [19, 8]`, matching real estate, credit, infrastructure and
  similar. Cheapest, and consistent with how the other exclusions work.
- Or give #19 a real `evidence_gate` requiring confirmed startup/venture
  investing, in the shape used by #4, #5 and #10–#16.
- Either way, add a hard-rule fixture — `exclusion-wrong-asset-class` — so the
  21-fixture suite covers it. Without a fixture the suite stays green through a
  regression.

### Related

Mehta's row is the only one of the eight preset leads whose failure is a rule
gap. The other two failures have different causes — see **D-2** (evidence the
classifier never receives) and **D-3** (evidence attached to the wrong firm).

---

## D-2 · The role description is never used as classification evidence

**Found** 2026-08-06, registry 2.4.0 · **Class** false negative on ambiguous
titles · **Open**

### What happens

Classification sees a title string and company research. It does not see the
profile's role description. For titles whose seniority or function is ambiguous,
the description is the field that resolves them — and it is exactly the set of
titles currently failing.

### Reproducing case

Jim McCahon, `Director, Transactions Management` at `jll.com`. Verdict returned:

```
VERDICT : Not Core ICP
REASON  : The title 'Director, Transactions Management' does not clearly indicate
          deal-side production or leadership of producers …
```

Adjudicated by the owner as **ICP #2: CRE Broker**. The role description that
settles it:

> Senior Transaction Manager and Account Director advising and leading global
> clients. Oversight and optimization of client's global real estate portfolios.
> **Manage lease/sale transactions, landlord negotiations, and financial
> analysis.** Support client activities including strategic planning and lease
> administration. Coordinate flow of client communications and key documentation.

"Manage lease/sale transactions, landlord negotiations, and financial analysis"
is deal-side production. Nothing in the title alone conveys it — at a firm like
JLL, "Transactions Management" can equally denote lease administration and
corporate services, which is precisely what the classifier assumed.

The reasoning was sound for the evidence available. The evidence was incomplete.

### Why it matters

This is the same defect class as the highest-value finding in
[`STATUS.md`](STATUS.md), one level deeper. There, titles were present in the
Orange Slice export and were not being sent; supplying them moved core-label
recall from 9.4% to 37.5% with Not Core precision unchanged at 97.5%. Here a
further field appears to exist and is not being used, and it bears specifically
on the ambiguous cases that remain.

Of the two false negatives among the eight preset leads, this is the one caused
by missing evidence; the other (D-3, case A) is caused by evidence describing the
wrong company. Neither is a judgement failure.

### Options, none applied

Recorded only.

- Establish whether the description is actually available — in the Orange Slice
  export, in the Fundable person record, or only on the profile itself. The
  title finding turned on a field being present and unused; confirm that before
  assuming the same shape.
- If it is available, measure it with a paired run in the manner of
  `scripts/benchmark-real-titles.ts`: identical rows, identical API, description
  supplied in one arm only. Report core-label recall and Not Core precision
  together, so any recall gain is shown not to come from looser matching.
- Watch the opposite risk. A description is long free text from an untrusted
  source, and `CLS-010` treats profile content as evidence and never as
  instructions. Any use of it must run through the same prompt-injection
  handling as other caller-supplied prose.

---

## D-3 · Company evidence attached to the wrong firm

**Found** 2026-08-06 · **Class** wrong evidence, silent · **Open**

Two distinct causes with the same effect: the classifier reasons correctly about
a company that is not the lead's employer. One is a research-resolution failure,
the other is bad fixture data. Both make the affected preset rows untrustworthy
in either direction.

### Case A — a dead domain produces confident research about another company

Devin Gfeller, `commercial real estate broker and principal`, domain
`gfellerco.com`. Research returned:

> **Geller & Company** is a financial services firm based in New York City …

**`gfellerco.com` leads nowhere** (owner-confirmed, 2026-08-06). There is no site
behind it. Geller & Company is a real, unrelated business at `gellerco.com` — one
letter apart.

So the failure is not a near-miss between two live companies. Research was asked
about a domain that does not resolve, and instead of returning nothing it
returned a fluent, citation-backed description of the nearest similarly-spelled
real company. The classifier then reasoned correctly from it and rejected #2,
because a financial services firm fails the commercial-real-estate company gate.

**This is a fail-open, and it is the dangerous direction.** A dead identifier
should yield no company evidence, and no company evidence should fail closed to
`Not Core` — which is what the registry's own cross-cutting rule requires
("Use Not Core ICP when identity or required company evidence is insufficient.
Fail closed."). Instead the pipeline manufactured evidence and reached a
confident verdict through a gate it should never have been able to evaluate.

The label happens to land on `Not Core`, so the row looks harmless. It is not:
the same mechanism on a differently-spelled dead domain can just as easily
manufacture evidence that *passes* a gate and produces a core label with an
invented employer.

**The correct label remains unestablished** and may be unobtainable from this
identifier alone — the domain is dead, so there is no employer to research
without another signal.

It is the same class as the `/people` blank-identifier defect in
[`FINDINGS.md`](../FINDINGS.md): a confident, wrong entity returned with nothing
in the response indicating a problem.

The failure is silent: the research prose reads authoritative, the reasoning is
valid, and nothing signals that the firm described is not the firm asked about.

Worth checking whether domain research verifies the resolved company name
against the domain it was asked about, or accepts the best search match.

### Case B — the fixture records the wrong employer

The `investor` preset in `scripts/debug-classify.ts` records Scott Lopano at
Sweater Ventures. The correct employer is Tech Square Ventures. The returned
`ICP #19` is right on the merits — Tech Square is an early-stage startup VC and
clears the company gate — but it was reached from research on an unrelated
fintech platform.

A row that returns the right answer from the wrong evidence still passes, which
is why this survived.

### Scope

Three of the eight preset leads carry company evidence that is wrong or
unverified. Any conclusion drawn from those presets — in either direction —
inherits that.

### Options, none applied

Recorded only.

- Correct the Lopano entry in `scripts/debug-classify.ts`.
- Re-run Gfeller with the employer supplied explicitly, to confirm the verdict
  flips and isolate resolution as the cause.
- Treat domain-to-company verification as its own reliability question. It is
  adjacent to the `/people` blank-identifier defect in
  [`FINDINGS.md`](../FINDINGS.md): both return a confident, wrong entity with no
  indication anything is amiss.
