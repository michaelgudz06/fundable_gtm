/**
 * ICP inputs shared across the codebase.
 *
 * This file used to hold a SECOND classifier: the legacy 17-label taxonomy
 * ported from the Python scripts, whose rule 3 read "VCs, angels, and investors
 * are not a target". The v2 registry makes #19 Investor a core ICP, so keeping
 * both meant one deployment answered the same question two contradictory ways —
 * the "#19 conflict" the spec's References flag as migration-only, and a direct
 * failure of the acceptance criterion that one identity yields one label.
 *
 * The taxonomy now lives in exactly one place: config/registry/icp_registry.json,
 * read by apps/api/src/lib/v2/registry.ts. What remains here is the input-side
 * plumbing both paths need — the freemail list, the research questions, and the
 * error type that keeps an outage from being reported as a verdict.
 */

import { answer, ExaError, type ExaLedger } from "./exa.js";

/**
 * Infrastructure failure during classification. Distinct from "Not Core ICP",
 * which is a JUDGMENT. QA caught the difference the hard way: a dead fetch was
 * returned as a confident Not Core verdict with HTTP 200, which a caller would
 * happily write to HubSpot. A failure must surface as an error the caller can
 * retry, never as a label.
 */
export class ClassificationError extends Error {
  constructor(message: string, readonly cause_kind: "model" | "research") {
    super(message);
    this.name = "ClassificationError";
  }
}
import { MODEL_PLAN, complete, parseJson, type Usage } from "./openrouter.js";

// ---------------------------------------------------------------------------
// Taxonomy — names must match the Python scripts EXACTLY. They are written to
// HubSpot's `icp_segement` property, so a renamed ICP silently splits the data.
// ---------------------------------------------------------------------------

/**
 * Personal-email domains. A freemail address carries no company signal, so the
 * email-only path refuses rather than guessing — the Python script skips these
 * outright and so does this.
 */
export const FREEMAIL = new Set([
  // Webmail
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "rocketmail.com",
  "outlook.com", "hotmail.com", "live.com", "msn.com", "icloud.com", "me.com",
  "mac.com", "aol.com", "aim.com", "proton.me", "protonmail.com", "pm.me",
  "yandex.com", "gmx.com", "gmx.net", "gmx.de", "mail.com", "zoho.com",
  "fastmail.com", "hushmail.com", "tutanota.com", "juno.com", "netzero.net",
  // ISP mailboxes. These look corporate to a naive check — the real list had
  // four of them — and treating one as an employer makes the pipeline research
  // the ISP and discard the employer the caller actually supplied.
  "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "bellsouth.net",
  "cox.net", "charter.net", "centurytel.net", "centurylink.net", "optonline.net",
  "snet.net", "earthlink.net", "roadrunner.com", "rr.com", "frontier.com",
  "windstream.net", "btinternet.com", "sky.com", "virginmedia.com", "shaw.ca",
  "telus.net", "sympatico.ca", "rogers.com", "t-online.de", "web.de",
  "orange.fr", "free.fr", "wanadoo.fr", "laposte.net", "libero.it", "tiscali.it",
  // Regional webmail
  "yahoo.co.uk", "yahoo.ca", "yahoo.com.au", "yahoo.co.in", "hotmail.co.uk",
  "live.co.uk", "naver.com", "qq.com", "163.com", "126.com", "sina.com",
  "uol.com.br", "bol.com.br", "terra.com",
]);

export function isFreemail(domain: string): boolean {
  return FREEMAIL.has(domain.trim().toLowerCase());
}


/**
 * Bumped whenever either research question changes.
 *
 * The wording is load-bearing, not cosmetic: this query used to lead with "does
 * it primarily sell to startups?", which rejected a Vice Chairman at CBRE from
 * an ICP whose evidence gate is `none`. Rewording it moved CRE recall from 1/15
 * to 8/15, and a cache keyed without this would keep serving verdicts reached
 * under the old question.
 */
export const RESEARCH_QUERY_VERSION = "2";

export function companyResearchQuery(domain: string): string {
  return `What is the company at domain ${domain}? Describe its industry and what it does, what it sells and to whom (its typical customers), and its approximate size in employees.`;
}

/**
 * Research by company NAME, for leads whose address is personal. A gmail lead
 * is not an unknown lead — the visitor list still names their employer — and
 * without this the gated ICPs (#1, #17, #18 and the startup-customer set) can
 * never be confirmed, so every such lead fails closed for want of a lookup.
 *
 * The name is quoted and length-capped: it is caller-supplied text entering a
 * search query, and a "company name" of two paragraphs is not a company name.
 */
export function companyResearchQueryByName(name: string): string {
  // Quotes are stripped, not escaped: the name is delimited by quotes in the
  // query, so a name containing one would otherwise close the delimiter early
  // and the remainder would read as part of our question.
  const clean = name
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/["'`“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `What does the company "${clean}" do, and does it primarily sell to startups or venture-backed companies? Is it a small company or a large enterprise? If several companies share this name, describe the most likely one and say that the match is uncertain.`;
}
