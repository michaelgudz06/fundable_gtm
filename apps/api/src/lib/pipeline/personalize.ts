/**
 * The pipeline orchestrator. Stages per spec §2:
 *
 *   1 RESOLVE   deterministic   (resolve.ts, cached)
 *   2 ENRICH    deterministic   (facts.ts — Fundable only in M1; Exa is M3)
 *   3 TIE       ——— M3 ———      (needs sender customer_domains + investor overlap)
 *   4 ANGLE     V4-flash        (angle.ts)
 *   5 WRITE     V4-pro          (write.ts — the only generative stage)
 *   6 VERIFY    code            (write.ts -> shared/verify.ts, one retry)
 *
 * Status decisions live HERE, in one place:
 *   no_match       — nothing resolved at all
 *   template_only  — confidence < 0.5, or verification failed after the retry.
 *                    The template comes back LITERALLY UNTOUCHED (spec §1.1) —
 *                    callers must be able to trust the distinction.
 *   personalized   — wrote copy and every claim survived verification.
 */

import {
  exaConfigured,
  findPerson,
  findRecentNews,
  firstNameOf,
  newExaLedger,
  newLedger,
  provenanceWarning,
  type Evidence,
  type ExaPerson,
  type Usage,
} from "@fundable/shared";

import { VOICE } from "../config-registry";
import { getStorage, CACHE_TTL_MS, type LogRow } from "../storage";
import { pickAngle } from "./angle";
import { buildFacts, prospectFacts, recencyFacts, tieFacts, type Fact } from "./facts";
import { scoreConfidence, TEMPLATE_ONLY_BELOW } from "./confidence";
import { cacheKey, resolve } from "./resolve";
import { loadSenderContext } from "./sender";
import { computeTies, type Tie } from "./ties";
import { isInternalIdentity, TRIGGER_POLICY } from "./triggers";
import { writeAndVerify } from "./write";
import type { EmitFn, PersonalizeRequest, PersonalizeResponse, StageEvent } from "./types";

function sumTokens(usages: (Usage | null)[]): number {
  return usages.reduce((n, u) => n + (u?.totalTokens ?? 0), 0);
}

