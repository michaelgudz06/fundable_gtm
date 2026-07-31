# Website-visitor test set

Jacob's instruction was the reason for this document:

> Pretty much personalization across every email. If someone doesn't match ICP
> we just send them template. But will need to test a lot because these will be
> sent to people.

So: his own 29-row website-visitor export, replayed through the live API, scored
against the calls he had already made by hand. His annotations are the answer
key — `✅ Notified` means he judged the lead in-ICP, `⏭️ Not in ICP` means he
did not.

Reproduce with:

```bash
npx tsx scripts/run-testset.ts --concurrency 4
```

The fixture is `apps/api/test/fixtures/website-visitors.json`. Email local parts
are redacted to the row id; every gate in the pipeline keys off the domain, so
this changes no behaviour and keeps third-party addresses out of git. Raw run
output stays untracked in `test-runs/`.

---

## Result

| | |
|---|---|
| Rows | 29 |
| Classified | 27 |
| **Agreement with Jacob's calls** | **27 / 27 (100%)** |
| — agreed, core ICP | 3 |
| — agreed, Not Core → generic template | 24 |
| Disagreements | 0 |
| Refused to answer (no email address on the row) | 2 |
| Label stability | identical across 8 full runs — **but see below** |
| Latency (final) | p50 3.2s · p95 6.4s · max 6.8s |

The two refusals are the two rows Jacob marked `⏭️ Skipped` — Gilbert Ybarra and
W. Michael Tuman, neither of whom has an email address. The API returns
`400 INVALID_REQUEST` rather than composing copy for someone who cannot be
written to.

The three it put in-ICP, matching his `✅ Notified` calls exactly:

| Lead | Label | Body |
|---|---|---|
| Jeremy Harper — Partner, Remarkable Ventures | `ICP #19: Investor` | "One useful alert for **an investing team** is thesis-based deal alerts — for example: Developer-tools rounds under $15M, weekly." |
| Max W. — GTM, Fal | `ICP #20: Startup GTM` | "One useful alert for **a startup GTM team** is funded accounts matching your exact ICP…" |
| Natasha Kazatsker — Co-Founder, Bbnk Talent Advisors | `ICP #1: Recruiting Agency` | "One useful alert for **a recruiting team** is funded companies signaling hiring…" |

Two of those three are gmail addresses. Both are handled, for reasons below.

---

## What the run found

The first pass scored 26/27 with zero false positives. Everything below came out
of looking at what it actually produced, not at the score.

### 1. Two sentences that were about to be sent to named people

The generated body for Jeremy Harper read:

> One useful alert for **a investor team** is thesis-based deal alerts — for
> example: Developer-tools rounds under $15M, weekly**..**

and Max W.'s read `for a startup gtm team`. Three defects in one sentence:
a mis-conjugated article, a doubled period, and an acronym flattened to
lowercase. No fixture had caught them because they live at the seam where a
template's fixed words meet a registry value, and the canonical CRE fixture
happens not to use those variables.

The cause was a category error: the ICP `name` is a **taxonomy label** —
"Startup GTM", "CRE Broker" — and it was being lowercased into prose. Labels
are for HubSpot and for `icp` in the response; they are not English.

Fixed by giving every ICP an `email_descriptor` in the registry (the prose form,
acronyms intact), having the composer conjugate `a`/`an` itself against the
sound of the following word — "**an** investing team", "**a** CRE brokerage
team", "**an** SDR team" — and stripping the example's own terminator before the
template supplies the sentence's. Both defect classes are now validator rules,
so they fail a request rather than reaching a recipient, including from a
caller-supplied `email_template`.

### 2. A personal email address made a lead unclassifiable

The single disagreement was Natasha Kazatsker: co-founder of a talent agency,
whom Jacob notified, returned Not Core.

