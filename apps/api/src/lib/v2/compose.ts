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

/** Lowercase for prose WITHOUT destroying acronyms: "Startup GTM" -> "startup GTM". */
export function proseCase(name: string): string {
  return name
    .split(" ")
    .map((w) => (/^[A-Z0-9&]{2,}$/.test(w) ? w : w.toLowerCase()))
    .join(" ");
}

/** Joins a clause into a sentence that already supplies its own terminator. */
function unterminated(text: string): string {
  return text.replace(/[.!?]+\s*$/, "");
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
    company_or_generic: ctx.company_name ?? "your team",
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
    primary_use_case_clause: useCase
      ? `${proseCase(useCase.name)} — for example: ${unterminated(useCase.example_alert)}`
      : "a deal alert matched to the companies you care about",
  };

  let out = body;
  for (const [key, value] of Object.entries(map)) {
    out = out.split(`{{${key}}}`).join(value);
  }

  // Grammar repair for the territory fallback: "the startups" reads fine, but a
  // doubled space or " the the " must not survive. The punctuation collapse is a
  // second line of defence for caller-supplied templates, which we do not control.
  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ ,/g, ",")
    .replace(/\bthe the\b/g, "the")
    .replace(/([.!?])[.]+(?=\s|$)/g, "$1");
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
  const doubled = body.match(/[.!?][.]+/);
  if (doubled) issues.push({ rule: "double-punctuation", detail: doubled[0] });

  for (const m of body.matchAll(/\b(a|an)\s+([A-Za-z][\w&-]*)/g)) {
    const [, article = "", word = ""] = m;
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

export function composeFromTemplate(input: {
  template: TemplateEntry;
  useCases: UseCase[];
  ctx: ComposeContext;
}): { body: string; issues: ComposeIssue[] } {
  const primary = input.useCases[0] ?? null;
  const body = resolveVariables(input.template.body, input.ctx, primary).trim();
  return { body, issues: validateEmailBody(body) };
}

export function composeNotCore(input: {
  messageType: MessageType;
  ctx: ComposeContext;
}): { body: string; issues: ComposeIssue[] } {
  // Approved generic only; no positive ICP claim (GEN-008).
  const body = resolveVariables(genericFallback(input.messageType), input.ctx, null).trim();
  return { body, issues: validateEmailBody(body) };
}
