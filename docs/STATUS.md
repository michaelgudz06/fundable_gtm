# ICP Personalization API — status

**2026-08-01** · live at `personalize-api-umber.vercel.app` · registry 2.4.0

---

## Where it stands

The API is built, deployed and measured against §6. Six of the seven acceptance
clauses pass on evidence. The two that do not are **definitional rather than
engineering** — one asks us to beat a baseline that cannot be beaten as
written, the other asks for gold-set coverage the visitor traffic does not
contain. Both need a decision from you; neither is fixed by more building.

The most useful thing found in this phase is not an accuracy number. It is that
**the visitor feed already carries job titles, and we were not sending them.**
That is a one-line change on the Orange Slice side worth roughly 4× on
core-ICP recall.

---

## §6 acceptance

| clause | | evidence |
|---|---|---|
| Same normalized identity → same label on every caller | **pass** | `/api/classify` and `/api/v1/personalize` share one version-keyed cached decision. A fixture caught the earlier bug where `/api/classify` re-voted per call. |
| 100% hard-rule fixtures | **pass** | 21/21 live (`scripts/run-hard-rules.ts`) |
| Zero critical grounding / template failures | **pass** | 26/26 live contract cases |
| 100% schema-valid; no unresolved variables; no empty-name greetings | **pass** | 26/26 live + 123 offline tests |
| p95 ≤ 15s with supplied LinkedIn | **pass** | p95 **1.01s** warm, 5.85s cold |
| Meet/exceed frozen Orange Slice baseline | **needs a decision** | see below |
| Gold set composition | **partially met** | see below |

Also: **25/25 agreement** on the 29-row hand-labelled visitor list, zero
disagreements in either direction.

---

## The finding that matters most

The Orange Slice export carries these fields:

| field | fill rate (1511 rows) |
|---|---|
| **Title** | **78.8%** |
| Company Name | 86.4% |
| LinkedIn URL | 98.8% |

Every benchmark this project produced assumed otherwise. `run-icp-benchmark`
stated it in its own header — *"This API received only an email and a LinkedIn
URL"* — and the ceiling test scraped titles out of the reference classifier's
reasoning prose rather than reading the column sitting next to it. The
conclusion drawn from those numbers, that the accept path was blocked on the
identification vendor supplying titles, was wrong.

Paired run over 136 identical rows, same API, only the request body differs:

| | email + linkedin | + title + company |
|---|---|---|
| Agreement with reference | 35.3% | **55.1%** |
| **Core-label recall** | **9.4%** | **37.5%** |
| Reached any core verdict | 17.7% | 45.8% |
| Not Core held | 97.5% | **97.5%** |

That last row is the control. The recall gain is not bought by the classifier
becoming less discriminating — precision on Not Core is identical across both
arms. Rows recovered include Vice Chairman at CBRE, Partner at Tech Square
Ventures, VP Venture Lending at Avidbank, Founder & CEO at Bytemine.

**No code change is required.** `/api/v1/personalize` already accepts `title`
and `company_name`. This is a change to what the Orange Slice column sends.

---

## Two decisions we need from you

### 1. The Orange Slice baseline cannot be met as written

§6 says *"meet/exceed frozen Orange Slice baseline (macro-F1, Not Core
precision)"*. Two problems:

- **No baseline was ever supplied**, and Orange Slice has never been scored
  against human labels — so there is no number to meet.
- **Scored against our gold set, it gets 46/46 — 100%.** That is not a
  measure of quality; the gold set was built by a human reviewing Orange
  Slice's proposals, so its own answers are true by construction. Any
  criterion of the form "beat this" is unsatisfiable.

Worth knowing what the reference actually is: Orange Slice is an AI spreadsheet
where each column is a natural-language agent prompt. The "classifier" is a
prompt in a cell, unversioned, and different the moment someone edits it. A
frozen baseline is not a thing it can produce.

**Proposed:** replace the clause with *"establish our own frozen baseline from
a blind-labelled gold set and do not regress."* We can then measure both
classifiers fairly, which is the useful version of the question.

