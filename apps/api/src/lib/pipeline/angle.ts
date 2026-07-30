/**
 * Stage 4: ANGLE — V4-flash picks ONE angle and at most max_facts facts from the
 * closed set (spec §2). Cheap, non-generative-adjacent classification.
 *
 * The model chooses; it does not write. And it can only choose from facts we
 * hand it by index, so a hallucinated pick is structurally impossible — an
 * out-of-range index is discarded, and an empty selection falls back to the
 * deterministic default rather than failing the request.
 */

import { MODEL_PLAN, complete, parseJson, type Usage } from "@fundable/shared";

import { prospectFacts, type Fact, type FactTag } from "./facts";
import { TRIGGER_POLICY } from "./triggers";
import type { Channel, Trigger } from "./types";

export const ANGLES = [
  "the_raise",
  "lead_investor",
  "momentum",
  "company_profile",
  /** M3 angles, unlocked by stage 3 and Exa. */
  "investor_overlap",
  "repeat_founder",
  "shared_city",
  "stage_fit",
  "recent_news",
] as const;
export type Angle = (typeof ANGLES)[number];

export type AnglePick = {
  angle: Angle;
  facts: Fact[];
  usage: Usage | null;
  warnings: string[];
};

/**
 * Which fact tag each angle is *about*. An angle whose subject is not among the
 * chosen facts is a mislabel, not a judgement call. `company_profile` is the
 * catch-all and requires nothing.
 */
const ANGLE_REQUIRES: Partial<Record<Angle, FactTag[]>> = {
  the_raise: ["raise"],
  lead_investor: ["lead"],
  momentum: ["momentum", "valuation"],
  investor_overlap: ["tie"],
  repeat_founder: ["tie"],
  shared_city: ["tie"],
  stage_fit: ["tie"],
  recent_news: ["recency"],
};

/**
 * Deterministic fallback, honouring the trigger's preferences. Used when the
 * model returns nothing usable, when there is only one candidate, and as the
 * ordering for `preferred` tags.
 */
function fallbackPick(
  candidates: Fact[],
  maxFacts: number,
  preferred: FactTag[]
): { angle: Angle; facts: Fact[] } {
  const byTag = (tag: FactTag) => candidates.filter((f) => f.tag === tag);

  // Walk the trigger's preferences first, then a sensible global order.
  const order: FactTag[] = [...preferred, "tie", "raise", "lead", "recency", "momentum", "valuation", "profile", "person"];
  const seen = new Set<FactTag>();
  const ranked: Fact[] = [];
  for (const tag of order) {
    if (seen.has(tag)) continue;
    seen.add(tag);
    ranked.push(...byTag(tag));
  }

  const lead = ranked[0];
  const ANGLE_FOR: Partial<Record<FactTag, Angle>> = {
    tie: "investor_overlap",
    raise: "the_raise",
    lead: "lead_investor",
    recency: "recent_news",
    momentum: "momentum",
    valuation: "momentum",
    profile: "company_profile",
    person: "company_profile",
  };

  return {
    angle: (lead && ANGLE_FOR[lead.tag]) ?? "company_profile",
    facts: ranked.slice(0, maxFacts),
  };
}

export async function pickAngle(input: {
  facts: Fact[];
  trigger: Trigger;
  channel: Channel;
  maxFacts: number;
}): Promise<AnglePick> {
  const warnings: string[] = [];
  const policy = TRIGGER_POLICY[input.trigger];
  const candidates = prospectFacts(input.facts);

  if (!candidates.length) {
    return { angle: "company_profile", facts: [], usage: null, warnings };
  }
  // One candidate needs no model to rank it.
  if (candidates.length === 1) {
    return { ...fallbackPick(candidates, input.maxFacts, policy.preferred), usage: null, warnings };
  }

  const numbered = candidates
    .map((f, i) => `${i}. [${f.tag}] ${f.fact}`)
    .join("\n");

  try {
    const res = await complete(
      [
        {
          role: "system",
          content: `You select the angle for one cold ${input.channel} message. Reply with JSON only: {"angle": "<one of: ${ANGLES.join(", ")}>", "fact_indices": [<at most ${input.maxFacts} indices, strongest first>]}.

Pick the ONE angle the facts best support, and only indices whose facts serve that angle. A specific dated event beats a generic descriptor. Fewer, sharper facts beat more.`,
        },
        {
          role: "user",
          content: `TRIGGER: ${input.trigger} — ${policy.note}

FACTS:
${numbered}

JSON only.`,
        },
      ],
      { model: MODEL_PLAN, maxTokens: 200, temperature: 0.1, hedgeAfterMs: 2500 }
    );

    const parsed = parseJson<{ angle?: string; fact_indices?: unknown[] }>(res.text);
    const angle = ANGLES.includes(parsed.angle as Angle) ? (parsed.angle as Angle) : null;
    const picked = (parsed.fact_indices ?? [])
      .filter((i): i is number => typeof i === "number" && Number.isInteger(i))
      .map((i) => candidates[i])
      .filter((f): f is Fact => f !== undefined)
      .slice(0, input.maxFacts);

    if (!angle || !picked.length) {
      warnings.push("Angle selection returned nothing usable; fell back to the deterministic pick.");
      return { ...fallbackPick(candidates, input.maxFacts, policy.preferred), usage: res.usage, warnings };
    }

    // The model can name an angle the facts it chose do not support (seen live:
    // angle "recent_news" over a Fundable raise fact). The label is not
    // cosmetic — the demo displays it and reply-rate-by-angle is measured on it
    // — so an inconsistent label is corrected to what the facts actually are.
    const pickedTags = new Set(picked.map((f) => f.tag));
    const required = ANGLE_REQUIRES[angle];
    if (required && !required.some((t) => pickedTags.has(t))) {
      const corrected = fallbackPick(picked, input.maxFacts, policy.preferred);
      warnings.push(
        `Angle "${angle}" is not supported by the selected facts (${[...pickedTags].join(", ")}); relabelled "${corrected.angle}".`
      );
      return { angle: corrected.angle, facts: picked, usage: res.usage, warnings };
    }

    return { angle, facts: picked, usage: res.usage, warnings };
  } catch (err) {
    warnings.push(
      `Angle selection failed (${err instanceof Error ? err.message : "unknown"}); fell back to the deterministic pick.`
    );
    return { ...fallbackPick(candidates, input.maxFacts, policy.preferred), usage: null, warnings };
  }
}
