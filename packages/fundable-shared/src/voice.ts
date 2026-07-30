/**
 * Voice profile loading.
 *
 * The profile itself is data (`config/voice/<id>.json`) precisely so a second
 * voice is a config change rather than a refactor. This module's whole job is to
 * load it, assert the fields the writer depends on actually exist, and surface
 * the provenance warning.
 *
 * `provenance` matters more than it looks. A profile marked "placeholder" was
 * inferred from Jacob's LinkedIn posts, which are a different register from cold
 * email. Copy produced under it must be visibly flagged so nobody mistakes demo
 * voice for tuned voice.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Channel = "email" | "linkedin";

export type ChannelLimits = {
  max_words: number;
  target_words?: number;
  max_paragraphs?: number;
  subject_max_words?: number | null;
  asks?: number;
};

export type VoiceProfile = {
  id: string;
  display_name: string;
  provenance: "placeholder" | "real_examples";
  provenance_note?: string;
  warning_while_placeholder?: string;
  persona: Record<string, string>;
  register?: Record<string, string>;
  limits: Record<Channel, ChannelLimits>;
  structure?: Record<Channel, string[]>;
  subject_line?: { rules?: string[]; good_examples?: string[]; bad_examples?: string[] };
  tone_markers?: string[];
  forbidden_characters?: Record<string, { char: string; rule: string }>;
  forbidden_phrases?: string[];
  forbidden_formatting?: string[];
  hard_rules?: string[];
  sign_off?: Record<string, string | null>;
};

/** Walks up to the repo root, which is where `config/` lives. */
function configDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "config", "voice");
    try {
      readFileSync(join(dir, "package.json"), "utf8");
      // Only the root has both a package.json and config/voice.
      readFileSync(join(candidate, "jacob.json"), "utf8");
      return candidate;
    } catch {
      // keep walking
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate config/voice — expected it at the workspace root.");
}

const cache = new Map<string, VoiceProfile>();

export function loadVoice(id = "jacob"): VoiceProfile {
  const cached = cache.get(id);
  if (cached) return cached;

  const path = join(configDir(), `${id}.json`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`Voice profile "${id}" could not be read at ${path}: ${(err as Error).message}`);
  }

  const profile = parsed as VoiceProfile;

  // Fail loudly at load rather than producing voiceless copy at request time.
  const missing: string[] = [];
  if (!profile.id) missing.push("id");
  if (!profile.provenance) missing.push("provenance");
  if (!profile.persona) missing.push("persona");
  if (!profile.limits?.email?.max_words) missing.push("limits.email.max_words");
  if (!profile.limits?.linkedin?.max_words) missing.push("limits.linkedin.max_words");
  if (missing.length) {
    throw new Error(`Voice profile "${id}" is missing required field(s): ${missing.join(", ")}`);
  }
  if (profile.provenance !== "placeholder" && profile.provenance !== "real_examples") {
    throw new Error(
      `Voice profile "${id}" has provenance "${profile.provenance}"; expected "placeholder" or "real_examples".`
    );
  }

  cache.set(id, profile);
  return profile;
}

/**
 * The warning the API must return while the profile is untuned. Returns null
 * once provenance flips to "real_examples", so the warning disappears on its own
 * rather than needing to be remembered.
 */
export function provenanceWarning(profile: VoiceProfile): string | null {
  if (profile.provenance === "real_examples") return null;
  return (
    profile.warning_while_placeholder ??
    `Voice profile "${profile.id}" is a placeholder, not tuned on real sent emails. Review copy before sending.`
  );
}

/**
 * Belt and braces on the em dash rule, ported from post-studio. The prompt
 * forbids them and `verifyCopy` flags them, but this is what actually guarantees
 * one never reaches the clipboard.
 *
 * " — " becomes ", " mid-sentence; a dash pair used parenthetically collapses to
 * commas. An en dash is left alone.
 */
export function stripEmDashes(text: string): string {
  return text
    .replace(/\s*—\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/\s+,/g, ",")
    .replace(/,(\S)/g, ", $1");
}

/** Word count used against the profile's limits. Hyphenated words count once. */
export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export type LengthCheck = { ok: boolean; words: number; max: number; message?: string };

export function checkLength(text: string, profile: VoiceProfile, channel: Channel): LengthCheck {
  const max = profile.limits[channel].max_words;
  const words = wordCount(text);
  return words <= max
    ? { ok: true, words, max }
    : {
        ok: false,
        words,
        max,
        message: `${channel} copy is ${words} words, over the ${max}-word limit for this voice.`,
      };
}