### 2. "≥5 positives per core label" is unreachable from visitor traffic

Across all 1511 rows, Orange Slice labels 100 as core (6.6%). By label:

- **Zero rows: #7 Investor Finder, #10 Cross-Border Payments, #17 Startup
  Legal, #18 Startup Marketing & PR.**
- Nine more labels have between 1 and 4.
- Only #2 (15), #6 (35), #19 (23) and #16 (5) clear five.

No amount of mining fixes this — those buyers do not visit the site in
measurable numbers. Those rows have to be **authored against real companies**,
which is how the hard-rule fixtures already work.

`Not Core` is the opposite case: 1189 available, so the ≥40 requirement is
trivial whenever we want it.

---

## What the accuracy numbers mean, and don't

Current gold set: **v3, 71 rows.**

| metric | value |
|---|---|
| macro-F1 | 0.479 |
| Exact accuracy | 56.5% |
| Not Core precision | 32.5% |
| Hard-rule (boundary) accuracy | 95.5% |

**These measure agreement with Orange Slice, not accuracy.** 46 of the gold
set's rows are its proposals ratified by a human reviewer who could see those
proposals. Where we disagree, we have not yet established who is right — and
roughly 20 disagreements remain unadjudicated. Most are cases where the
reference committed to a core label and we answered `Not Core`; given the
reference labels only 6.6% of visitors as core, it is not obvious which side is
being too conservative.

**No baseline has been frozen.** Freezing one now would bake in whichever of us
is wrong.

For context on how these numbers moved, three defects were found and fixed in
the gold set itself, none of them in the classifier: titles were being scraped
from prose instead of read from a column; ten boundary rows used `example-*.com`
addresses and therefore could never satisfy an evidence gate; and one label had
been recorded as the opposite of the rule it existed to pin. Correcting those
took macro-F1 from 0.185 to 0.479 with no change to the API.

---

## Other things closed this phase

- **HubSpot picklist verified** against the live `ICP Segment` property rather
  than inherited from the deleted Python port. All 17 legacy mappings were
  correct; both proposed strings for the new labels were wrong — the real
  internal names are `Investor` (no numeric prefix) and `20 - Startup GTM`.
  Both would have failed to write silently.
- **One taxonomy across both surfaces.** The legacy 17-label classifier —
  whose rule 3 read *"VCs, angels, and investors are not a target"*, directly
  contradicting v2's `#19 Investor` — is deleted. Both routes now classify
  against the same registry.
- **Bounded deadlines** on every upstream fetch, with a per-request budget, so
  the p95 target is structural rather than lucky.
- **Deterministic hard rules.** Exclusions, evidence gates and catch-all
  precedence are post-checked against the registry after the model answers,
  rather than existing only as prompt prose.

---

## What is left

1. **Wire `title` + `company_name` into the Orange Slice payload.** Highest
   value on the board; a config change, not engineering.
2. **Adjudicate the ~20 open disagreements** against the LinkedIn profiles.
   This tells us whether 56.5% is us under-committing or the reference
   over-labelling — and it is the prerequisite for any honest baseline.
3. **Blind-label a fresh sample** so the gold set stops inheriting the
   reference's answers, then freeze a baseline.
4. **Author boundary rows** for the four labels visitor traffic never contains.
5. **Sign-off on `approved_claims.json`** (still `pending_review`, still
   build-blocked) and on the `#6` vs `#9` precedence question, which the
   registry leaves undefined.

---

## Verification

Everything above is reproducible:

```bash
npm test                                    # 123 offline
npx tsx scripts/contract-check.ts           # 26 live contract cases
npx tsx scripts/run-hard-rules.ts           # 21 hard-rule fixtures
npx tsx scripts/run-testset.ts              # the 29-row labelled list
npx tsx scripts/evaluate-gold-set.ts        # macro-F1 vs the gold set
npx tsx scripts/benchmark-real-titles.ts --csv <export.csv>
```
