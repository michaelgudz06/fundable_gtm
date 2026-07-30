/**
 * Stage 2: ENRICH -> the closed fact set. Deterministic.
 *
 * Every fact is an Evidence row: the same objects go to the angle picker, the
 * writer, the verifier, and the response's evidence array. One source of truth
 * is what makes "every claim traces to a source" checkable rather than aspirational.
 *
 * M1 cost note: for post-raise, everything below comes from the /companies row
 * (plus /people when a LinkedIn URL was given) — the embedded latest_deal carries
 * the round, the date, and the lead-investor prose. No /deals or /investors call,
 * so a typical uncached request is 1-2 credits, not the PRD's 3-6. Deal history
 * and investor hydration join in M3 with the tie computation.
 */

import {
  articleDate,
  cityOf,
  dealDate,
  leadInvestorProse,
  money,
  roundLabel,
  type Company,
  type Evidence,
  type ExaArticle,
  type Person,
} from "@fundable/shared";

import type { Tie } from "./ties";

export type FactTag =
  | "raise"
  | "lead"
  | "valuation"
  | "momentum"
  | "profile"
  | "person"
  | "sender"
  /** Stage-3 output: a computed connection between sender and prospect. */
  | "tie"
  /** Exa-sourced dated news. */
  | "recency";

export type Fact = Evidence & { tag: FactTag };

export type SenderContext = {
  id: string;
  sender_facts: string[];
  /**
   * Reference customers for the investor-overlap inversion (ties.ts).
   *
   * A domain listed here MAY BE NAMED IN OUTBOUND COPY. Only add companies the
   * sender is allowed to reference publicly.
   */
  customer_domains?: string[];
  /** Sender's city, for the same-city tie. */
  home_city?: string;
  /** How to refer to the sender's location in copy ("our team in New York"). */
  sender_city_label?: string;
  /** Round labels this sender targets, for the same-stage tie ("seed", "series a"). */
  target_stages?: string[];
};

export function buildFacts(input: {
  company: Company | null;
  person: Person | null;
  sender: SenderContext | null;
}): { facts: Fact[]; warnings: string[] } {
  const { company, person, sender } = input;
  const facts: Fact[] = [];
  const warnings: string[] = [];

  if (company) {
    const deal = company.latest_deal;
    const date = deal ? dealDate(deal.date) : null;
    const valuationDate = dealDate(company.latest_valuation_date);
    // The valuation prices THIS round only when Fundable's own dates say so.
    // Otherwise stating "raised at a $X valuation" is a join the data never
    // made — the conflation the M1 acceptance audit caught on stripe.com.
    const valuationPricesRound = !!(
      company.latest_valuation_usd &&
      date &&
      valuationDate === date
    );

    // The dated round fact — the anchor of the post-raise trigger.
    if (deal && date) {
      const label = roundLabel(deal);
      const article = /^[aeiou]/i.test(label) ? "an" : "a";
      const amount = deal.total_round_raised ? ` of ${money(deal.total_round_raised)}` : "";
      const atValuation = valuationPricesRound
        ? ` at a ${money(company.latest_valuation_usd)} valuation`
        : "";
      facts.push({
        tag: "raise",
        fact: `${company.name} raised ${article} ${label} round${amount}${atValuation} on ${date}.`,
        source: "fundable",
        endpoint: "/companies",
        confidence: 1.0,
      });
    } else if (deal && !date) {
      warnings.push(`${company.name} has a latest deal with no usable date; skipping the round fact.`);
    }

    // Lead investors exist only as prose (probe finding). Quote the sentence —
    // it is already citable and parsing it is exactly the extraction risk the
    // verify stage exists to prevent.
    const prose = deal ? leadInvestorProse(deal) : null;
    if (prose) {
      facts.push({
        tag: "lead",
        fact: prose,
        source: "fundable",
        endpoint: "/companies",
        confidence: 1.0,
      });

      // Fundable disagreeing with itself (seen live: Anthropic's structured
      // amount says $50B, its own deal prose says $65B). Both facts stay — each
      // is individually citable — but the caller should know the source split.
      if (deal?.total_round_raised) {
        const proseAmounts = extractDollarAmounts(prose);
        const structured = deal.total_round_raised;
        const matches = proseAmounts.some(
          (v) => Math.abs(v - structured) / Math.max(v, structured) <= 0.01
        );
        if (proseAmounts.length && !matches) {
          warnings.push(
            `Fundable's structured round amount (${money(structured)}) differs from its own deal description for ${company.name}; both are quoted as evidence, but the discrepancy is upstream.`
          );
        }
      }
    }

    if (company.latest_valuation_usd && !valuationPricesRound) {
      facts.push({
        tag: "valuation",
        // Worded to resist conflation: this figure must not be attached to the
        // latest round, and the sentence says so.
        fact: `${company.name}'s latest disclosed valuation is ${money(company.latest_valuation_usd)}${valuationDate ? ` (as of ${valuationDate})` : ""}. This is Fundable's latest valuation on record, not the price of the latest financing.`,
        source: "fundable",
        endpoint: "/companies",
        confidence: 1.0,
      });
    }

    if (company.total_raised) {
      facts.push({
        tag: "momentum",
        fact: `${company.name} has raised ${money(company.total_raised)} in total.`,
        source: "fundable",
        endpoint: "/companies",
        confidence: 1.0,
      });
    }

    if (company.short_description) {
      const city = cityOf(company);
      facts.push({
        tag: "profile",
        fact: `${company.short_description}${city ? ` Based in ${city}.` : ""}`,
        source: "fundable",
        endpoint: "/companies",
        confidence: 1.0,
      });
    }
  }

  if (person?.name && person.title) {
    const employer = person.current_company?.name ?? company?.name;
    facts.push({
      tag: "person",
      // Slightly below 1.0: titles staleness is the known weakness of people data.
      fact: `${person.name} is ${person.title}${employer ? ` at ${employer}` : ""}.`,
      source: "fundable",
      endpoint: "/people",
      confidence: 0.9,
    });
  }

  // Sender facts ride along so the writer can describe Fundable without the
  // verifier flagging it. They are evidence too — claims about the sender still
  // trace to a source, just not a prospect-data one.
  for (const s of sender?.sender_facts ?? []) {
    facts.push({ tag: "sender", fact: s, source: "sender_context", confidence: 1.0 });
  }

  return { facts, warnings };
}