export async function personalize(
  req: PersonalizeRequest,
  keyHash: string,
  onEvent?: (e: StageEvent) => void
): Promise<PersonalizeResponse> {
  const started = Date.now();
  const storage = getStorage();
  const ledger = newLedger();
  const exaLedger = newExaLedger();
  const policy = TRIGGER_POLICY[req.trigger];
  const warnings: string[] = [];
  const tokenUsages: (Usage | null)[] = [];

  // Stage events are demo/observability plumbing — a throwing consumer must
  // never break the pipeline itself.
  const emit: EmitFn = (e) => {
    try {
      onEvent?.({ ...e, t: Date.now() - started });
    } catch {
      /* consumer's problem, not the pipeline's */
    }
  };

  const voice = VOICE;
  const voiceWarning = provenanceWarning(voice);
  if (voiceWarning) warnings.push(voiceWarning);

  // Internal identities are never personalized about (spec §0). A sign-up
  // webhook fires for Fundable's own team and test accounts too.
  const internal = isInternalIdentity(req.person.email);

  // ---- 1 RESOLVE ------------------------------------------------------------
  const resolveTargets = [
    req.person.email ? normalizedEmailDomainLabel(req.person.email) : null,
    req.person.linkedin ?? null,
  ].filter(Boolean);
  emit({ stage: "resolve", status: "start", detail: `Resolving ${resolveTargets.join(" + ")}` });

  const resolved = await resolve(
    { ...(req.person.email ? { email: req.person.email } : {}), ...(req.person.linkedin ? { linkedin: req.person.linkedin } : {}) },
    storage,
    ledger
  );
  warnings.push(...resolved.warnings);

  {
    const parts: string[] = [];
    if (resolved.company) {
      const deal = resolved.company.latest_deal;
      const round = deal ? `${roundLabelOf(deal)}${deal.date ? `, ${String(deal.date).slice(0, 10)}` : ""}` : "no funding on record";
      parts.push(`${resolved.domain ?? "?"} → ${resolved.company.name} (${round})`);
    }
    if (resolved.person) parts.push(`LinkedIn → ${resolved.person.name ?? "person"}${resolved.person.title ? `, ${resolved.person.title}` : ""}`);
    if (!parts.length) parts.push("nothing matched in Fundable");
    emit({
      stage: "resolve",
      status: "done",
      detail: `${parts.join(" · ")}${resolved.fromCache ? " (cache hit, 0 credits)" : ` (${ledger.credits} credit${ledger.credits === 1 ? "" : "s"})`}`,
    });
  }

  const { sender, warnings: senderWarnings } = loadSenderContext(req.sender_context);
  warnings.push(...senderWarnings);

  // ---- 2 ENRICH -------------------------------------------------------------
  const base_facts = buildFacts({
    company: resolved.company,
    person: resolved.person,
    sender,
  });
  warnings.push(...base_facts.warnings);
  let facts = base_facts.facts;

  // Exa runs in parallel with nothing else here, but it is the only paid
  // external call left, so it is gated on the trigger policy and on having
  // resolved something worth searching about.
  let exaPerson: ExaPerson | null = null;
  const useExa = policy.useExa && exaConfigured() && !internal && !!resolved.company;

  if (!useExa) {
    emit({
      stage: "enrich",
      status: "skipped",
      detail: !exaConfigured()
        ? "Exa not configured; Fundable facts only"
        : internal
          ? "internal identity; skipping Exa"
          : !resolved.company
            ? "no company resolved; skipping Exa"
            : `trigger "${req.trigger}" does not use Exa`,
    });
  } else {
    emit({ stage: "enrich", status: "start", detail: "Exa: recent coverage + person career history" });
    const personName = resolved.person?.name ?? req.person.name;
    const companyName = resolved.company?.name ?? null;
    const exaKey = `exa:${cacheKey(req.person.email, req.person.linkedin)}`;

    type ExaCached = { person: ExaPerson | null; articles: import("@fundable/shared").ExaArticle[] };
    const cachedExa = (await storage.cacheGet(exaKey, "exa")) as ExaCached | null;

    let articles: import("@fundable/shared").ExaArticle[] = [];
    if (cachedExa) {
      exaPerson = cachedExa.person;
      articles = cachedExa.articles ?? [];
      emit({ stage: "enrich", status: "done", detail: `Exa cache hit ($0.000): ${articles.length} article(s)` });
    } else {
      // Both calls are independent; run them together.
      const [personRes, newsRes] = await Promise.allSettled([
        personName
          ? findPerson({ name: personName, company: companyName ?? undefined }, exaLedger)
          : Promise.resolve({ person: null, warnings: [] }),
        findRecentNews(
          { query: `${companyName ?? ""} funding announcement news`.trim(), sinceDays: 180, limit: 4 },
          exaLedger
        ),
      ]);

      if (personRes.status === "fulfilled") {
        exaPerson = personRes.value.person;
        warnings.push(...personRes.value.warnings);
      } else {
        warnings.push(`Exa person lookup failed: ${String(personRes.reason).slice(0, 140)}`);
      }
      if (newsRes.status === "fulfilled") {
        articles = newsRes.value.articles;
        warnings.push(...newsRes.value.warnings);
      } else {
        warnings.push(`Exa news search failed: ${String(newsRes.reason).slice(0, 140)}`);
      }

      await storage.cacheSet(exaKey, "exa", { person: exaPerson, articles }, CACHE_TTL_MS.exa);
      emit({
        stage: "enrich",
        status: "done",
        detail: `Exa: ${articles.length} dated article(s), person ${exaPerson ? `matched (${exaPerson.workHistory.length} roles)` : "not matched"} ($${exaLedger.usd.toFixed(3)})`,
      });
    }

    facts = [...facts, ...recencyFacts(articles, resolved.company?.name ?? null)];
  }

  {
    const prospect = prospectFacts(facts).length;
    const senderCount = facts.length - prospect;
    emit({
      stage: "enrich",
      status: "done",
      detail: `${prospect} prospect fact${prospect === 1 ? "" : "s"} + ${senderCount} sender fact${senderCount === 1 ? "" : "s"}`,
    });
  }

  // ---- 3 TIE ----------------------------------------------------------------
  let ties: Tie[] = [];
  if (!sender) {
    emit({ stage: "tie", status: "skipped", detail: "no sender_context; no ties computable" });
  } else {
    emit({ stage: "tie", status: "start", detail: `computing ties against sender_context "${sender.id}"` });
    const tieRes = await computeTies({
      company: resolved.company,
      person: resolved.person,
      exaPerson,
      sender,
      storage,
      ledger,
    });
    warnings.push(...tieRes.warnings);
    // A tie the trigger is not allowed to use must not reach the writer at all.
    ties = tieRes.ties.filter((t) => policy.allowedTies.includes(t.kind));
    facts = [...facts, ...tieFacts(ties)];
    emit({
      stage: "tie",
      status: "done",
      detail: ties.length
        ? `${ties.length} tie(s): ${ties.map((t) => t.kind).join(", ")}`
        : "no ties found",
    });
  }

  // Enforce the trigger's evidence policy. website-visitor cannot mention the
  // person; this is where that becomes structural rather than a prompt request.
  const beforeFilter = facts.length;
  facts = facts.filter((f) => f.tag === "sender" || policy.allowedTags.includes(f.tag));
  if (facts.length < beforeFilter) {
    warnings.push(
      `${beforeFilter - facts.length} fact(s) withheld: trigger "${req.trigger}" does not permit them.`
    );
  }

  // ---- confidence (PRD §7.2) — decided before any tokens are spent ----------
  const scored = scoreConfidence({
    company: resolved.company,
    person: resolved.person,
    trigger: req.trigger,
    ties,
    recencyCount: facts.filter((f) => f.tag === "recency").length,
  });
  warnings.push(...scored.warnings);

  const base = {
    confidence: scored.confidence,
    resolved: {
      person_id: resolved.person?.id ?? null,
      company_id: resolved.company?.id ?? null,
      company: resolved.company?.name ?? null,
      domain: resolved.domain,
    },
  };

  const finish = (
    partial: Pick<PersonalizeResponse, "status" | "subject" | "body" | "angle" | "evidence">,
    extra: Partial<LogRow> = {}
  ): Promise<PersonalizeResponse> =>
    logAndReturn(
      {
        ...partial,
        ...base,
        warnings,
        usage: {
          fundable_credits: ledger.credits,
          exa_cost_usd: Number(exaLedger.usd.toFixed(6)),
          llm_tokens: sumTokens(tokenUsages),
          ms: Date.now() - started,
        },
      },
      req,
      keyHash,
      voice.id,
      voice.provenance,
      storage,
      extra
    );

  // ---- no_match / template_only gates ---------------------------------------
  if (internal) {
    warnings.push(
      `"${req.person.email}" is an internal or test identity — refusing to generate outbound copy about it (spec §0). Returning the template untouched.`
    );
    emit({ stage: "done", status: "done", detail: "internal identity — no personalization attempted" });
    return finish({
      status: "template_only",
      subject: null,
      body: req.template ?? null,
      angle: null,
      evidence: [],
    });
  }

  if (!resolved.company && !resolved.person) {
    warnings.push("Neither the email domain nor the LinkedIn URL matched anything in Fundable.");
    emit({ stage: "done", status: "done", detail: "no_match — returning the template untouched" });
    return finish({
      status: "no_match",
      subject: null,
      body: req.template ?? null,
      angle: null,
      evidence: [],
    });
  }

  const evidenceOf = (fs: Fact[]): Evidence[] =>
    fs.map(({ tag: _tag, ...evidence }) => evidence);

  if (scored.confidence < TEMPLATE_ONLY_BELOW) {
    warnings.push(
      `No verifiable angle found (confidence ${scored.confidence} < ${TEMPLATE_ONLY_BELOW}) — returning the template untouched. Coverage: ${scored.reasons.join("; ")}.`
    );
    if (!req.template) {
      warnings.push("No template was supplied, so body is null.");
    }
    emit({
      stage: "done",
      status: "done",
      detail: `template_only — confidence ${scored.confidence} is under the ${TEMPLATE_ONLY_BELOW} gate`,
    });
    return finish({
      status: "template_only",
      subject: null,
      body: req.template ?? null,
      angle: null,
      // Partial evidence still comes back — the demo renders the failure honestly.
      evidence: evidenceOf(prospectFacts(facts)),
    });
  }

  // ---- 4 ANGLE ---------------------------------------------------------------
  emit({ stage: "angle", status: "start", detail: `picking one angle from ${prospectFacts(facts).length} facts (max ${req.max_facts})` });
  const pick = await pickAngle({
    facts,
    trigger: req.trigger,
    channel: req.channel,
    maxFacts: req.max_facts,
  });
  warnings.push(...pick.warnings);
  tokenUsages.push(pick.usage);
  emit({
    stage: "angle",
    status: "done",
    detail: `${pick.angle} (${pick.facts.length} fact${pick.facts.length === 1 ? "" : "s"})`,
  });

  // ---- 5 WRITE + 6 VERIFY ----------------------------------------------------
  const senderFacts = facts.filter((f) => f.tag === "sender");

  // Identity is withheld entirely when the trigger has no business knowing it.
  // Withholding only the `person` FACT is not enough: the greeting name comes
  // from here, and that produced "Hi Eric," on an anonymous website-visitor
  // signal until this gate existed.
  const personName = policy.allowPersonIdentity ? resolved.person?.name ?? req.person.name : undefined;
  const recipient = {
    ...(personName ? { name: personName } : {}),
    ...(firstNameOf(personName) ? { firstName: firstNameOf(personName)! } : {}),
    ...(policy.allowPersonIdentity && resolved.person?.title ? { title: resolved.person.title } : {}),
    ...(resolved.company?.name ? { company: resolved.company.name } : {}),
  };
  if (!policy.allowPersonIdentity && (resolved.person || req.person.name)) {
    warnings.push(
      `Recipient identity withheld from the writer: trigger "${req.trigger}" is a company-level signal, so the copy is addressed to no one in particular.`
    );
  }

  const allowedNames = [
    personName,
    recipient.firstName,
    resolved.company?.name,
    // Possessive and plural forms of the company name are not new entities.
    resolved.company?.name ? `${resolved.company.name}'s` : undefined,
    policy.allowPersonIdentity ? resolved.person?.title : undefined,
    voice.persona.name,
    voice.persona.company,
    voice.persona.company_url,
    sender?.id,
  ].filter((n): n is string => !!n);

  const draft = await writeAndVerify({
    voice,
    channel: req.channel,
    trigger: req.trigger,
    angle: pick.angle,
    facts: pick.facts,
    senderFacts,
    recipient,
    ...(req.template !== undefined ? { template: req.template } : {}),
    allowedNames,
    emit,
  });
  draft.usage.forEach((u) => tokenUsages.push(u));

  if ("failed" in draft) {
    warnings.push(
      `Verification failed after one corrective retry (${draft.reason}) — returning the template untouched rather than shipping an unverifiable claim.`
    );
    for (const issue of draft.issues.filter((i) => i.severity === "block")) {
      warnings.push(`Blocked claim: "${issue.quote}" — ${issue.reason}`);
    }
    if (!req.template) warnings.push("No template was supplied, so body is null.");
    emit({
      stage: "done",
      status: "done",
      detail: "template_only — the draft could not be verified, refusing to ship it",
    });
    return finish(
      {
        status: "template_only",
        subject: null,
        body: req.template ?? null,
        angle: pick.angle,
        evidence: evidenceOf([...pick.facts, ...senderFacts]),
      },
      { verify_issues: draft.issues, verify_retried: draft.retried }
    );
  }

  // Entity warnings are heuristic (never blocking) but the caller should see them.
  for (const issue of draft.issues.filter((i) => i.severity === "warn")) {
    warnings.push(`Check before sending: "${issue.quote}" — ${issue.reason}`);
  }

  emit({ stage: "done", status: "done", detail: "personalized — every claim verified against evidence" });
  return finish(
    {
      status: "personalized",
      subject: draft.subject,
      body: draft.body,
      angle: pick.angle,
      evidence: evidenceOf([...pick.facts, ...senderFacts]),
    },
    {
      verify_issues: draft.issues.length ? draft.issues : null,
      verify_retried: draft.retried,
    }
  );
}

