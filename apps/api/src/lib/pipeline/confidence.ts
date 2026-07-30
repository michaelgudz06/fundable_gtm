/**
 * Confidence scoring — PRD §7.2, made deterministic and inspectable.
 *
 *   0.8-1.0  company + person resolved, a specific dated fact available
 *   0.5-0.8  company only, or facts are generic
 *   < 0.5    nothing specific -> template_only
 *
 * Deliberately NOT a model call. Coverage is a property of the data we did or
 * did not find, and a score the demo shows Jacob has to be explainable line by
 * line ("0.85 because company + dated raise + person").
 */

import { dealDate, type Company, type Person } from "@fundable/shared";

import type { Tie } from "./ties";
import { TRIGGER_POLICY } from "./triggers";
import type { Trigger } from "./types";

export type ConfidenceResult = { confidence: number; reasons: string[]; warnings: string[] };

/** A post-raise older than this is not really "post-raise" anymore. */
const STALE_RAISE_DAYS = 548; // ~18 months

export function scoreConfidence(input: {
  company: Company | null;
  person: Person | null;
  trigger: Trigger;
  ties?: Tie[];
  recencyCount?: number;
}): ConfidenceResult {
  const { company, person, trigger } = input;
  const ties = input.ties ?? [];
  const policy = TRIGGER_POLICY[trigger];
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (!company && !person) {
    return { confidence: 0, reasons: ["nothing resolved"], warnings };
  }

  let score = 0;

  if (company) {
    score += 0.5;
    reasons.push("company resolved (+0.5)");

    const date = company.latest_deal ? dealDate(company.latest_deal.date) : null;
    if (date) {
      score += 0.2;
      reasons.push(`dated funding fact ${date} (+0.2)`);

      if (policy.penalizeStaleRaise) {
        const ageDays = (Date.now() - new Date(date).getTime()) / 86_400_000;
        if (ageDays > STALE_RAISE_DAYS) {
          score -= 0.15;
          reasons.push("latest raise is stale for a post-raise trigger (-0.15)");
          warnings.push(
            `Latest known raise (${date}) is over 18 months old — weak footing for a post-raise message.`
          );
        }
      }
    } else {
      reasons.push("no dated funding fact (+0)");
    }

    if (company.latest_deal && leadProsePresent(company)) {
      score += 0.05;
      reasons.push("lead-investor prose available (+0.05)");
    }
  } else {
    // Person resolved but employer unknown to Fundable: too thin to personalize
    // honestly. Score lands under the 0.5 gate by construction.
    score += 0.35;
    reasons.push("person only, no company (+0.35)");
  }

  if (company && person) {
    score += 0.15;
    reasons.push("person also resolved (+0.15)");
  }

  // A computed tie is the strongest personalization signal there is — it is the
  // one thing a competitor with only web search cannot produce.
  const usableTies = ties.filter((t) => policy.allowedTies.includes(t.kind));
  if (usableTies.length) {
    const bonus = policy.tieBonus * Math.min(usableTies.length, 2);
    score += bonus;
    reasons.push(
      `${usableTies.length} tie${usableTies.length === 1 ? "" : "s"} (${usableTies
        .map((t) => t.kind)
        .join(", ")}) (+${bonus.toFixed(2)})`
    );
  }

  if ((input.recencyCount ?? 0) > 0) {
    score += 0.05;
    reasons.push(`${input.recencyCount} dated news item(s) from Exa (+0.05)`);
  }

  const confidence = Math.max(0, Math.min(0.95, Number(score.toFixed(2))));
  return { confidence, reasons, warnings };
}

function leadProsePresent(company: Company): boolean {
  const short = company.latest_deal?.description?.short_description;
  return !!short && /\bled by\b/i.test(short);
}

/** The PRD's behavioural thresholds, named so the route reads like the table. */
export const FULL_PERSONALIZATION = 0.8;
export const TEMPLATE_ONLY_BELOW = 0.5;
