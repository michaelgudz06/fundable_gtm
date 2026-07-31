/**
 * Stage 3: TIE — the personal connection between the sender and the prospect.
 * Fully deterministic: computed from data, never inferred by a model.
 *
 * This is the stage that justifies the product. Exa alone yields the same
 * generic personalization every competitor ships ("saw your post about X").
 * A shared investor is a join across two datasets, and Fundable owns the half
 * nobody else has (PRD §1).
 *
 * ---------------------------------------------------------------------------
 * THE INVESTOR JOIN RUNS BACKWARDS, ON PURPOSE.
 * ---------------------------------------------------------------------------
 * `/investors` exposes no portfolio companies and `/deals` cannot be filtered by
 * investor (both probed, both 422 on every shape tried). There is no
 * investor → companies direction in the API at all.
 *
 * So instead of asking "what else did this fund back", we resolve OUR OWN
 * reference customers once, cache their `all_investor_ids`, and intersect that
 * cached set against the prospect's `all_investor_ids` — which arrives free with
 * the company lookup we already made. `/investors` is then called only for the
 * ids that survive the intersection, purely to get fund names for the copy.
 * That is 1-2 credits per prospect instead of 54.
 */

import {
  cityOf,
  companiesByDomains,
  investorsByIds,
  roundLabel,
  type Company,
  type Ledger,
  type Person,
} from "@fundable/shared";
import type { ExaPerson } from "@fundable/shared";

import { CACHE_TTL_MS, type Storage } from "../storage";
import type { SenderContext } from "./facts";

export type TieKind = "shared_investor" | "same_city" | "same_stage" | "repeat_founder";

export type Tie = {
  kind: TieKind;
  /** The citable sentence. Stated flatly; the writer may only restate it. */
  fact: string;
  /** Which dataset produced it — becomes the evidence card's source badge. */
  source: "fundable" | "exa";
  endpoint?: string;
  url?: string;
  confidence: number;
};

const CUSTOMER_INVESTORS_CACHE_KEY = "sender:customer-investors";

/**
 * Resolve the sender's reference customers to their all-time investor sets.
 * Cached under the Fundable TTL (30d) and keyed on the domain list, so adding a
 * customer invalidates it rather than serving a stale intersection.
 */
async function customerInvestorSets(
  sender: SenderContext,
  storage: Storage,
  ledger: Ledger
): Promise<{ sets: { domain: string; name: string; investorIds: string[] }[]; warnings: string[] }> {
  const domains = (sender.customer_domains ?? []).filter(Boolean);
  if (!domains.length) return { sets: [], warnings: [] };

  const key = `${CUSTOMER_INVESTORS_CACHE_KEY}:${[...domains].sort().join(",")}`;
  const cached = (await storage.cacheGet(key, "fundable")) as
    | { domain: string; name: string; investorIds: string[] }[]
    | null;
  if (cached?.length) return { sets: cached, warnings: [] };

  const warnings: string[] = [];
  const res = await companiesByDomains(domains.slice(0, 100), ledger);
  warnings.push(...res.warnings.map((w) => `sender_context customer: ${w}`));

  const sets: { domain: string; name: string; investorIds: string[] }[] = [];
  for (const [domain, company] of res.found) {
    const investorIds = company.all_investor_ids ?? [];
    if (investorIds.length) sets.push({ domain, name: company.name, investorIds });
  }

  if (sets.length) await storage.cacheSet(key, "fundable", sets, CACHE_TTL_MS.fundable);
  return { sets, warnings };
}

/** Founder-ish titles, for the repeat-founder tie. */
const FOUNDER_TITLE = /\b(co[- ]?founder|founder|founding\s+(?:partner|engineer|member))\b/i;

