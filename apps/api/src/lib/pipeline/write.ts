/**
 * Stage 5: WRITE — the only generative stage — and stage 6: VERIFY, which
 * constrains it.
 *
 * The system prompt is built from config/voice/jacob.json at call time, so the
 * profile stays the single source of truth: when Jacob's real emails land, the
 * prompt changes because the data changed, not because someone edited a string
 * here.
 *
 * Verification is code (`verifyCopy`), not prompt. One corrective retry, then
 * the caller downgrades to template_only. Never silently ship an unverifiable
 * claim (spec §2, guardrail #3).
 */

import {
  MODEL_WRITE,
  checkLength,
  complete,
  parseJson,
  stripEmDashes,
  verifyCopy,
  verifyCorrectionPrompt,
  blockingIssues,
  type ChatMessage,
  type Usage,
  type VerifyIssue,
  type VoiceProfile,
} from "@fundable/shared";

import type { Angle } from "./angle";
import type { Fact } from "./facts";
import type { Channel, EmitFn, Trigger } from "./types";

export type Draft = {
  subject: string | null;
  body: string;
  issues: VerifyIssue[];
  retried: boolean;
  usage: Usage[];
};

export type WriteFailure = {
  failed: true;
  issues: VerifyIssue[];
  retried: boolean;
  usage: Usage[];
  reason: string;
};

const ANGLE_NOTES: Record<Angle, string> = {
  the_raise: "Open on the round itself: what they raised, when. One sentence, no gushing.",
  lead_investor: "Open on who led the round, quoting only what the facts state about the leads.",
  momentum: "Open on the cumulative picture: total raised or valuation, as stated in the facts.",
  company_profile: "Open on what the company does, in their terms, from the profile fact.",
  investor_overlap:
    "Open on the shared investor, exactly as the tie fact states it. This is the strongest thing you have: it is specific, checkable, and no generic tool could know it. State the overlap, do not embellish what it implies about either company.",
  repeat_founder:
    "Open on what they built before, as the tie fact states it (company and dates). Treat it as a fact you looked up, not as flattery about their journey.",
  shared_city:
    "Open on the shared city, briefly. It is a light touch, so do not over-invest in it: one clause, then move to the ask.",
  stage_fit:
    "Open on their stage as the tie fact states it, and connect it to what Fundable is useful for at that stage.",
  recent_news:
    "Open on the dated coverage. Refer to the headline as coverage that exists, and never assert anything beyond what the headline itself says.",
};

function buildSystem(voice: VoiceProfile, channel: Channel): string {
  const limits = voice.limits[channel];
  const structure = (voice.structure?.[channel] ?? []).map((s) => `- ${s}`).join("\n");
  const subjectRules =
    channel === "email"
      ? `\nSUBJECT LINE\n${(voice.subject_line?.rules ?? []).map((r) => `- ${r}`).join("\n")}\nGood: ${(voice.subject_line?.good_examples ?? []).join(" | ")}\nBad: ${(voice.subject_line?.bad_examples ?? []).join(" | ")}\n`
      : "";

  const p = voice.persona;
  return `You write cold outreach as ${p.name}, ${p.role} of ${p.company} (${p.company_url}) — ${p.what_company_does}. ${p.background}. ${p.first_person_plural}.

REGISTER
${Object.values(voice.register ?? {}).join(" ")}

THE FACTS ARE A CLOSED SET. You will be given numbered facts. They are everything you know. You know nothing else about the recipient, their company, their investors, their plans, or the market. Every specific detail in your message must restate one of the facts faithfully. Rounding a supplied figure is fine; a new number, date, name, place, title, or event is not. If the facts are thin, write a shorter message — never pad with invented specifics or generic value-prop copy.

NEVER MERGE SEPARATE FACTS INTO ONE CLAIM. Each sentence you write may restate one fact; it may not weld two facts into a third claim neither of them makes. The specific trap: if one fact gives a round and another gives a valuation, do NOT write "raised at a $X valuation" — the valuation belongs to that round only if a single fact says so. Keep separate facts in separate sentences, each faithful to its own source.

NAME BOTH PARTIES IN A SHARED-INVESTOR CLAIM, IN THE SUBJECT AS WELL AS THE BODY. A fact of the form "<Fund> is an investor in both <A> and <B>" is about two named companies, neither of which is the sender. NEVER compress it to "backed both of you", "both of us", "our shared investor", or any second-person pairing: in a one-to-one message that reads as an investor the sender shares with the recipient, which the facts do not state. The subject line is where this compression is tempting because it is short. Write "<Fund> backs <A> and <B>" instead, or drop the second company and name only the recipient's side.

STRUCTURE (${channel})
${structure}
${subjectRules}
LIMITS
- Body: at most ${limits.max_words} words, aim for ${limits.target_words ?? limits.max_words}.
- Exactly one ask.

TONE MARKERS
${(voice.tone_markers ?? []).map((t) => `- ${t}`).join("\n")}

FORBIDDEN
- The em dash character. Never, anywhere.
- Phrases: ${(voice.forbidden_phrases ?? []).join("; ")}
- ${(voice.forbidden_formatting ?? []).join("\n- ")}

HARD RULES
${(voice.hard_rules ?? []).map((r) => `- ${r}`).join("\n")}

OUTPUT
Reply with JSON only: {"subject": ${channel === "email" ? '"<subject line>"' : "null"}, "body": "<the message>"}.
Sign-off inside the body: ${voice.sign_off?.[channel] ?? "none (the platform shows the sender)"}.`;
}

