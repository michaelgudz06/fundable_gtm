/**
 * Per-trigger policy, in one table.
 *
 * Each trigger is a different claim about WHY we are writing, so each has a
 * different idea of what evidence is fair game. Keeping that in data rather
 * than in scattered conditionals is what makes it auditable — and what makes
 * `website-visitor` provably unable to mention the person (PRD §3).
 */

import type { FactTag } from "./facts";
import type { TieKind } from "./ties";
import type { Trigger } from "./types";

export type TriggerPolicy = {
  /** One line for the angle-selection prompt. */
  note: string;
  /** Fact tags this trigger may use. Anything else is filtered out entirely. */
  allowedTags: FactTag[];
  /**
   * May the writer know WHO the recipient is — their name, greeting name, title?
   *
   * Separate from `allowedTags` because the recipient block is not a fact: it is
   * how the greeting gets written. Withholding the `person` fact while still
   * passing a first name produced "Hi Eric," on an anonymous company-level
   * signal — caught live, which is why this flag exists.
   */
  allowPersonIdentity: boolean;
  /** Tie kinds this trigger may use. */
  allowedTies: TieKind[];
  /** Fact tag the angle picker should reach for first when present. */
  preferred: FactTag[];
  /** Does the raise need to be recent for this trigger to make sense? */
  penalizeStaleRaise: boolean;
  /** May Exa be called? Recency is worth paying for on cold, wasteful on sign-up. */
  useExa: boolean;
  /** Confidence bonus when a tie was found (ties are the strongest signal on cold). */
  tieBonus: number;
};

const ALL_TAGS: FactTag[] = ["raise", "lead", "valuation", "momentum", "profile", "person", "tie", "recency"];

export const TRIGGER_POLICY: Record<Trigger, TriggerPolicy> = {
  "post-raise": {
    note: "They just raised. The round is the reason for writing — acknowledge it plainly and connect Fundable to their moment.",
    allowedTags: ALL_TAGS,
    allowPersonIdentity: true,
    allowedTies: ["shared_investor", "repeat_founder", "same_city", "same_stage"],
    preferred: ["raise", "lead"],
    // A "congrats on the raise" about a four-year-old round is the joke this guards.
    penalizeStaleRaise: true,
    useExa: true,
    tieBonus: 0.05,
  },

  "sign-up": {
    note: "They created an account, so they already know who we are. Do not pitch. Key on what Fundable is useful for at their company's stage, and make the ask about getting them value fast.",
    allowedTags: ALL_TAGS,
    allowPersonIdentity: true,
    allowedTies: ["same_stage", "same_city", "shared_investor", "repeat_founder"],
    preferred: ["profile", "momentum"],
    // They came to us; the age of their last round is irrelevant to the reason for writing.
    penalizeStaleRaise: false,
    // They self-identified and we are not claiming a news hook, so recency is not
    // worth $0.007 per call here.
    useExa: false,
    tieBonus: 0.05,
  },

  "website-visitor": {
    note: "A reverse-IP or form signal at COMPANY level. They did not identify themselves, so assume no intent and never imply they visited, browsed, or showed interest. Company facts only.",
    // Deliberately excludes `person` and `recency`: naming an individual on an
    // anonymous company-level signal is the creepy failure mode, and a personal
    // news hook implies we know who they are.
    allowedTags: ["raise", "lead", "valuation", "momentum", "profile", "tie"],
    // The whole point of this trigger: we do NOT know who is reading.
    allowPersonIdentity: false,
    allowedTies: ["same_stage", "same_city", "shared_investor"],
    preferred: ["profile", "raise"],
    penalizeStaleRaise: false,
    useExa: false,
    tieBonus: 0.05,
  },

  cold: {
    note: "No signal from them at all. Lead with the strongest genuine tie — a shared investor beats everything else. Earn the reply with specificity, not enthusiasm.",
    allowedTags: ALL_TAGS,
    allowPersonIdentity: true,
    allowedTies: ["shared_investor", "repeat_founder", "same_city", "same_stage"],
    // The tie IS the reason for writing on a cold send.
    preferred: ["tie", "raise"],
    penalizeStaleRaise: false,
    useExa: true,
    // Worth more here: on cold outreach a real tie is the difference between
    // personalization and spam.
    tieBonus: 0.1,
  },
};

/**
 * Internal identities that must never be personalized about (spec §0, §6.2).
 * A sign-up webhook fires for Fundable's own team and test accounts too, and
 * writing outbound copy about your own colleagues wastes credits at best.
 */
const INTERNAL_DOMAINS = ["tryfundable.ai", "fundable.ai"];
const INTERNAL_EMAIL_HINTS = [/^test\+/i, /^qa\+/i, /^dev\+/i, /\+test@/i];

export function isInternalIdentity(email: string | undefined): boolean {
  if (!email) return false;
  const lower = email.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  const domain = at >= 0 ? lower.slice(at + 1) : "";
  if (INTERNAL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))) return true;
  return INTERNAL_EMAIL_HINTS.some((re) => re.test(lower));
}