/** Prospect-fact subset — what the angle picker is allowed to choose from. */
export function prospectFacts(facts: Fact[]): Fact[] {
  return facts.filter((f) => f.tag !== "sender");
}

/** Ties (stage 3) become facts like any other, so verification treats them alike. */
export function tieFacts(ties: Tie[]): Fact[] {
  return ties.map((t) => ({
    tag: "tie" as const,
    fact: t.fact,
    source: t.source,
    ...(t.endpoint ? { endpoint: t.endpoint } : {}),
    ...(t.url ? { url: t.url } : {}),
    confidence: t.confidence,
  }));
}

/**
 * Exa articles become dated, linked facts. The URL rides along so the evidence
 * card can link out — an unlinkable news claim is not auditable.
 */
export function recencyFacts(articles: ExaArticle[], companyName: string | null): Fact[] {
  const out: Fact[] = [];
  for (const a of articles) {
    const date = articleDate(a.publishedDate);
    if (!date) continue; // an undated news claim cannot be cited responsibly
    out.push({
      tag: "recency",
      fact: `${date}: "${a.title}"${companyName ? ` (coverage mentioning ${companyName})` : ""}.`,
      source: "exa",
      url: a.url,
      // Exa relevance is a ranking, not a fact-check: a high-scoring article is
      // still only evidence that the headline exists, which is why the writer is
      // told to treat the headline as a quote rather than as a claim it can extend.
      confidence: Math.min(0.9, 0.5 + a.score * 0.4),
    });
  }
  return out;
}

/** "$750 million" / "$44B" / "$91.5 billion" -> whole-dollar values. */
function extractDollarAmounts(text: string): number[] {
  const MULT: Record<string, number> = {
    k: 1e3, thousand: 1e3,
    m: 1e6, million: 1e6,
    b: 1e9, bn: 1e9, billion: 1e9,
    t: 1e12, trillion: 1e12,
  };
  const out: number[] = [];
  for (const m of text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion|trillion|bn|[kmbt])?\b/gi)) {
    const base = Number(m[1]?.replace(/,/g, ""));
    if (!Number.isFinite(base)) continue;
    const suffix = m[2]?.toLowerCase();
    out.push(suffix ? base * (MULT[suffix] ?? 1) : base);
  }
  return out;
}