function buildUser(input: {
  recipient: { name?: string; firstName?: string; title?: string; company?: string };
  trigger: Trigger;
  angle: Angle;
  facts: Fact[];
  senderFacts: Fact[];
  template?: string;
  channel: Channel;
}): string {
  const r = input.recipient;
  const recipientLines = [
    r.name ? `Name: ${r.name}` : "Name: NOT AVAILABLE",
    r.firstName
      ? `Greeting name: ${r.firstName}`
      : "Greeting name: NOT AVAILABLE — open with a bare greeting such as \"Hi,\" and never invent, guess, or infer a name from the email address or company",
    r.title ? `Title: ${r.title}` : null,
    r.company ? `Company: ${r.company}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const facts = input.facts.map((f, i) => `${i + 1}. ${f.fact}`).join("\n");
  const sender = input.senderFacts.map((f, i) => `S${i + 1}. ${f.fact}`).join("\n");

  const template = input.template
    ? `\nTEMPLATE (the caller's own copy — keep its structure and intent, customize only the edges with the facts; do not rewrite it wholesale):\n---\n${input.template}\n---\nIf the template contains merge tags like {{first_name}} or {{opener}}, fill them only from the facts and recipient details above; if one cannot be filled honestly, rework that sentence so it reads naturally without it.`
    : "\nTEMPLATE: none — write the message from scratch in the structure above.";

  return `RECIPIENT
${recipientLines}

ANGLE: ${input.angle} — ${ANGLE_NOTES[input.angle]}

FACTS about the recipient (closed set):
${facts || "(none — write without any recipient-specific claim)"}

FACTS about the sender (usable for the bridge, same closed-set rule):
${sender || "(none)"}
${template}

Write the ${input.channel} message now. JSON only.`;
}

export async function writeAndVerify(input: {
  voice: VoiceProfile;
  channel: Channel;
  trigger: Trigger;
  angle: Angle;
  facts: Fact[];
  senderFacts: Fact[];
  recipient: { name?: string; firstName?: string; title?: string; company?: string };
  template?: string;
  allowedNames: string[];
  emit?: EmitFn;
}): Promise<Draft | WriteFailure> {
  const usage: Usage[] = [];
  const emit: EmitFn = input.emit ?? (() => {});
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystem(input.voice, input.channel) },
    { role: "user", content: buildUser(input) },
  ];

  // Evidence for the verifier = exactly what the writer was shown.
  const evidence = [...input.facts, ...input.senderFacts];

  let retried = false;
  let lastIssues: VerifyIssue[] = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    emit({
      stage: "write",
      status: "start",
      detail: attempt === 0 ? `drafting the ${input.channel} in Jacob's voice` : "corrective rewrite",
    });
    let raw: string;
    try {
      const res = await complete(messages, { model: MODEL_WRITE, maxTokens: 700, temperature: 0.4, hedgeAfterMs: 3500 });
      usage.push(res.usage);
      raw = res.text;
    } catch (err) {
      return {
        failed: true,
        issues: lastIssues,
        retried,
        usage,
        reason: `writer call failed: ${err instanceof Error ? err.message : "unknown"}`,
      };
    }

    let subject: string | null;
    let body: string;
    try {
      const parsed = parseJson<{ subject?: string | null; body?: string }>(raw);
      if (!parsed.body || typeof parsed.body !== "string") throw new Error("no body in reply");
      body = stripEmDashes(parsed.body).trim();
      subject =
        input.channel === "email" && typeof parsed.subject === "string"
          ? stripEmDashes(parsed.subject).trim()
          : null;
    } catch (err) {
      return {
        failed: true,
        issues: lastIssues,
        retried,
        usage,
        reason: `writer returned unparseable output: ${err instanceof Error ? err.message : "unknown"}`,
      };
    }

    const issues = verifyCopy({
      copy: body,
      subject,
      evidence,
      template: input.template ?? null,
      allowedNames: input.allowedNames,
      forbiddenPhrases: input.voice.forbidden_phrases ?? [],
      senderCompany: input.voice.persona.company ?? null,
    });

    const length = checkLength(body, input.voice, input.channel);
    if (!length.ok) {
      issues.push({
        quote: `${length.words} words`,
        reason: length.message ?? "over the word limit",
        severity: "block",
        kind: "style",
      });
    }

    const blocking = blockingIssues(issues);
    if (!blocking.length) {
      emit({
        stage: "write",
        status: "done",
        detail: `${body.trim().split(/\s+/).length} words${subject ? `, subject "${subject}"` : ""}`,
      });
      emit({
        stage: "verify",
        status: "done",
        detail:
          attempt === 0
            ? `clean — every claim traces to evidence (${issues.length} advisory note${issues.length === 1 ? "" : "s"})`
            : "clean after the corrective rewrite",
      });
      return { subject, body, issues, retried, usage };
    }

    lastIssues = issues;
    if (attempt === 0) {
      // One corrective retry, with the draft in context so "rewrite" means edit.
      retried = true;
      emit({
        stage: "verify",
        status: "retry",
        detail: `${blocking.length} blocked claim${blocking.length === 1 ? "" : "s"} (${blocking
          .map((i) => `"${i.quote.slice(0, 40)}${i.quote.length > 40 ? "…" : ""}"`)
          .join(", ")}) — corrective retry`,
      });
      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: verifyCorrectionPrompt(issues, evidence) });
    }
  }

  emit({
    stage: "verify",
    status: "error",
    detail: "unverifiable claims survived the corrective retry — downgrading",
  });
  return {
    failed: true,
    issues: lastIssues,
    retried,
    usage,
    reason: "unverifiable claims survived the corrective retry",
  };
}
