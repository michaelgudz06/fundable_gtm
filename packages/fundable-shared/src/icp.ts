/**
 * ICP classification.
 *
 * Ported from the two Python scripts in `fundable-scripts/`, which are the
 * source of truth for the taxonomy and both prompts:
 *
 *   icp_test.py                 — the TITLED path. Classifies from job title +
 *                                 company, with strict per-ICP role eligibility.
 *   exa_classify_titleless.py   — the EMAIL-ONLY path. All we have is a domain,
 *                                 so it researches the company via Exa /answer
 *                                 and classifies conservatively.
 *
 * The two-tier split is the whole point, and it maps exactly onto the stated
 * constraint of "assuming we only have their email and linkedin":
 *
 *   email + LinkedIn  -> a title is resolvable -> TITLED path   (precise)
 *   email only        -> no title              -> EMAIL-ONLY path (conservative)
 *
 * Same 17 ICPs either way, so a person classified at sign-up gets the same
 * answer as the same person hit by a cold sequence. That consistency is the
 * reason this is an API rather than a copy of the prompt in each surface.
 *
 * ---------------------------------------------------------------------------
 * MODEL NOTE, worth knowing before trusting the numbers: the Python scripts run
 * these prompts on Gemini Flash. This port runs them on DeepSeek V4-flash via
 * OpenRouter, because that is what the rest of this codebase already has wired.
 * The prompts were tuned against Gemini, so agreement is likely but NOT
 * guaranteed. `classifyIcp` records which model produced each verdict so a
 * disagreement can be measured rather than assumed away.
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

export const ICPS = [
  "Recruiting Agency",
  "CRE Broker",
  "Startup Banking",
  "Enterprise AE Selling to Startups",
  "Founder",
  "Investor Finder Agency",
  "Growth Equity / Growth Lending",
  "Startup Data Customer",
  "Cross-Border Payments",
  "Startup HR Platform",
  "Startup Insurance",
  "Startup Compliance",
  "Startup Hiring Platform",
  "Startup Accounting",
  "Other Startup Agency",
  "Startup Legal Services",
  "Startup Marketing & PR Agency",
  "Not Core ICP",
] as const;

export type Icp = (typeof ICPS)[number];

/** HubSpot stores numbered labels; keep the mapping so both agree. */
export const ICP_HUBSPOT_LABEL: Record<Icp, string> = {
  "Recruiting Agency": "1 - Recruiting Agency",
  "CRE Broker": "2 - CRE Broker",
  "Startup Banking": "3 - Startup Banking",
  "Enterprise AE Selling to Startups": "4 - Enterprise AE Selling to Startups",
  Founder: "5 - Founder",
  "Investor Finder Agency": "6 - Investor Finder Agency",
  "Growth Equity / Growth Lending": "7 - Growth Equity / Growth Lending",
  "Startup Data Customer": "8 - Startup Data Customer",
  "Cross-Border Payments": "9 - Cross-Border Payments",
  "Startup HR Platform": "10 - Startup HR Platform",
  "Startup Insurance": "11 - Startup Insurance",
  "Startup Compliance": "12 - Startup Compliance",
  "Startup Hiring Platform": "13 - Startup Hiring Platform",
  "Startup Accounting": "14 - Startup Accounting",
  "Other Startup Agency": "15 - Other Startup Agency",
  "Startup Legal Services": "16 - Startup Legal Services",
  "Startup Marketing & PR Agency": "17 - Startup Marketing & PR Agency",
  "Not Core ICP": "Not Core ICP",
};

/**
 * Personal-email domains. A freemail address carries no company signal, so the
 * email-only path refuses rather than guessing — the Python script skips these
 * outright and so does this.
 */
export const FREEMAIL = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com",
  "proton.me", "protonmail.com", "live.com", "msn.com", "me.com", "yandex.com",
  "gmx.com", "mail.com",
]);

