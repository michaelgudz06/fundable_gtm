/**
 * Evidence-grounded claim verification.
 *
 * post-studio's `claims.ts` (ported verbatim alongside this file) answers "did
 * the model make an unsupported *comparison*". That was the right question for a
 * LinkedIn post about a data slice. Cold outbound asks a stricter one:
 *
 *   Does EVERY factual assertion in this message trace to the closed evidence set?
 *
 * The stakes are different too. A wobbly comparison in a post is embarrassing.
 * "Congrats on the Series A" to someone who never raised is worse than sending
 * nothing at all, because it tells the recipient Fundable's data is wrong — while
 * selling them Fundable's data.
 *
 * So verification runs in CODE, not in the prompt. The prompt is asked to behave;
 * this file checks whether it did. Anything unresolved after one corrective retry
 * downgrades the response to `template_only` rather than shipping.
 *
 * Severity:
 *   "block" — a concrete, checkable assertion with no support. Downgrades.
 *   "warn"  — heuristic suspicion (an unrecognised proper noun). Surfaced to the
 *             caller but never downgrades on its own, because the proper-noun
 *             check is the fuzziest one here and a false block would make the
 *             endpoint useless.
 */

import { findUnsupportedClaims } from "./claims.js";

export type EvidenceSource = "fundable" | "exa" | "sender_context" | "caller_template";

export type Evidence = {
  fact: string;
  source: EvidenceSource;
  endpoint?: string;
  url?: string;
  confidence: number;
};

export type Severity = "block" | "warn";

export type VerifyIssue = {
  quote: string;
  reason: string;
  severity: Severity;
  kind:
    | "number"
    | "money"
    | "year"
    | "month"
    | "comparison"
    | "relationship"
    | "entity"
    | "style"
    | "conflation"
    | "pronoun_scope";
};

export type VerifyInput = {
  copy: string;
  subject?: string | null;
  evidence: Evidence[];
  /** Caller-supplied template. Its own numbers and names are theirs, not ours. */
  template?: string | null;
  /** Names we are always allowed to write: the prospect, their company, the sender. */
  allowedNames?: string[];
  /** From the voice profile. */
  forbiddenPhrases?: string[];
  /**
   * The sender's own company. Needed to catch second-person compression: "backed
   * both of you" only holds if evidence actually places an investor in the
   * SENDER's company, not merely in a third-party reference company.
   */
  senderCompany?: string | null;
};

// ---------------------------------------------------------------------------
// Numeric normalisation
// ---------------------------------------------------------------------------

const MULTIPLIER: Record<string, number> = {
  k: 1e3,
  thousand: 1e3,
  m: 1e6,
  mm: 1e6,
  million: 1e6,
  b: 1e9,
  bn: 1e9,
  billion: 1e9,
  t: 1e12,
  trillion: 1e12,
};

/**
 * Matches "$750M", "750 million", "$44 billion", "3,577,000,000", "12%".
 * Deliberately greedy about scale words so "$750M" and "$750 million" and
 * "750000000" all collapse to the same value.
 */
const NUMERIC =
  /(\$?\s*\d[\d,]*(?:\.\d+)?)\s*(k|mm|m|bn|b|t|thousand|million|billion|trillion)?\b|\b(\d{1,3}(?:\.\d+)?)\s*%/gi;

type NumericMention = { raw: string; value: number; isPercent: boolean };

function extractNumerics(text: string): NumericMention[] {
  const out: NumericMention[] = [];
  for (const m of text.matchAll(NUMERIC)) {
    if (m[3] !== undefined) {
      out.push({ raw: m[0].trim(), value: Number(m[3]), isPercent: true });
      continue;
    }
    const rawNum = m[1];
    if (rawNum === undefined) continue;
    const base = Number(rawNum.replace(/[$,\s]/g, ""));
    if (!Number.isFinite(base)) continue;
    const suffix = m[2]?.toLowerCase();
    const value = suffix ? base * (MULTIPLIER[suffix] ?? 1) : base;
    out.push({ raw: m[0].trim(), value, isPercent: false });
  }
  return out;
}

/**
 * Money is rounded for prose ("$3.58B" for 3,577,000,000), so an exact match is
 * the wrong test. Anything within 1% counts as the same figure, which admits
 * honest rounding while still rejecting an invented number.
 */