function sameCompany(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const x = norm(a);
  const y = norm(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

export async function computeTies(input: {
  company: Company | null;
  person: Person | null;
  exaPerson: ExaPerson | null;
  sender: SenderContext | null;
  storage: Storage;
  ledger: Ledger;
}): Promise<{ ties: Tie[]; warnings: string[] }> {
  const { company, person, exaPerson, sender, storage, ledger } = input;
  const ties: Tie[] = [];
  const warnings: string[] = [];

  if (!sender) return { ties, warnings };

  // ---- shared investor ----------------------------------------------------
  if (company?.all_investor_ids?.length) {
    const { sets, warnings: custWarnings } = await customerInvestorSets(sender, storage, ledger);
    warnings.push(...custWarnings);

    const prospectSet = new Set(company.all_investor_ids);
    // investorId -> the customers that share it
    const overlap = new Map<string, string[]>();
    for (const set of sets) {
      if (sameCompany(set.name, company.name)) continue; // don't tie a company to itself
      for (const id of set.investorIds) {
        if (!prospectSet.has(id)) continue;
        overlap.set(id, [...(overlap.get(id) ?? []), set.name]);
      }
    }

    if (overlap.size) {
      // Hydrate only the survivors — the whole point of the inverted join.
      const hydrated = await investorsByIds([...overlap.keys()].slice(0, 5), ledger);
      for (const [id, customers] of overlap) {
        const investor = hydrated.found.get(id);
        if (!investor?.name) continue;
        const shared = [...new Set(customers)];
        ties.push({
          kind: "shared_investor",
          // "both A and B" only reads correctly for a single overlap; with more
          // than one the sentence needs a proper list, or it comes out as
          // "both Ramp and Anthropic and Stripe and Figma".
          fact:
            shared.length === 1
              ? `${investor.name} is an investor in both ${company.name} and ${shared[0]}.`
              : `${investor.name} is an investor in ${company.name}, and also in ${listPhrase(shared)}.`,
          source: "fundable",
          endpoint: "/investors",
          confidence: 1.0,
        });
        if (ties.filter((t) => t.kind === "shared_investor").length >= 2) break;
      }
    }
  }

  // ---- same city ----------------------------------------------------------
  const prospectCity = company ? cityOf(company) : null;
  const senderCity = sender.home_city ?? null;
  if (prospectCity && senderCity && prospectCity.toLowerCase() === senderCity.toLowerCase()) {
    ties.push({
      kind: "same_city",
      // Phrased as a shared fact rather than "X is in New York, the same city as
      // our team in New York" — which is what the naive version produced live.
      fact: `${company!.name} and ${sender.sender_city_label ?? "the sender"} are both based in ${prospectCity}.`,
      source: "fundable",
      endpoint: "/companies",
      confidence: 1.0,
    });
  }

  // ---- same stage ---------------------------------------------------------
  const stages = (sender.target_stages ?? []).map((s) => s.toLowerCase());
  const round = company?.latest_deal ? roundLabel(company.latest_deal) : null;
  if (round && stages.length && stages.some((s) => round.includes(s))) {
    ties.push({
      kind: "same_stage",
      fact: `${company!.name}'s latest round is a ${round}, the stage this sender focuses on.`,
      source: "fundable",
      endpoint: "/companies",
      confidence: 1.0,
    });
  }

  // ---- repeat founder -----------------------------------------------------
  // Fundable's own `employment_history` comes back EMPTY even for well-documented
  // careers (probed), so this tie is only computable from Exa's person index.
  // Gated on identity: an unconfirmed employer means we may be reading a
  // different person's career, and attributing a stranger's history to the
  // prospect is exactly the failure this product cannot afford.
  if (exaPerson && person?.name) {
    if (!exaPerson.employerConfirmed && company) {
      warnings.push(
        "Skipped the repeat-founder tie: Exa's person match could not be confirmed against the prospect's employer."
      );
    } else {
      const currentCompany = company?.name ?? person.current_company?.name ?? null;
      const priorFounded = exaPerson.workHistory.filter(
        (w) =>
          w.title &&
          FOUNDER_TITLE.test(w.title) &&
          w.company &&
          !sameCompany(w.company, currentCompany)
      );
      const earliest = priorFounded.sort((a, b) => (a.from ?? "").localeCompare(b.from ?? ""))[0];
      if (earliest?.company) {
        const years = [earliest.from?.slice(0, 4), earliest.to?.slice(0, 4)].filter(Boolean);
        const span = years.length === 2 ? ` (${years.join("-")})` : years.length === 1 ? ` (from ${years[0]})` : "";
        ties.push({
          kind: "repeat_founder",
          fact: `${exaPerson.name} was ${earliest.title} at ${earliest.company}${span} before ${currentCompany ?? "their current company"}.`,
          source: "exa",
          ...(exaPerson.url ? { url: exaPerson.url } : {}),
          // Below 1.0: a career-history record is a weaker claim than a
          // funding round Fundable recorded itself.
          confidence: 0.85,
        });
      }
    }
  }

  return { ties, warnings };
}

/** "A", "A and B", "A, B, and C" — Oxford comma, matching the voice profile. */
function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** The strongest tie, for the cold trigger's default angle. */
export function bestTie(ties: Tie[]): Tie | null {
  const RANK: Record<TieKind, number> = {
    shared_investor: 0,
    repeat_founder: 1,
    same_stage: 2,
    same_city: 3,
  };
  return [...ties].sort((a, b) => RANK[a.kind] - RANK[b.kind])[0] ?? null;
}
