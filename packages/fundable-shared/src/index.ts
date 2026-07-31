/**
 * @fundable/shared — the plumbing the Personalization API and the demo UI both need.
 *
 * Extracted from post-studio rather than imported from it: post-studio is a
 * deployed app, and pointing it at this package is a deliberate follow-up task,
 * not a side effect of this build.
 */

export { loadRootEnv, optionalEnv, requireEnv } from "./env.js";

// Curated alias tables. Fundable's search endpoints are literal name lookups
// with no relevance ranking, and a bad permalink is silently dropped, so these
// are what keep a filter from quietly vanishing.
export { INDUSTRY_ALIASES, LOCATION_ALIASES, ROUND_EXPANSIONS, ROUND_PHRASES } from "./aliases.js";
export type { Alias } from "./aliases.js";

// Fundable REST client.
export {
  FundableError,
  MAX_COMPANIES_PER_DEALS_CALL,
  call,
  cityOf,
  companiesByDomains,
  companyByDomain,
  dealDate,
  daysAgo,
  dealsForCompany,
  firstNameOf,
  investmentStages,
  investorsByIds,
  leadInvestorProse,
  money,
  newLedger,
  normalizeDomain,
  normalizeLinkedIn,
  peopleByLinkedIn,
  personByLinkedIn,
  resolveIndustry,
  resolveLocation,
  resolveRounds,
  roundLabel,
} from "./fundable.js";
export type {
  BatchResult,
  CallResult,
  Company,
  Deal,
  DealSort,
  EmbeddedDeal,
  FinancingType,
  Investor,
  Ledger,
  Location,
  Meta,
  NamedPermalink,
  Person,
} from "./fundable.js";

// Exa — recency + the person index that makes repeat-founder computable.
export {
  ExaError,
  answer,
  articleDate,
  exaConfigured,
  findPerson,
  findRecentNews,
  newExaLedger,
} from "./exa.js";
export type { ExaArticle, ExaLedger, ExaPerson, WorkHistoryEntry } from "./exa.js";

// ICP classification — two-tier, ported from fundable-scripts.
export {
  ClassificationError,
  EMAIL_ONLY_PROMPT,
  FREEMAIL,
  ICPS,
  ICP_HUBSPOT_LABEL,
  TITLED_PROMPT,
  classifyIcp,
  companyResearchQuery,
  isFreemail,
} from "./icp.js";
export type { ClassifyInput, Icp, IcpPath, IcpResult } from "./icp.js";

// OpenRouter.
export { EMPTY_USAGE, MODEL_PLAN, MODEL_WRITE, complete, parseJson, stream } from "./openrouter.js";
export type { ChatMessage, CompleteOpts, CompleteResult, Usage } from "./openrouter.js";

// Claim checking. `claims.ts` is the verbatim port from post-studio (unsupported
// comparisons); `verify.ts` adds the evidence-grounded checking cold outbound
// needs. Both correction prompts are exported, disambiguated by name.
export { findUnsupportedClaims, correctionPrompt as comparisonCorrectionPrompt } from "./claims.js";
export type { ClaimIssue } from "./claims.js";

export { blockingIssues, correctionPrompt as verifyCorrectionPrompt, verifyCopy } from "./verify.js";
export type { Evidence, EvidenceSource, Severity, VerifyInput, VerifyIssue } from "./verify.js";

// Voice.
export {
  checkLength,
  loadVoice,
  provenanceWarning,
  stripEmDashes,
  validateVoice,
  wordCount,
} from "./voice.js";
export type { Channel, ChannelLimits, LengthCheck, VoiceProfile } from "./voice.js";
