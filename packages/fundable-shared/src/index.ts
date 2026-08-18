/**
 * @fundable/shared — the plumbing the Personalization API and the demo UI both need.
 *
 * Extracted from post-studio rather than imported from it: post-studio is a
 * deployed app, and pointing it at this package is a deliberate follow-up task,
 * not a side effect of this build.
 */

export { loadRootEnv, optionalEnv, requireEnv } from "./env.js";
export {
  DeadlineError,
  LEG_TIMEOUT_MS,
  REQUEST_BUDGET_MS,
  fetchWithDeadline,
  legTimeoutMs,
  retryOnce,
  startBudget,
} from "./deadline.js";
export type { Budgeted } from "./deadline.js";

// Fundable REST client.
export {
  FundableError,
  call,
  cityOf,
  companiesByDomains,
  companyByDomain,
  dealDate,
  dealsForCompany,
  firstNameOf,
  investorsByIds,
  leadInvestorProse,
  money,
  newLedger,
  normalizeDomain,
  normalizeEmail,
  normalizeLinkedIn,
  peopleByLinkedIn,
  personByLinkedIn,
  roundLabel,
} from "./fundable.js";
export type {
  BatchResult,
  CallResult,
  Company,
  Deal,
  DealSort,
  EmbeddedDeal,
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
  FREEMAIL,
  companyResearchQuery,
  companyResearchQueryByName,
  isFreemail,
  RESEARCH_QUERY_VERSION,
} from "./icp.js";

// OpenRouter.
export { EMPTY_USAGE, MODEL_PLAN, MODEL_WRITE, complete, parseJson, stream } from "./openrouter.js";
export type { ChatMessage, CompleteOpts, CompleteResult, Usage } from "./openrouter.js";

// Claim checking. `claims.ts` is the verbatim port from post-studio (unsupported
// comparisons); `verify.ts` adds the evidence-grounded checking cold outbound
// needs. Only verify.ts's correction prompt has a consumer, so only it is
// re-exported — under its disambiguated name, since both files define one.
export { findUnsupportedClaims } from "./claims.js";
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