export function isFreemail(domain: string): boolean {
  return FREEMAIL.has(domain.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Prompts — ported verbatim from the Python scripts. Do not paraphrase: the
// role-eligibility clauses and the "do not assume by industry" rules are what
// keep precision up, and they were tuned against real misclassifications.
// ---------------------------------------------------------------------------

export const TITLED_PROMPT = `You are an ICP classifier for Fundable, a startup/investor data product. Classify the lead into EXACTLY ONE ICP by their CURRENT role and company, otherwise "Not Core ICP". Output JSON ONLY: {"icp":"<exact name>","reasoning":"<one sentence>"}.

ICPs (name - eligible roles - company):
Recruiting Agency - Growth/Sales/Partner/BD - recruiting or talent agency serving startups (not in-house recruiters, not F500 staffing).
CRE Broker - Broker/Team Lead/VP/Analyst - commercial real estate firm (JLL, Cushman, CBRE, Newmark, Colliers) in SF/NY/London/Toronto/Austin/Miami (not residential, not property managers).
Startup Banking - AE/BDR/SDR/Growth - bank or fintech whose primary customers are startups (Mercury, Brex, Ramp).
Enterprise AE Selling to Startups - AE only - company must sell to startups/SMBs as primary customer base (confirm, do not assume by industry).
Founder - Founder/Co-founder/CEO - a tech/venture-style startup that could plausibly raise VC. Exclude traditional small businesses, agencies, consultancies, local services, freelancers, retail, lifestyle/ecommerce even if titled Founder/CEO.
Investor Finder Agency - Sales/BD - agency that helps founders raise or find investors (capital intro, pitch coaching, fundraising-as-a-service).
Growth Equity / Growth Lending - Growth/Sales/Partner/Platform/Analyst/Associate - growth equity firm or venture debt/growth lending firm.
Startup Data Customer - Founder/CTO/Product/Engineering ONLY - a startup whose product needs startup/investor data (investor-finder, enrichment, GTM tools for startups). GTM/AE/BDR roles here are NOT targets.
Cross-Border Payments - AE/BDR/SDR/Growth - cross-border payments or FX product targeting startups.
Startup HR Platform - AE/BDR/SDR/Growth - HR/payroll/PEO whose primary customers are startups (Rippling, Deel, Gusto).
Startup Insurance - AE/BDR/SDR/Growth - insurance (D&O, cyber, health) for startups.
Startup Compliance - AE/BDR/SDR/Growth - compliance/security (SOC2, GDPR) selling to startups.
Startup Hiring Platform - AE/BDR/SDR/Growth - hiring/talent platform for startups.
Startup Accounting - AE/BDR/SDR/Growth - accounting product or service for startups (Pilot, Bench).
Other Startup Agency - Sales/BD - any other agency serving primarily startups (fractional CFO, growth, design, ops).
Startup Legal Services - AE/BDR/Growth/Founding team - AI-native law firm or legal services for startups/founders (exclude litigation-only, BigLaw, government, F500/healthcare/finance enterprise).
Startup Marketing & PR Agency - Sales/BD/Growth/Founder/Partner - AI-native marketing/growth/SEO/content/PR agency for venture-backed startups (exclude enterprise/F500 agencies).

Rules: Sells-to-startups is REQUIRED for Startup Banking, Enterprise AE, Cross-Border Payments, Startup HR/Insurance/Compliance/Hiring/Accounting - if you cannot confirm a startup/SMB customer base, output "Not Core ICP", do not assume by industry. Founders have no stage cap. VCs, angels, investors, and VC newsletter operators are "Not Core ICP". One ICP per lead, by current role not background. If the role does not match the ICP eligible roles, it is not that ICP. Use the EXACT ICP name as written above.`;

export const EMAIL_ONLY_PROMPT = `You are an ICP classifier for Fundable, a startup/investor data product. You are given ONLY an email address and web research about the company behind its domain (no job title is known). Classify into EXACTLY ONE ICP if the company clearly and confidently matches, otherwise "Not Core ICP". Output JSON ONLY: {"icp":"<exact name>","reasoning":"<one sentence>"}.

Since we don't know the person's role, be conservative: only classify as an ICP other than Founder if the company research strongly suggests most employees there would plausibly be in a qualifying role (e.g. a small recruiting agency for startups, a CRE brokerage, a fintech selling to startups). Default to "Not Core ICP" if uncertain about the company OR if the company is large/enterprise/diversified where the person's specific role can't be inferred.

ICPs (name - eligible roles - company):
Recruiting Agency - recruiting/talent agency serving startups (not in-house, not F500 staffing).
CRE Broker - commercial real estate firm (JLL, Cushman, CBRE, Newmark, Colliers) in SF/NY/London/Toronto/Austin/Miami.
Startup Banking - bank/fintech whose primary customers are startups (Mercury, Brex, Ramp).
Founder - person likely a Founder/Co-founder/CEO of a tech/venture-style startup that could plausibly raise VC. Exclude traditional small businesses, agencies, consultancies, local services, freelancers, retail, lifestyle/ecommerce.
Investor Finder Agency - agency that helps founders raise/find investors (capital intro, pitch coaching, fundraising-as-a-service).
Growth Equity / Growth Lending - growth equity firm or venture debt/growth lending firm.
Startup Data Customer - a startup whose product needs startup/investor data.
Cross-Border Payments - cross-border payments/FX product targeting startups.
Startup HR Platform - HR/payroll/PEO whose primary customers are startups.
Startup Insurance - insurance product for startups.
Startup Compliance - compliance/security product for startups.
Startup Hiring Platform - hiring/talent platform for startups.
Startup Accounting - accounting product/service for startups.
Other Startup Agency - any other agency serving primarily startups (fractional CFO, growth, design, ops).
Startup Legal Services - AI-native law firm/legal services for startups/founders.
Startup Marketing & PR Agency - AI-native marketing/growth/SEO/PR agency for venture-backed startups.

Rules: VCs, angels, investors, VC newsletter operators = "Not Core ICP". Large/enterprise/diversified companies (banks, F500, big consultancies, media, government) = "Not Core ICP" unless it's specifically a small startup-focused vendor. If in doubt, "Not Core ICP".`;

/** The research question the email-only path asks Exa, ported verbatim. */
export function companyResearchQuery(domain: string): string {
  return `What does the company at domain ${domain} do, and does it primarily sell to startups? Is it a small company or large enterprise?`;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export type IcpPath = "titled" | "email_only" | "skipped";

export type IcpResult = {
  icp: Icp;
  /** HubSpot's numbered form, so both systems agree. */
  hubspot_label: string;
  reasoning: string;
  /** Which prompt produced this. The titled path is materially more precise. */
  path: IcpPath;
  /** What the classifier actually saw. Makes a bad verdict debuggable. */
  inputs: { email?: string; domain?: string; title?: string; company?: string; research?: string };
  /** Recorded because the prompts were tuned on Gemini, not this model. */
  model: string;
  usage: Usage | null;
  warnings: string[];
};

function coerceIcp(raw: unknown): Icp | null {
  if (typeof raw !== "string") return null;
  const hit = ICPS.find((i) => i.toLowerCase() === raw.trim().toLowerCase());
  return hit ?? null;
}

function notCore(reason: string, path: IcpPath, inputs: IcpResult["inputs"], warnings: string[] = []): IcpResult {
  return {
    icp: "Not Core ICP",
    hubspot_label: ICP_HUBSPOT_LABEL["Not Core ICP"],
    reasoning: reason,
    path,
    inputs,
    model: "none",
    usage: null,
    warnings,
  };
}

async function runPrompt(
  system: string,
  user: string
): Promise<{ icp: Icp | null; reasoning: string; usage: Usage; model: string }> {
  const res = await complete(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    // Temperature 0 to match the Python scripts: classification should be
    // reproducible. The racing hedge is NOT for variance, it is for OpenRouter's
    // slow-replica tail — measured 40-80s per classification the first evening
    // this ran without one.
    { model: MODEL_PLAN, maxTokens: 300, temperature: 0, hedgeAfterMs: 4000 }
  );
  const parsed = parseJson<{ icp?: string; reasoning?: string }>(res.text);
  return {
    icp: coerceIcp(parsed.icp),
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    usage: res.usage,
    model: res.model,
  };
}

export type ClassifyInput = {
  email?: string | undefined;
  /** From LinkedIn or Fundable. Its presence is what selects the titled path. */
  title?: string | undefined;
  company?: string | undefined;
  /** Skip the Exa call when the caller already has company research. */
  research?: string | undefined;
};

/**
 * Classify one lead. Picks the path by what is actually known, rather than
 * asking the caller to decide — a caller that guesses wrong gets a
 * confidently-wrong classification from an under-informed prompt.
 */
export async function classifyIcp(
  input: ClassifyInput,
  exaLedger?: ExaLedger
): Promise<IcpResult> {
  const warnings: string[] = [];
  const email = input.email?.trim().toLowerCase();
  const at = email?.lastIndexOf("@") ?? -1;
  const domain = email && at >= 0 ? email.slice(at + 1) : undefined;

  // ---- titled path --------------------------------------------------------
  // A title is the strongest signal in the taxonomy: most ICPs are gated on
  // role, not just company ("Enterprise AE - AE only", "Startup Data Customer
  // - Founder/CTO/Product/Engineering ONLY").
  if (input.title && (input.company || domain)) {
    const inputs = {
      ...(email ? { email } : {}),
      ...(domain ? { domain } : {}),
      title: input.title,
      ...(input.company ? { company: input.company } : {}),
    };
    const lead = [
      email ? `Email: ${email}` : null,
      `Job title: ${input.title}`,
      input.company ? `Company: ${input.company}` : null,
      domain ? `Company domain: ${domain}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const r = await runPrompt(TITLED_PROMPT, lead);
      if (!r.icp) {
        warnings.push("Classifier returned an unrecognised ICP name; defaulted to Not Core ICP.");
        return notCore("classifier returned an unrecognised label", "titled", inputs, warnings);
      }
      return {
        icp: r.icp,
        hubspot_label: ICP_HUBSPOT_LABEL[r.icp],
        reasoning: r.reasoning,
        path: "titled",
        inputs,
        model: r.model,
        usage: r.usage,
        warnings,
      };
    } catch (err) {
      if (err instanceof ClassificationError) throw err;
      throw new ClassificationError(
        `Titled classification failed: ${(err as Error).message.slice(0, 140)}`,
        "model"
      );
    }
  }

  // ---- email-only path ----------------------------------------------------
  if (!domain) {
    return notCore("no email domain supplied, and no title to classify on", "skipped", {}, [
      "Nothing to classify: need an email domain or a job title.",
    ]);
  }
  if (isFreemail(domain)) {
    // Deliberate: a personal address says nothing about who they work for, and
    // guessing from one is exactly how a wrong ICP reaches an email.
    return notCore(`${domain} is a personal email domain, so it carries no company signal`, "skipped", { email, domain }, [
      `Skipped: ${domain} is a freemail domain. Supply a title or a company to classify this lead.`,
    ]);
  }

  let research = input.research;
  if (!research) {
    try {
      const a = await answer(companyResearchQuery(domain), exaLedger);
      research = a.text;
    } catch (err) {
      // A failed research CALL is infrastructure; an empty ANSWER is evidence.
      throw new ClassificationError(
        `Company research failed: ${(err as Error).message.slice(0, 140)}`,
        err instanceof ExaError ? "research" : "model"
      );
    }
  }
  if (!research.trim()) {
    return notCore("company research returned nothing usable", "email_only", { email, domain }, warnings);
  }

  const inputs = { ...(email ? { email } : {}), domain, research };
  try {
    const r = await runPrompt(
      EMAIL_ONLY_PROMPT,
      `Email: ${email}\nCompany domain: ${domain}\nCompany research (web): ${research}`
    );
    if (!r.icp) {
      warnings.push("Classifier returned an unrecognised ICP name; defaulted to Not Core ICP.");
      return notCore("classifier returned an unrecognised label", "email_only", inputs, warnings);
    }
    if (r.icp !== "Not Core ICP") {
      warnings.push(
        "Classified without a job title, so the role side of the ICP definition is unverified. Treat as lower confidence than a titled classification."
      );
    }
    return {
      icp: r.icp,
      hubspot_label: ICP_HUBSPOT_LABEL[r.icp],
      reasoning: r.reasoning,
      path: "email_only",
      inputs,
      model: r.model,
      usage: r.usage,
      warnings,
    };
  } catch (err) {
    if (err instanceof ClassificationError) throw err;
    throw new ClassificationError(
      `Email-only classification failed: ${(err as Error).message.slice(0, 140)}`,
      "model"
    );
  }
}
