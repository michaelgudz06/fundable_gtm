/**
 * OpenRouter client. Ported from post-studio/src/lib/openrouter.ts.
 *
 * Two changes from the original: the key is read through `requireEnv` (so
 * standalone scripts get the repo-root .env), and `complete` also reports token
 * usage, because the personalize response has to return a `usage` block.
 */

import { fetchWithDeadline, LEG_TIMEOUT_MS } from "./deadline.js";
import { requireEnv } from "./env.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// DeepSeek V4 is a reasoning model on OpenRouter. Left on, it burns the token
// budget on `reasoning` and returns a null `content`, so we disable it and let
// the prompts carry the structure instead.
export const MODEL_WRITE = "deepseek/deepseek-v4-pro";
export const MODEL_PLAN = "deepseek/deepseek-v4-flash";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type Usage = { promptTokens: number; completionTokens: number; totalTokens: number };

export type CompleteResult = { text: string; usage: Usage; model: string };

function headers() {
  return {
    Authorization: `Bearer ${requireEnv("OPENROUTER_API_KEY")}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://fundable.ai",
    "X-Title": "Fundable Personalization API",
  };
}

function body(messages: ChatMessage[], opts: CompleteOpts, stream: boolean) {
  return JSON.stringify({
    model: opts.model ?? MODEL_WRITE,
    messages,
    max_tokens: opts.maxTokens ?? 2000,
    temperature: opts.temperature ?? 0.7,
    // Non-negotiable: see the note on MODEL_WRITE above.
    reasoning: { enabled: false },
    ...(stream ? { stream: true } : {}),
  });
}

export type CompleteOpts = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  /**
   * Racing latency hedge. OpenRouter occasionally lands on a slow provider
   * replica (measured live: 17.7s, and a ~15% >8s tail one evening, for calls
   * that normally take 2-4s). With this set, a SECOND identical request fires
   * after `hedgeAfterMs` and whichever finishes first wins; the loser is
   * aborted. A sequential deadline-then-retry waits out the whole deadline
   * before starting over — the race pays for the tail with one overlapping
   * call (~$0.002 on the writer) instead of the user's time.
   */
  hedgeAfterMs?: number;
  /** Whole-request budget; the leg cap is clamped to whatever remains of it. */
  deadlineAt?: number;
};

const EMPTY_USAGE: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

export async function complete(
  messages: ChatMessage[],
  opts: CompleteOpts = {}
): Promise<CompleteResult> {
  const hedgeAfterMs = opts.hedgeAfterMs;
  if (!hedgeAfterMs) return completeOnce(messages, opts, undefined);

  const ctlA = new AbortController();
  const ctlB = new AbortController();

  return new Promise<CompleteResult>((resolve, reject) => {
    let settled = false;
    let inFlight = 1;

    const win = (value: CompleteResult, loser: AbortController) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      loser.abort();
      resolve(value);
    };
    const lose = (err: unknown) => {
      inFlight--;
      // Losers aborted by the winner arrive here too; `settled` swallows them.
      // This is also what makes a fast primary failure (e.g. a 4xx) fail the
      // whole call rather than wait for the hedge: with no hedge in flight yet
      // `inFlight` hits 0, and a second identical call would fail identically.
      if (!settled && inFlight <= 0) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    };

    completeOnce(messages, opts, ctlA.signal).then((v) => win(v, ctlB), lose);

    const timer = setTimeout(() => {
      if (settled) return;
      inFlight++;
      completeOnce(messages, opts, ctlB.signal).then((v) => win(v, ctlA), lose);
    }, hedgeAfterMs);
  });
}

async function completeOnce(
  messages: ChatMessage[],
  opts: CompleteOpts,
  signal: AbortSignal | undefined
): Promise<CompleteResult> {
  const res = await fetchWithDeadline(
    OPENROUTER_URL,
    { method: "POST", headers: headers(), body: body(messages, opts, false) },
    {
      leg: "openrouter",
      cap: LEG_TIMEOUT_MS.model,
      ...(opts.deadlineAt !== undefined ? { budget: { deadlineAt: opts.deadlineAt } } : {}),
      // The hedge's abort of its losing half must still work; fetchWithDeadline
      // composes the two signals rather than replacing the caller's.
      ...(signal ? { signal } : {}),
    }
  );
  const json = (await res.json()) as {
    error?: { message?: string };
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    model?: string;
  };
  if (!res.ok) throw new Error(json.error?.message ?? `OpenRouter ${res.status}`);

  const text = json.choices?.[0]?.message?.content;
  // A null content here almost always means reasoning got re-enabled somewhere.
  if (!text) throw new Error("Model returned no content");

  return {
    text,
    model: json.model ?? (opts.model ?? MODEL_WRITE),
    usage: {
      promptTokens: json.usage?.prompt_tokens ?? 0,
      completionTokens: json.usage?.completion_tokens ?? 0,
      totalTokens: json.usage?.total_tokens ?? 0,
    },
  };
}

/** Same call, but yields text deltas for the demo UI's streaming view. */
export async function* stream(
  messages: ChatMessage[],
  opts: CompleteOpts = {}
): AsyncGenerator<string> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: headers(),
    body: body(messages, opts, true),
  });
  if (!res.ok || !res.body) {
    const err = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${err.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are newline-delimited; hold the trailing partial line back.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
        if (delta) yield delta as string;
      } catch {
        // OpenRouter interleaves ": OPENROUTER PROCESSING" keepalives.
      }
    }
  }
}

/** Extracts a JSON object from a model reply that may be fenced or chatty. */
export function parseJson<T>(raw: string): T {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : raw;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error(`No JSON in model reply: ${raw.slice(0, 200)}`);
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}

export { EMPTY_USAGE };
