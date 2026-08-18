/**
 * Unsupported-claim detector.
 *
 * The voice prompt forbids comparisons the data can't support, but the model
 * breaks that rule roughly half the time when it is reaching for a punchy hook
 * ("AI startups are raising faster than any other sector" off a query that only
 * ever looked at AI). These posts go out under a real person's name, so the
 * rule needs an enforcement mechanism, not just an instruction.
 *
 * Every generation is scanned. A hit triggers one corrective retry, and if the
 * claim survives that, the post is surfaced to Jacob with a visible warning
 * rather than silently published.
 */

type Pattern = { re: RegExp; label: string };

/**
 * Cross-slice comparisons. The query only ever covers one sector/city/stage
 * over one window, so a comparison against anything outside it has no data
 * behind it — regardless of which numbers appear in the rows.
 */
const CROSS_SLICE: Pattern[] = [
  { re: /\bthan (?:any|every) other\b/i, label: "compares against sectors not in the data" },
  { re: /\bno other (?:sector|city|category|market)\b/i, label: "claims about sectors not in the data" },
  { re: /\boutpac(?:ing|ed|es)\b/i, label: "claims one market is outpacing another" },
  { re: /\b(?:at a |setting a )?record (?:pace|high|year|quarter)\b/i, label: "claims a record without a baseline" },
  { re: /\b(?:than|versus|vs\.?) last (?:year|quarter|month)\b/i, label: "compares to a period not queried" },
  { re: /\byear[- ]over[- ]year\b/i, label: "year-over-year claim without prior-period data" },
  { re: /\bhottest\b/i, label: "ranks the sector against others" },
  { re: /\bfastest[- ]growing (?:sector|category|market|space)\b/i, label: "ranks the sector against others" },
  { re: /\bmost active (?:sector|category|market)\b/i, label: "ranks the sector against others" },
  { re: /\b(?:more than )?(?:double|triple|halved?) (?:the|what|last)\b/i, label: "multiplier against an unqueried baseline" },
  { re: /\bcompressed dramatically\b/i, label: "trend claim with no prior-period data" },
  { re: /\b(?:has|have) never been (?:higher|faster|bigger)\b/i, label: "all-time claim with no historical data" },
];

/** Percentages are fine when they came from the data, and invented otherwise. */
const PERCENT = /\b(\d{1,3}(?:\.\d+)?)\s*%/g;

export type ClaimIssue = { quote: string; reason: string };

export function findUnsupportedClaims(post: string, supportingNumbers: string[]): ClaimIssue[] {
  const issues: ClaimIssue[] = [];
  const sentences = post.split(/(?<=[.!?])\s+/);

  for (const sentence of sentences) {
    for (const { re, label } of CROSS_SLICE) {
      if (re.test(sentence)) {
        issues.push({ quote: sentence.trim(), reason: label });
        break; // one flag per sentence is enough
      }
    }
  }

  // A percentage is only allowed if that exact figure was handed to the writer.
  const allowed = new Set(supportingNumbers.map((n) => n.replace(/[^\d.]/g, "")));
  for (const match of post.matchAll(PERCENT)) {
    // Only deviation from the verbatim post-studio port: this repo compiles with
    // noUncheckedIndexedAccess, so the capture group needs narrowing. PERCENT
    // always has group 1 when it matches, so behaviour is unchanged.
    const figure = match[1];
    if (figure === undefined) continue;
    if (!allowed.has(figure)) {
      issues.push({
        quote: match[0],
        reason: `the figure ${match[0]} is not in the data returned for this query`,
      });
    }
  }

  // De-dupe by quote.
  const seen = new Set<string>();
  return issues.filter((i) => {
    if (seen.has(i.quote)) return false;
    seen.add(i.quote);
    return true;
  });
}
