/**
 * Request/response contract for POST /api/personalize/stream — PRD §4, verbatim.
 */

import type { Evidence } from "@fundable/shared";

export const TRIGGERS = ["sign-up", "website-visitor", "cold", "post-raise"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const CHANNELS = ["email", "linkedin"] as const;
export type Channel = (typeof CHANNELS)[number];

export type PersonalizeRequest = {
  person: { email?: string; linkedin?: string; name?: string };
  trigger: Trigger;
  channel: Channel;
  template?: string;
  sender_context?: string;
  max_facts: number;
};

export type Status = "personalized" | "template_only" | "no_match";

export type PersonalizeResponse = {
  status: Status;
  confidence: number;
  subject: string | null;
  body: string | null;
  angle: string | null;
  evidence: Evidence[];
  resolved: {
    person_id: string | null;
    company_id: string | null;
    company: string | null;
    domain: string | null;
  };
  warnings: string[];
  usage: { fundable_credits: number; exa_cost_usd: number; llm_tokens: number; ms: number };
};

// ---------------------------------------------------------------------------
// Stage events — the demo's live pipeline view (spec §2, §4 center panel).
// One vocabulary for the stream endpoint and the UI; the sync route ignores them.
// ---------------------------------------------------------------------------

export type StageName = "resolve" | "enrich" | "tie" | "angle" | "write" | "verify" | "done" | "error";

export type StageEvent = {
  /** ms since the request started — the UI derives per-stage timing chips. */
  t: number;
  stage: StageName;
  status: "start" | "done" | "skipped" | "retry" | "error";
  detail?: string;
  /** Present only on the terminal `done` event. */
  response?: PersonalizeResponse;
};

export type EmitFn = (e: Omit<StageEvent, "t">) => void;

export type ValidationError = { field: string; message: string };

/**
 * Hand-rolled on purpose — the contract is small, and a validation library is a
 * dependency this repo does not otherwise need.
 */
export function parseRequest(
  raw: unknown
): { ok: true; req: PersonalizeRequest } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];
  const obj = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

  const person = (
    typeof obj.person === "object" && obj.person !== null ? obj.person : {}
  ) as Record<string, unknown>;

  const email = typeof person.email === "string" ? person.email.trim() : undefined;
  const linkedin = typeof person.linkedin === "string" ? person.linkedin.trim() : undefined;
  const name = typeof person.name === "string" ? person.name.trim() : undefined;

  if (!email && !linkedin) {
    errors.push({ field: "person", message: "person.email or person.linkedin is required" });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.push({ field: "person.email", message: "not a plausible email address" });
  }

  const trigger = obj.trigger;
  if (!TRIGGERS.includes(trigger as Trigger)) {
    errors.push({ field: "trigger", message: `must be one of: ${TRIGGERS.join(", ")}` });
  }

  const channel = obj.channel ?? "email";
  if (!CHANNELS.includes(channel as Channel)) {
    errors.push({ field: "channel", message: `must be one of: ${CHANNELS.join(", ")}` });
  }

  const template = typeof obj.template === "string" ? obj.template : undefined;
  if (template !== undefined && template.length > 4000) {
    errors.push({ field: "template", message: "over the 4000-character limit" });
  }
  if (obj.template !== undefined && typeof obj.template !== "string") {
    errors.push({ field: "template", message: "must be a string" });
  }

  const senderContext = typeof obj.sender_context === "string" ? obj.sender_context : undefined;
  if (senderContext !== undefined && !/^[a-z0-9_-]{1,64}$/i.test(senderContext)) {
    errors.push({ field: "sender_context", message: "must match [a-z0-9_-]{1,64}" });
  }

  // Clamp rather than reject: a sequencer sending 5 wants "as many as allowed".
  const rawMax = typeof obj.max_facts === "number" ? obj.max_facts : 3;
  const maxFacts = Math.min(3, Math.max(1, Math.round(rawMax)));

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    req: {
      person: {
        ...(email ? { email } : {}),
        ...(linkedin ? { linkedin } : {}),
        ...(name ? { name } : {}),
      },
      trigger: trigger as Trigger,
      channel: channel as Channel,
      ...(template !== undefined ? { template } : {}),
      ...(senderContext !== undefined ? { sender_context: senderContext } : {}),
      max_facts: maxFacts,
    },
  };
}