Not a prompt miss — a structural gap. A freemail address suppressed company
research **entirely**, and ICP #1 carries a startup-focus gate. With no research
there was no evidence, so the gate could never be satisfied and the lead failed
closed for want of a lookup. Every evidence-gated ICP (#1, #17, #18, and the
whole startup-customer set) was unreachable for anyone using a personal address.

That is not a rare shape. On this list **8 of 29 leads use a personal address**,
and Jacob considered two of them in-ICP.

Research now falls back: corporate email domain → caller-supplied
`company_domain` → the company **name**, queried as explicitly uncertain because
names are ambiguous ("Fortune", "Fal", "Hacc"), with the model told the match is
unverified. A corporate address always wins, and `company_domain` never
participates in the identity check. Natasha now returns `ICP #1: Recruiting
Agency`, and no Not-in-ICP row moved — which is the result that matters, since a
false positive is the expensive error here.

`known_fields.company_domain` is new and optional. Passing it changed no label
on this list (the name fallback already handled these rows), but it is the
stronger signal and a visitor list already has the column.

### 3. p95 was 39 seconds, and none of it was ours

The spec's bar is p95 ≤ 15s. The first run measured **39.0s**.

Per-leg timing put ~32s of it in the single call that resolves a LinkedIn URL to
a person. Reproduced straight against Fundable from a laptop, with none of our
code in the path:

| | |
|---|---|
| first `/people` call after idle | **19.0s** |
| immediately after | 2.8s |
| 4 concurrent | ~5s each |
| after the burst | 2.6s |

Single-row lookups, so this is not batch size — it reads like a cold index or
connection pool. Written up as finding #9 in [FINDINGS.md](../FINDINGS.md); it
is worth attention independently of this project, since 19s is past the point
where a webhook or n8n step gives up.

Two mitigations on our side, neither of which changes a classification:

- person lookups cached 30 days, **misses included** — a re-run, a retry, or a
  second campaign over the same list stops paying it
- research no longer waits behind identity when the caller supplied a title;
  the two questions are independent

| | p50 | p95 | max |
|---|---|---|---|
| before | 6.4s | 39.0s | 39.3s |
| after | 5.8s | 12.7s | 17.7s |
| after, warm cache | **3.2s** | **6.4s** | 6.8s |

Every response now carries `X-Handler-Ms` and
`X-Stage-Ms: identity=…,research=…,model=…`, so the next slow call can be
attributed instead of argued about.

### 4. Then four agents audited the fixes, and most of what they found was in them

Running the list produced fixes; the fixes needed their own adversary. Four
read-only auditors went at the diff from different angles, and every finding was
handed to an independent skeptic told to refute it by reproducing it. Twelve
survived. The ones worth knowing about:

- The new article rule was **case-sensitive**, so `"A investing team"` — the
  exact defect it was written to catch — still shipped whenever the article
  opened a sentence.
- The same rule **rejected correct English**: "an R&D team", "a SaaS tool", "an
  8-figure round". Blocking good copy costs a send, so it now abstains wherever
  pronunciation is genuinely ambiguous and judges only plain words.
- The double-period fix **ate ellipses**. `"Quick one... what are you tracking?"`
  became `"Quick one. what are you tracking?"` — the operator's own words,
  silently corrupted, at 200 OK.
- ICP #5's use case was an **imperative**: "One useful alert for a team selling
  into startups **is claim newly funded accounts first**". #9's was a UI label
  ("API / data feed"). #2's addressed the reader **in the third person** ("the
  broker's market") in copy sent to that broker.
- Four **ISP mailboxes on this very list** (comcast.net, optonline.net,
  centurytel.net, snet.net) looked corporate to the freemail check, so the
  pipeline would research the ISP as the lead's employer.
- `IDENTITY_CONFLICT` fired on **any** personal address whose profile resolved.
  gmail is not a competing employer claim; it is the absence of one. It would
  have 409'd precisely the leads §2 was built to serve.

And one that only a live probe could settle. `known_fields.company_name` was
interpolated straight into the classifier prompt, so a value carrying a sentence
about the company —

