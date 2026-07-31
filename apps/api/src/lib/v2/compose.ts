/**
 * v2 composer + validator (GEN-001..009, CTX-001..004).
 *
 * Deterministic where possible: variable resolution, fallbacks, greeting rules,
 * and the Not Core path never touch a model. The model is used ONLY to smooth a
 * catalog frame around the selected use case when a frame needs it — and v1
 * ships without that call at all: every seed template resolves deterministically,
 * which is faster, cheaper, and impossible to hallucinate. When a caller
 * supplies a raw email_template with {{opener}}-style free slots, the existing
 * verified writer path handles it under the same claim rules.
 *
 * Validation is the contract's teeth: no unresolved {{token}}, no HTML, no
 * subject line, no empty salutation ("Hey ,"), plain text only.
 */

import type { MessageType, TemplateEntry, UseCase } from "./registry";
import { genericFallback, greetingFallback } from "./registry";

export type ComposeContext = {
  first_name?: string | undefined;
  company_name?: string | undefined;
  territory?: string | undefined;
  target_buyer_role?: string | undefined;
  sender_name?: string | undefined;
  icp_descriptor?: string | undefined;
};

// ---------------------------------------------------------------------------
// English mechanics
//
// These exist because the first run against Jacob's real visitor list produced
// "One useful alert for a investor team is ... weekly.." — two defects that no
// canonical fixture had exercised, in copy addressed to a named human. Grammar
// is not cosmetic here: a template engine that cannot conjugate an article will
// eventually put that sentence in front of a customer.
// ---------------------------------------------------------------------------

/** Letters whose NAME starts with a vowel sound, for acronyms: an SDR, an MCP. */
const VOWEL_SOUND_LETTERS = new Set(["A", "E", "F", "H", "I", "L", "M", "N", "O", "R", "S", "X"]);
/** Written vowels that are pronounced as consonants: a university, a one-off. */
const CONSONANT_ONSET = /^(uni|use|user|usu|eu|ubi|one|once)/i;
/** Silent h: an hour, an honest broker. */
const VOWEL_ONSET = /^(hour|honest|honou?r|heir)/i;