// ---------------------------------------------------------------------------
// Small display helpers for stage-event details.
// ---------------------------------------------------------------------------

function normalizedEmailDomainLabel(email: string): string {
  const at = email.lastIndexOf("@");
  return at >= 0 ? email.slice(at + 1).toLowerCase() : email;
}

function roundLabelOf(deal: { type?: string; pre?: boolean; extension?: boolean }): string {
  const base = (deal.type ?? "round").replace(/^HYBRID_/, "").toLowerCase().replace(/_/g, " ");
  return `${deal.pre ? "pre-" : ""}${base}${deal.extension ? " ext" : ""}`;
}

// ---------------------------------------------------------------------------

async function logAndReturn(
  response: PersonalizeResponse,
  req: PersonalizeRequest,
  keyHash: string,
  voiceId: string,
  voiceProvenance: string,
  storage: ReturnType<typeof getStorage>,
  extra: Partial<LogRow>
): Promise<PersonalizeResponse> {
  await storage.log({
    api_key_hash: keyHash,
    trigger: req.trigger,
    channel: req.channel,
    person_email: req.person.email ?? null,
    person_linkedin: req.person.linkedin ?? null,
    person_name: req.person.name ?? null,
    sender_context: req.sender_context ?? null,
    max_facts: req.max_facts,
    template_provided: req.template !== undefined,
    company_id: response.resolved.company_id,
    company_name: response.resolved.company,
    company_domain: response.resolved.domain,
    person_id: response.resolved.person_id,
    status: response.status,
    confidence: response.confidence,
    angle: response.angle,
    subject: response.subject,
    body: response.body,
    evidence: response.evidence,
    warnings: response.warnings,
    verify_issues: null,
    verify_retried: false,
    fundable_credits: response.usage.fundable_credits,
    exa_cost_usd: response.usage.exa_cost_usd,
    llm_tokens: response.usage.llm_tokens,
    latency_ms: response.usage.ms,
    voice_id: voiceId,
    voice_provenance: voiceProvenance,
    ...extra,
  });

  // A storage failure must not fail the request, but it must not be silent either:
  // the log is the audit trail, and the caller should know a row is missing.
  if (storage.lastError) {
    response.warnings.push(`Request logging degraded: ${storage.lastError}`);
  }

  return response;
}
