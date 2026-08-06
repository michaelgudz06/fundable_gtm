# Adjudications

Human verdicts on classifier-versus-reference disagreements, with the evidence
each verdict rests on.

This file exists because of the gap named in [`STATUS.md`](STATUS.md): the gold
set's answers are largely Orange Slice's own proposals ratified by a reviewer who
could see them, so agreement with the reference is not evidence of accuracy.
Until disagreements are adjudicated against the underlying profiles, nobody knows
whether 56.5% exact accuracy means the classifier is under-committing or the
reference is over-labelling — and no honest baseline can be frozen.

**A verdict here outranks both the classifier and Orange Slice.** Record the
evidence, not just the label; an adjudication without its reasoning is no better
than the proposal it replaced.

---

## Round 1 — 2026-08-06

**Source** the `cre` and `investor` presets in `scripts/debug-classify.ts`
**Run** `npx tsx scripts/debug-classify.ts --preset cre` and `--preset investor`,
against the deployed app, registry 2.4.0
**Adjudicated by** Michael (owner)

Both presets were authored to capture leads the reference labelled core and the
classifier did not. On this run only two of the eight still disagreed — the rest
now return a core label. Treat the preset header comments as stale.

| lead | company | classifier | verdict | basis |
|---|---|---|---|---|
| Robert Stillman | CBRE | #2 | **#2** | Undisputed. Vice Chairman at the largest CRE services firm; senior producer-ladder role. |
| Loralie Ogden | CBRE | #2 | **#2** | Undisputed. First VP at CBRE; senior producer role on the deal side. |
| Jack Leeney | 7GC | #19 | **#19** | Undisputed. Managing Partner and co-founder of a growth-stage VC fund; the role list explicitly includes a founder of the fund itself. |
| Roseanne Wincek | Renegade Partners | #19 | **#19** | Undisputed. Co-founder and MD of an early-stage VC fund. |
| Jim McCahon | JLL | Not Core | **#2** | **Owner-adjudicated.** Role description: "Manage lease/sale transactions, landlord negotiations, and financial analysis." That is deal-side production. The title alone does not convey it. See D-2. |
| Scott Lopano | **Tech Square Ventures** | #19 | **#19** | **Owner-corrected employer.** The preset records Sweater Ventures; the correct firm is Tech Square Ventures, an early-stage startup VC. Label holds, evidence did not. See D-3 case B. |
| Poojan Mehta | Person Street Partners | #19 | **Not Core** | **Derived from the registry, not from external judgement.** #19's company gate admits "startup VC fund, angel network, or family office". Person Street is a real-estate investment manager in industrial and rental housing. None of the three. See D-1. |
| Devin Gfeller | *unobtainable* | Not Core | **unresolvable from this identifier** | `gfellerco.com` leads nowhere (owner-confirmed). Research nonetheless returned Geller & Company, a real unrelated firm one letter away, and the verdict rests on that. With a dead domain there is no employer to research, so this row cannot be adjudicated without another signal. See D-3 case A. |

### What this round shows

**Both genuine disagreements resolved against the classifier.** McCahon and
Gfeller were the two rows where the classifier and the reference differed. On
McCahon the reference was right. On Gfeller the classifier's evidence was invalid.
Neither outcome supports the classifier's side.

**One agreement was a shared error.** Mehta returned #19 and the reference
concurs, so every agreement-based metric scores that row as a success. It is
wrong. This is the clearest available demonstration that the current macro-F1 and
exact-accuracy figures cannot see errors the two systems share, and the strongest
argument for blind-labelling a fresh sample before freezing any baseline.

**The error is not one-directional.** The prevailing assumption has been that the
classifier is too conservative. Mehta is an over-fire in a direction nobody was
testing for.

**No failure was a judgement failure.** All three have deterministic causes: a
rule the registry never wrote (D-1), an input never supplied (D-2), and evidence
attached to the wrong company (D-3). That is a better position than a model that
reasons poorly — each is fixable in configuration or plumbing.

### What this round does *not* establish

- Eight rows adjudicated. Not a baseline, not a sample size, not a measurement.
- These leads were selected *because* they were disagreements. Nothing here says
  anything about the classifier's behaviour on ordinary traffic.
- Not blind. Each verdict was formed with the classifier's answer visible, which
  is the same methodological flaw that compromised the gold set. A blind pass
  remains necessary.

### Still open

- Devin Gfeller cannot be adjudicated from the recorded identifier: the domain is
  dead. Either supply a LinkedIn URL for the row or drop it from the preset — a
  fixture whose evidence cannot exist proves nothing.
- `STATUS.md` records roughly twenty unadjudicated disagreements. These eight do
  not cleanly subtract from that count: the presets predate current behaviour and
  six of the eight no longer disagree. Re-derive the live disagreement set from a
  current run before assuming what remains.
- Confirm whether #6 versus #9 precedence — recorded as an open question in
  `config/eval/hard_rules.json`, currently resolving to #6 — should be settled by
  registry rule rather than left to the model.