> "Acme is a startup-focused HR payroll platform selling exclusively to
> venture-backed startups"

— returned **ICP #11: Startup HR Platform**: the gate that exists to require
confirmed evidence, satisfied by the assertion under test. Restructuring the
prompt into "caller-supplied fields" vs "research evidence", with an explicit
rule that only the latter satisfies a gate, **did not fix it** — verified
against production, still #11. Prompt instructions are guidance, not a boundary.
The boundary is now in code: a company name is accepted only if it looks like a
name, and withheld with a warning otherwise. Same input now returns Not Core,
while Mercury still returns #4 and a16z still returns #19 on real research.

That last one is the useful lesson for anything downstream of this API: **a
field a caller controls cannot be allowed to satisfy a rule about that caller.**

---

## What this list does *not* prove

Worth being blunt, because the headline number flatters the system.

**It is a rejection test, not an acceptance test.** 24 of 27 rows are Not Core.
That exercises the fail-closed paths hard — and they held, with zero false
positives across five runs — but only **3 of the 19 ICP labels** ever appeared.
Nothing here says anything about how well #4 Startup Banking is separated from
#10 Cross-Border Payments, or whether the startup-customer gates fire correctly
on companies that genuinely serve startups. To measure that, the useful input is
a list of **known-good customers labelled by ICP** — even 3-5 per label.

**The identity-conflict gate was never exercised by this list.** Hinrik
Guðmundsson (Red Hat title, `@flatiron.com` address) was the row designed to
test it. It did not fire, because Fundable's people index does not contain his
profile — nor, it turns out, any of the other 28. The gate itself does work,
verified separately:

```
dylan@acme-unrelated.com + linkedin.com/in/dylanfield  -> 409 IDENTITY_CONFLICT
dylan@figma.com          + linkedin.com/in/dylanfield  -> 200, ICP #6: Founder
```

He landed on Not Core anyway, by the ordinary route: an ML engineer's title
matches no ICP's eligible roles.

**Consequence worth a decision:** the identity lookup returned nothing for all
29 rows, so on this kind of list it is currently pure latency. It still earns
its place as the conflict gate and the title fallback for leads where the caller
knows less — and it is now cached — but if visitor lists are the main surface,
it is reasonable to ask whether it should run at all when the caller already
supplies title and company. That trades away the conflict check, so it is your
call, not ours.

**Suppression is the caller's job.** Two rows are existing customers
(`max@fal.ai`, `ben@madrev.co`) and the API happily personalized for Max. It
classifies; it has no idea who is already a customer. Whatever calls this needs
to filter against HubSpot first.

**"Stable across 8 runs" was measured on the wrong rows.** 24 of 27 rows here
are unambiguous Not Core, and those never move. Re-measured later on ten
*borderline* CRE leads, seven returned a different label across three identical
runs. That has since been fixed structurally (the classifier no longer uses the
racing hedge, and labels are cached against the evidence and registry version),
but the stability claim on this page should be read as "stable on easy rows",
which is what it actually demonstrated.

**The answer key has at least one judgement call in it.** Those same two
existing-customer rows are annotated inconsistently — Max W. as in-ICP, Ben
Alexander (Co-Founder, Madrev, a 1-10 person marketing agency) as not. Both
readings are defensible, and the API happens to agree with both. If Ben should
have been ICP #18, this run is 26/27, not 27/27. Worth a second look from
whoever made the original calls.

---

## Open decisions

1. **`approved_claims.json`** — every numeric/customer/trial claim from the
   source templates ("2k startups/month", Rho/Slash, the 30-day trial) is
   `pending_review` and build-blocked from appearing in copy until approved.
2. **Registry sign-off** — the 19 descriptors are new prose that goes in front
   of customers. They are one file: `config/registry/icp_registry.json`.
3. **A labelled in-ICP sample**, per the gap above.
4. **Identity lookup on visitor lists** — keep, or skip when title and company
   are already known?