/** "a" vs "an" for the phrase that follows. Handles acronyms and false vowels. */
export function articleFor(phrase: string): "a" | "an" {
  const word = phrase.trim().split(/[\s-]+/)[0] ?? "";
  if (!word) return "a";
  // An all-caps token is read letter by letter: "CRE" -> "see", "SDR" -> "ess".
  if (/^[A-Z]{2,}$/.test(word)) return VOWEL_SOUND_LETTERS.has(word[0] ?? "") ? "an" : "a";
  if (VOWEL_ONSET.test(word)) return "an";
  if (CONSONANT_ONSET.test(word)) return "a";
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/**
 * Lowercase for prose WITHOUT destroying anything that carries meaning in its
 * capitalisation: "Startup GTM" -> "startup GTM", but "Claude/ChatGPT" is left
 * exactly as written. Only a plain Title-Case word is lowered — an acronym, a
 * mixed-case brand, or anything with a digit keeps its shape.
 */
export function proseCase(name: string): string {
  // Lowered only if the capital is positional — a leading capital with no other
  // uppercase after it ("Post-raise" -> "post-raise"). Any interior capital
  // means the capitalisation is carrying meaning ("GTM", "SaaS", "Claude/ChatGPT",
  // "B2B") and the word is left exactly as written.
  return name
    .split(" ")
    .map((w) => (/^[A-Z][^A-Z]*$/.test(w) ? w.toLowerCase() : w))
    .join(" ");
}

/** Joins a clause into a sentence that already supplies its own terminator. */
function unterminated(text: string): string {
  return text.replace(/[.!?]+\s*$/, "");
}

/**
 * The same, for text that will sit inside quotation marks.
 *
 * A quoted example prompt keeps its question mark — "Which funds led rounds
 * here?" is a question and stripping the mark makes it read as a fragment — but
 * a trailing full stop still goes, because the carrier sentence supplies one
 * immediately after the closing quote.
 */
function unterminatedQuoted(text: string): string {
  return text.replace(/\.\s*$/, "");
}

// ---------------------------------------------------------------------------
// Variable resolution
// ---------------------------------------------------------------------------

/**
 * The catalog's variables, each with a grammatical fallback (GEN-005 / CTX-004:
 * a missing value bends the sentence, it never leaves a token or an ugly gap).
 */
function resolveVariables(body: string, ctx: ComposeContext, useCase: UseCase | null): string {
  const greeting = ctx.first_name ? `Hey ${ctx.first_name},` : greetingFallback();
  // The registry's prose form ("startup GTM team"), never the taxonomy label.
  const descriptor = ctx.icp_descriptor ? proseCase(ctx.icp_descriptor) : null;

  const map: Record<string, string> = {
    greeting,
    first_name: ctx.first_name ?? "",
    sender_name: ctx.sender_name ?? "Fundable",
    company_name: ctx.company_name ?? "",
    // "saw you're at your team" was the old fallback's output. A company slot
    // with no company has to name something a person can be *at*.
    company_or_generic: ctx.company_name ?? "your company",
    icp_descriptor: descriptor ?? "team like yours",
    // Article-bearing forms: the template writes "for {{...}}", not "for a {{...}}",
    // so agreement is decided here where the noun is actually known.
    icp_descriptor_phrase: descriptor ? `${articleFor(descriptor)} ${descriptor}` : "a team like yours",
    icp_descriptor_phrase_or_generic: descriptor ? `${articleFor(descriptor)} ${descriptor}` : "your team",
    icp_descriptor_or_generic: descriptor ? `${articleFor(descriptor)} ${descriptor}` : "your team",
    territory_or_generic: ctx.territory ?? "the",
    buyer_contact_clause: ctx.target_buyer_role
      ? `, with verified ${ctx.target_buyer_role} contact info,`
      : ", with verified buyer contact info,",
    // The example already ends in a period; the template supplies the sentence's.
    // An MCP workflow has a prompt, not an alert, and saying "for example: <an
    // alert>" about one would describe a product that does not exist.
    primary_use_case_clause: !useCase
      ? "a deal alert matched to the companies you care about"
      : useCase.workflow_type === "mcp"
        ? `${proseCase(useCase.name)} — for example: "${unterminatedQuoted(useCase.example_prompt)}"`
        : `${proseCase(useCase.name)} — for example: ${unterminated(useCase.example_alert)}`,
  };

  let out = body;
  for (const [key, value] of Object.entries(map)) {
    out = out.split(`{{${key}}}`).join(value);
  }

  // Grammar repair for the territory fallback: "the startups" reads fine, but a
  // doubled space or " the the " must not survive. The punctuation collapse is a
  // second line of defence for caller-supplied templates, which we do not control
  // — but an ellipsis is deliberate punctuation, not a defect, so a run of three
  // is left alone. Rewriting "Quick one... what are you tracking?" into
  // "Quick one. what are you tracking?" corrupts the operator's own words.
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ,/g, ",")
    .replace(/\bthe the\b/g, "the")
    .replace(/(?<![.])([.!?])\.(?![.])(?=\s|$)/g, "$1")
    // A quoted question already ends the sentence: 'is that useful?".' reads as
    // a stutter. The template supplies the period, so drop it after ?" and !".
    .replace(/([?!]")\.(?=\s|$)/g, "$1");
  return out;
}

// ---------------------------------------------------------------------------
// Validation (the fixture list in SPEC-v2 §6 tests exactly these)
// ---------------------------------------------------------------------------

export type ComposeIssue = { rule: string; detail: string };

export function validateEmailBody(body: string): ComposeIssue[] {
  const issues: ComposeIssue[] = [];

  const token = body.match(/\{\{[^}]*\}\}|\{[A-Za-z_]{2,}\}/);
  if (token) issues.push({ rule: "unresolved-variable", detail: token[0] });

  if (/<[a-z][\s\S]*?>/i.test(body)) issues.push({ rule: "no-html", detail: "markup detected" });

  if (/^subject\s*:/im.test(body)) issues.push({ rule: "no-subject-line", detail: "subject header in body" });

  // "Hey ,"/"Hi ,"/"Hey," — the empty-salutation class the spec calls out.
  // A greeting word followed (allowing whitespace) directly by punctuation means
  // no name was resolved. "Hey Reed," does not match: "Reed" precedes the comma.
  // "Hi there," passes for the same reason, which is exactly the approved fallback.
  if (/^(hey|hi|hello)\s*[,!]/i.test(body.trim())) {
    issues.push({ rule: "empty-greeting", detail: body.trim().split("\n")[0] ?? "" });
  }

  if (!body.trim()) issues.push({ rule: "empty-body", detail: "no content" });

  // Both of the following shipped in a real generated body before they were
  // caught by eye. Machine-composed sentences fail at the seams — where a
  // template's fixed words meet a registry value — so the seams get checked.
  // An ellipsis is exempt: three dots are a punctuation mark, two are a defect.
  const doubled = body.match(/(?<![.])[.!?]\.(?![.])/);
  if (doubled) issues.push({ rule: "double-punctuation", detail: doubled[0] });

  // Article agreement, checked only where pronunciation is unambiguous.
  //
  // The composer conjugates registry descriptors, which are clean; this rule
  // exists for copy we did not compose. It therefore judges ONLY plain words —
  // all-lowercase, or a single Title-case word — and skips acronyms, mixed-case
  // brands, digits, and anything hyphenated or ampersanded, where letter-name
  // vs word pronunciation is genuinely ambiguous ("an R&D team", "a SaaS tool",
  // "an 8-figure round" are all correct and must not be rejected). A validator
  // that blocks good copy costs a send; missing an exotic case costs a typo.
  for (const m of body.matchAll(/\b(a|an)\s+([A-Za-z]+)\b/gi)) {
    const [, article = "", word = ""] = m;
    if (!/^[a-z]+$/.test(word) && !/^[A-Z][a-z]+$/.test(word)) continue;
    if (articleFor(word) !== article.toLowerCase()) {
      issues.push({ rule: "article-disagreement", detail: `${article} ${word}` });
      break;
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * The two variables with no grammatical fallback available.
 *
 * Every other variable degrades into a sentence that still reads ({{greeting}}
 * -> "Hi there,", {{company_or_generic}} -> "your company"). A bare name has no
 * such form: "Thanks {{first_name}}." with no name resolves to "Thanks ." — a
 * visibly broken merge field, the classic sign of a machine sending mail. The
 * catalog never uses these bare; a caller's template might, so it is told.
 */
const NO_FALLBACK_AVAILABLE = [
  ["first_name", "use {{greeting}}, which falls back to \"Hi there,\""],
  ["company_name", "use {{company_or_generic}}, which falls back to \"your company\""],
] as const;

function missingContext(templateBody: string, ctx: ComposeContext): ComposeIssue[] {
  return NO_FALLBACK_AVAILABLE.filter(([key]) => templateBody.includes(`{{${key}}}`) && !ctx[key]).map(
    ([key, advice]) => ({
      rule: "missing-context",
      detail: `{{${key}}} has no value and no grammatical fallback — ${advice}, or supply known_fields.${key}`,
    })
  );
}

/**
 * Checks that hold for a caller's template regardless of how the lead classifies.
 *
 * These run BEFORE classification, because a template containing HTML is broken
 * whoever it is addressed to — and because a Not Core lead never reaches the
 * caller-template branch at all, so without this an invalid template would pass
 * silently until the first core lead came along and 422'd in production.
 *
 * Deliberately limited to properties of the template TEXT. Anything needing the
 * resolved context (a missing name, an unsupported claim) is judged later, where
 * the context actually exists.
 */
export function validateTemplateSource(templateBody: string): ComposeIssue[] {
  const issues: ComposeIssue[] = [];
  if (/<[a-z][\s\S]*?>/i.test(templateBody)) issues.push({ rule: "no-html", detail: "markup detected" });
  if (/^subject\s*:/im.test(templateBody)) {
    issues.push({ rule: "no-subject-line", detail: "subject header in template" });
  }
  if (!templateBody.trim()) issues.push({ rule: "empty-body", detail: "no content" });
  return issues;
}

/**
 * Which frame the template should use for this lead.
 *
 * `body` is the ALERT frame — the common case and the historical default. The
 * other two exist because composing an alert sentence around something that is
 * not an alert produces copy that is confidently wrong: an MCP-first ICP read
 * "One useful alert ... is map fundraising market", and a deferred ICP asserted
 * an alert that had never been selected.
 */
function frameFor(template: TemplateEntry, primary: UseCase | null): string {
  if (!primary) return template.body_variants?.none ?? template.body;
  if (primary.workflow_type === "mcp") return template.body_variants?.mcp ?? template.body;
  return template.body;
}

export function composeFromTemplate(input: {
  template: TemplateEntry;
  useCases: UseCase[];
  ctx: ComposeContext;
}): { body: string; issues: ComposeIssue[] } {
  const primary = input.useCases[0] ?? null;
  const frame = frameFor(input.template, primary);
  const body = resolveVariables(frame, input.ctx, primary).trim();
  return {
    body,
    issues: [...missingContext(frame, input.ctx), ...validateEmailBody(body)],
  };
}

export function composeNotCore(input: {
  messageType: MessageType;
  ctx: ComposeContext;
}): { body: string; issues: ComposeIssue[] } {
  // Approved generic only; no positive ICP claim (GEN-008).
  const body = resolveVariables(genericFallback(input.messageType), input.ctx, null).trim();
  return { body, issues: validateEmailBody(body) };
}
