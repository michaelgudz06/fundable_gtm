/**
 * Static config registry.
 *
 * The voice and sender-context JSON live at the workspace root in `config/`, and
 * the loaders originally read them at request time by walking up from
 * `process.cwd()`. That works locally and is unreliable on serverless: cwd is not
 * guaranteed, and a file only ships if Next's tracer decided to include it.
 * Getting it wrong produces a 500 in production that never reproduces locally.
 *
 * Importing them instead makes the bundler responsible: the JSON is compiled in,
 * so it is present wherever the function runs.
 *
 * TRADE-OFF, stated plainly: adding a sender context is now a one-line edit here
 * rather than dropping a file in a directory. That is the cost of deterministic
 * loading, and it is worth it — a missing config file at request time is not a
 * failure mode this API should have.
 */

import { validateVoice, type VoiceProfile } from "@fundable/shared";

import jacobVoice from "../../../../config/voice/jacob.json";
import defaultSender from "../../../../config/sender/default.json";
import exampleSender from "../../../../config/sender/EXAMPLE_not_real_customers.json";

import type { SenderContext } from "./pipeline/facts";

/** Validated at module load, so a malformed profile fails the build, not a request. */
export const VOICES: Record<string, VoiceProfile> = {
  jacob: validateVoice(jacobVoice, "jacob"),
};

export function getVoice(id = "jacob"): VoiceProfile {
  const v = VOICES[id];
  if (!v) throw new Error(`Voice profile "${id}" is not registered in config-registry.ts`);
  return v;
}

/**
 * Sender contexts. Keys MUST match the `id` field inside each file — the loader
 * returns the id to callers and it ends up in the request log.
 */
export const SENDERS: Record<string, SenderContext> = {
  default: defaultSender as SenderContext,
  EXAMPLE_not_real_customers: exampleSender as SenderContext,
};

export function senderContextIds(): string[] {
  return Object.keys(SENDERS).sort();
}