function supportsValue(allowed: NumericMention[], mention: NumericMention): boolean {
  return allowed.some((a) => {
    if (a.isPercent !== mention.isPercent) return false;
    if (a.value === mention.value) return true;
    const scale = Math.max(Math.abs(a.value), Math.abs(mention.value));
    if (scale === 0) return false;
    return Math.abs(a.value - mention.value) / scale <= 0.01;
  });
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const YEAR = /\b(19|20)\d{2}\b/g;

function monthsIn(text: string): Set<string> {
  const found = new Set<string>();
  const lower = text.toLowerCase();

  // Month names as written.
  for (const m of MONTHS) {
    if (new RegExp(`\\b${m}\\b`).test(lower)) found.add(m);
  }
  // ISO dates carry a month implicitly: 2026-06-04 -> june.
  for (const iso of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const idx = Number(iso[2]) - 1;
    const name = MONTHS[idx];
    if (name) found.add(name);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Claims that imply a relationship we cannot have
// ---------------------------------------------------------------------------

/**
 * These are not factual errors the evidence can settle; they are assertions
 * about a shared history. In a genuinely cold email every one of them is false,
 * and each is the kind of thing that gets a sender marked as spam.
 */
const RELATIONSHIP: { re: RegExp; label: string }[] = [
  { re: /\b(?:as|like) (?:we|I) (?:discussed|mentioned|spoke)\b/i, label: "implies a prior conversation" },
  { re: /\b(?:following|circling|checking) (?:up|back)\b/i, label: "implies a previous message" },
  { re: /\bgreat (?:speaking|talking|meeting|chatting)\b/i, label: "implies a prior meeting" },
  { re: /\b(?:we|I) met (?:at|in|during)\b/i, label: "implies having met" },
  { re: /\bour (?:mutual|shared) (?:friend|connection|contact)\b/i, label: "asserts a mutual connection not in evidence" },
  { re: /\bper (?:our|your) (?:last|previous)\b/i, label: "implies prior correspondence" },
  { re: /\bthanks for (?:your (?:time|reply|email)|getting back)\b/i, label: "implies they already replied" },
  { re: /\b(?:you|your team) (?:reached out|signed up|requested)\b/i, label: "asserts an action by them that must come from evidence" },
  { re: /\bI(?:'ve| have) been following (?:you|your)\b/i, label: "unverifiable claim about the sender's own behaviour" },
];

// ---------------------------------------------------------------------------
// Proper nouns
// ---------------------------------------------------------------------------

/**
 * Words that start a sentence, or that are simply capitalised in normal English,
 * are not evidence of an invented entity. This list keeps the entity check from
 * drowning in false positives — it is why that check is "warn" and not "block".
 */
const CAP_STOPWORDS = new Set([
  "i", "hi", "hey", "hello", "the", "a", "an", "and", "but", "or", "so", "if", "it",
  "we", "you", "your", "they", "their", "our", "this", "that", "these", "those",
  "there", "here", "what", "when", "where", "why", "how", "who", "which",
  "just", "also", "then", "now", "since", "because", "while", "after", "before",
  "series", "seed", "round", "pre", "ext", "extension", "co", "ceo", "cto", "vp",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  ...MONTHS,
  "congrats", "congratulations", "thanks", "thank", "best", "regards", "cheers",
  "let", "would", "could", "happy", "worth", "open", "quick", "one", "two", "three",
  "no", "not", "yes", "maybe", "either", "both", "most", "many", "some", "any",
]);

const PROPER_NOUN = /\b([A-Z][A-Za-z0-9&'’-]*(?:[.&]?\s+[A-Z][A-Za-z0-9&'’-]*)*)\b/g;

function extractProperNouns(text: string): string[] {
  const out = new Set<string>();

  // Split on sentence boundaries FIRST. Allowing "." inside a token let the
  // regex glue "…Anthropic." to "Fundable is…" and report "Anthropic. Fundable"
  // as an invented entity — a false positive flagged by the M3 audit. Noisy
  // warnings are worse than none: reviewers learn to skip them.
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    for (const m of sentence.matchAll(PROPER_NOUN)) {
      const phrase = m[1]?.trim().replace(/[.\s]+$/, "");
      if (!phrase) continue;
      const tokens = phrase.split(/\s+/);
      const meaningful = tokens.filter(
        (t) => !CAP_STOPWORDS.has(t.replace(/[.'’&-]/g, "").toLowerCase())
      );
      if (!meaningful.length) continue;
      out.add(meaningful.join(" ").replace(/[.\s]+$/, ""));
    }
  }
  return [...out];
}

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function verifyCopy(input: VerifyInput): VerifyIssue[] {
  const issues: VerifyIssue[] = [];
  const copy = `${input.subject ? input.subject + "\n" : ""}${input.copy}`;

  // Everything the writer was allowed to know, as one searchable corpus.
  const evidenceText = input.evidence.map((e) => e.fact).join("\n");
  // The caller's own template is theirs; we do not audit their numbers or names.
  const supportCorpus = `${evidenceText}\n${input.template ?? ""}`;

  const allowedNumerics = extractNumerics(supportCorpus);
  const allowedMonths = monthsIn(supportCorpus);
  const allowedYears = new Set(Array.from(supportCorpus.matchAll(YEAR), (m) => m[0]));

  // --- numbers -------------------------------------------------------------
  for (const mention of extractNumerics(copy)) {
    // Bare small integers are usually prose ("one quick question", "2 things"),
    // not data claims, and blocking them creates noise without safety.
    if (!mention.isPercent && mention.value < 1000 && !/[$%]/.test(mention.raw)) continue;

    if (!supportsValue(allowedNumerics, mention)) {
      issues.push({
        quote: mention.raw,
        reason: `the figure ${mention.raw} does not appear in the evidence supplied for this message`,
        severity: "block",
        kind: mention.isPercent ? "number" : /\$/.test(mention.raw) ? "money" : "number",
      });
    }
  }

  // --- years and months ----------------------------------------------------
  for (const y of copy.matchAll(YEAR)) {
    const year = y[0];
    if (!allowedYears.has(year)) {
      issues.push({
        quote: year,
        reason: `the year ${year} is not in the evidence; a dated claim must come from a dated fact`,
        severity: "block",
        kind: "year",
      });
    }
  }
  for (const month of monthsIn(copy)) {
    if (!allowedMonths.has(month)) {
      issues.push({
        quote: month,
        reason: `"${month}" is not the month of any dated fact in the evidence`,
        severity: "block",
        kind: "month",
      });
    }
  }

  // --- relationship claims -------------------------------------------------
  for (const { re, label } of RELATIONSHIP) {
    const hit = copy.match(re);
    if (hit) {
      issues.push({ quote: hit[0], reason: label, severity: "block", kind: "relationship" });
    }
  }

  // --- unsupported comparisons (ported checker) ----------------------------
  // Reused as-is: the patterns are register-independent, and a "record pace"
  // claim is exactly as unsupported in an email as in a post.
  const supportingNumbers = allowedNumerics.map((n) => n.raw);
  for (const c of findUnsupportedClaims(copy, supportingNumbers)) {
    issues.push({ quote: c.quote, reason: c.reason, severity: "block", kind: "comparison" });
  }

  // --- round/valuation conflation -------------------------------------------
  // Caught live in the M1 acceptance audit: "closed an equity round on Feb 27,
  // at a disclosed valuation of $91.5B" — both facts individually supported,
  // but no single fact priced THAT round at THAT valuation. Joining two true
  // facts makes a third claim the evidence never made, and for a company whose
  // valuation moved after its last round the join is simply false.
  //
  // Rule: a sentence that binds a round to a valuation is only supported when
  // ONE fact (or the caller's template) states both together, with the figures.
  const ROUND_WORD = /\b(?:round|series\s+[a-z0-9]+(?:-\d+)?|seed|pre-seed)\b/i;
  const BINDS = new RegExp(
    `(?:${ROUND_WORD.source}[^.!?\\n]{0,60}?\\bvaluation\\b|\\bvaluation\\b[^.!?\\n]{0,60}?${ROUND_WORD.source})`,
    "i"
  );
  const jointFacts = [...input.evidence.map((e) => e.fact), input.template ?? ""].filter(
    (f) => ROUND_WORD.test(f) && /\bvaluation\b/i.test(f)
  );
  for (const sentence of copy.split(/(?<=[.!?])\s+/)) {
    if (!BINDS.test(sentence)) continue;
    const moneys = extractNumerics(sentence).filter((m) => !m.isPercent && /[$]/.test(m.raw));
    const supported = jointFacts.some((fact) => {
      const factNumerics = extractNumerics(fact);
      return moneys.every((m) => supportsValue(factNumerics, m));
    });
    if (!supported) {
      issues.push({
        quote: sentence.trim(),
        reason:
          "binds a round to a valuation, but no single evidence fact states them together — joining separate facts creates a claim the evidence never made",
        severity: "block",
        kind: "conflation",
      });
    }
  }

  // --- valuation figure presented as a round size ---------------------------
  // The second conflation variant, also caught live: subject "stripe's $91.5b
  // round" — the $91.5B is the VALUATION, worn as if it were the amount raised.
  // A reader takes "$X round" / "raised $X" as money raised, so a figure used
  // that way must be supported as a raise amount, not merely present somewhere.
  const MONEY_TOKEN = /\$\s?\d[\d,]*(?:\.\d+)?\s*(?:thousand|million|billion|trillion|bn|mm|[kmbt])?/gi;

  // A figure is valuation-owned only when DIRECTLY attached to the word:
  // "$44B valuation", "at a $91.5B valuation", "valuation of/is/at $X". A blunt
  // proximity window misclassified "$100M at a $1B valuation" — the $100M is
  // the raise, only the $1B prices — and false-blocked an honest draft (caught
  // live on shopify.com in the second acceptance run).
  const valuationOwned = (text: string, start: number, end: number): boolean => {
    const after = text.slice(end, end + 28);
    const vIdx = after.search(/\bvaluation\b/i);
    // Owned from the left ("$X ... valuation") only if nothing in between is
    // another dollar figure — the nearer figure owns the word.
    const ownedLeft = vIdx >= 0 && vIdx <= 20 && !/[$]/.test(after.slice(0, vIdx));
    const before = text.slice(Math.max(0, start - 24), start);
    const ownedRight = /valuation\s+(?:of|is|at|:)?\s*$/i.test(before);
    return ownedLeft || ownedRight;
  };

  // Values the corpus supports AS raise amounts: money in a fact that also
  // carries a raise/round token, excluding valuation-owned figures. The
  // caller's template is their own copy and is exempt as usual.
  const raiseAmounts: NumericMention[] = [];
  for (const factText of [...input.evidence.map((e) => e.fact), input.template ?? ""]) {
    if (!ROUND_WORD.test(factText) && !/\braised?\b/i.test(factText)) continue;
    for (const m of factText.matchAll(MONEY_TOKEN)) {
      const at = m.index ?? 0;
      if (valuationOwned(factText, at, at + m[0].length)) continue;
      const parsed = extractNumerics(m[0]);
      if (parsed[0]) raiseAmounts.push(parsed[0]);
    }
  }

  // Money used in raise position in the copy: "$X ... round/series/seed" or
  // "raised ... $X", with a short window so ordinary prose doesn't trip it.
  const RAISE_POSITION = [
    new RegExp(`(${MONEY_TOKEN.source})(?=[^.!?\\n]{0,15}${ROUND_WORD.source})`, "gi"),
    // Noun and gerund forms too: "their raise at $91.5B" misleads the same way.
    new RegExp(`\\brais(?:e|ed|ing)\\b[^.!?\\n]{0,25}?(${MONEY_TOKEN.source})`, "gi"),
  ];
  for (const re of RAISE_POSITION) {
    for (const m of copy.matchAll(re)) {
      const raw = m[1];
      if (!raw) continue;
      const at = m.index ?? 0;
      const rawStart = at + m[0].indexOf(raw);
      // Explicitly labeled as a valuation: BINDS covers that join instead.
      if (valuationOwned(copy, rawStart, rawStart + raw.length)) continue;
      const value = extractNumerics(raw)[0];
      if (!value) continue;
      if (!supportsValue(raiseAmounts, value)) {
        issues.push({
          quote: raw.trim(),
          reason: `presented as an amount raised, but no evidence fact states ${raw.trim()} was raised — if this is the valuation, it must be labeled as one`,
          severity: "block",
          kind: "conflation",
        });
      }
    }
  }

  // --- second-person compression -------------------------------------------
  // Caught by the M3 cold-list audit on three subject lines: the body correctly
  // said "an investor in both Revolut and Anthropic", but the SUBJECT compressed
  // it to "dragoneer backed both of you". In a 1:1 email signed by one person,
  // "both of you" reads as recipient + sender — so it silently asserts the fund
  // also backs the SENDER's company, which no evidence supports.
  //
  // No figure, date, or name is wrong in that sentence; the pronoun reassigns who
  // the claim is about. That is why the other checks cannot see it.
  const SHARED_SECOND_PERSON: { re: RegExp; label: string }[] = [
    { re: /\bboth of (?:you|us)\b/i, label: '"both of you/us" includes the sender in the relationship' },
    { re: /\bbacke?d?\s+both\s+of\b/i, label: "asserts an investor backed both the recipient and the sender" },
    { re: /\byou and (?:i|me|us)\b/i, label: "pairs the recipient with the sender" },
    { re: /\bwe(?:'ve| have)? both\b/i, label: "asserts something shared between sender and recipient" },
    { re: /\bboth our\b/i, label: "asserts a shared attribute between sender and recipient" },
    { re: /\bour (?:shared|common) investors?\b/i, label: "asserts the sender shares an investor with the recipient" },
  ];

  // The claim only holds if evidence actually places an investor in the sender's
  // own company. Sender-context facts describe what the sender DOES, never who
  // funds it, so in practice this is never satisfied — but it is checked rather
  // than assumed, so the rule stays correct if that ever changes.
  const senderCompany = input.senderCompany?.trim();
  const INVESTOR_WORD = /\b(investor|invests?|backed?|backs|funded|portfolio)\b/i;
  const senderInvestmentSupported =
    !!senderCompany &&
    input.evidence.some(
      (e) =>
        normalizeForMatch(e.fact).includes(normalizeForMatch(senderCompany)) &&
        INVESTOR_WORD.test(e.fact)
    );

  if (!senderInvestmentSupported) {
    for (const { re, label } of SHARED_SECOND_PERSON) {
      const hit = copy.match(re);
      if (!hit) continue;
      issues.push({
        quote: hit[0],
        reason: `${label}, but no evidence names an investor in ${senderCompany ?? "the sender's own company"} — name both parties explicitly instead`,
        severity: "block",
        kind: "pronoun_scope",
      });
    }
  }

  // --- style rules from the voice profile ----------------------------------
  if (copy.includes("—")) {
    issues.push({
      quote: "—",
      reason: "em dash is forbidden in this voice; break the sentence or use a comma or colon",
      severity: "block",
      kind: "style",
    });
  }
  for (const phrase of input.forbiddenPhrases ?? []) {
    if (!phrase) continue;
    const re = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const hit = copy.match(re);
    if (hit) {
      issues.push({
        quote: hit[0],
        reason: `"${phrase}" is on the voice profile's forbidden list`,
        severity: "block",
        kind: "style",
      });
    }
  }

  // --- proper nouns (heuristic, warn only) ---------------------------------
  const allowedEntityBlob = normalizeForMatch(
    [supportCorpus, ...(input.allowedNames ?? [])].join(" ")
  );
  for (const noun of extractProperNouns(copy)) {
    const needle = normalizeForMatch(noun);
    if (needle.length < 3) continue;
    if (!allowedEntityBlob.includes(needle)) {
      issues.push({
        quote: noun,
        reason: `"${noun}" reads as a name but does not appear in the evidence — confirm it is not invented`,
        severity: "warn",
        kind: "entity",
      });
    }
  }

  // De-dupe on quote + kind, keeping the first (blocking beats warning).
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = `${i.kind}|${i.quote.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function blockingIssues(issues: VerifyIssue[]): VerifyIssue[] {
  return issues.filter((i) => i.severity === "block");
}

/**
 * The single corrective retry. Names the offending text and what it must become,
 * and restates the closed-set rule, which is the constraint the model actually
 * broke by producing the issue.
 */
export function correctionPrompt(issues: VerifyIssue[], evidence: Evidence[]): string {
  const blocking = blockingIssues(issues);
  const list = blocking.map((i) => `- "${i.quote}"  ->  ${i.reason}`).join("\n");
  const facts = evidence.map((e, i) => `${i + 1}. ${e.fact}`).join("\n");

  return `That draft contains assertions the evidence does not support:

${list}

These are the ONLY facts you have. There are no others:

${facts}

Rewrite the message. Keep the structure, the voice, and the single ask. Remove every
flagged assertion, or replace it with something the facts above actually state.

Do not substitute a different specific detail. If removing the flagged text leaves you
without a personalized opener, write a shorter message that makes no factual claim about
the recipient at all. A short honest message is the correct outcome here; an invented
detail is not.

Return only the corrected message.`;
}
