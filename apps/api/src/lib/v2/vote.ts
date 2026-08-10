/**
 * Majority voting over the classifier model (API-007).
 *
 * The interface is one call: runModel(system, user, ...) -> the winning vote.
 * Everything else — vote count, early resolution, the malformed-output retry,
 * and the transport-vs-malformed distinction — is implementation.
 */

import { ClassificationError, MODEL_PLAN, complete, parseJson, type Usage } from "@fundable/shared";

import { icpByNumber } from "./registry";

/**
 * How many independent votes decide a label.
 *
 * Three, because one is a coin flip on the leads that matter. Measured before
 * this existed: ten borderline CRE leads, three identical runs, seven came back
 * with a different label at least once. Caching the first answer made that
 * stable but froze whichever way the coin landed.
 *
 * The votes run concurrently, so this costs latency once and tokens three
 * times — and only on a lead's first sighting, since the result is cached
 * against its evidence afterwards.
 */
export const CLASSIFIER_VOTES = 3;

export type Vote = { icpNumber: number | null; reasoning: string; model: string };

/**
 * Raised when a HEALTHY provider returns something we cannot parse. Distinct
 * from a transport failure on purpose: the spec's canonical fixture says
 * malformed classifier JSON gets one retry and then FALLS BACK, while a dead
 * dependency must reach the caller as a 502. Both used to land in the same
 * `catch`, so malformed output was being reported as an outage.
 */
class MalformedOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedOutputError";
  }
}

/** One independent opinion, with the malformed-output retry (API-007). */
async function oneVote(system: string, user: string, usage: Usage[], deadlineAt?: number): Promise<Vote | null> {
  let lastTransportError: Error | null = null;
  let malformed = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await complete(
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        // No hedge here, deliberately. The hedge races a second request and
        // takes whichever replica answers first — which is a second source of
        // disagreement on top of the one the vote exists to resolve.
        {
          model: MODEL_PLAN,
          maxTokens: 250,
          temperature: 0,
          ...(deadlineAt !== undefined ? { deadlineAt } : {}),
        }
      );
      usage.push(res.usage);
      let parsed: { icp_number?: unknown; reasoning?: unknown };
      try {
        parsed = parseJson<{ icp_number?: unknown; reasoning?: unknown }>(res.text);
      } catch {
        // The provider answered; we could not read it. Retry once, then fall back.
        malformed = true;
        lastTransportError = null;
        continue;
      }
      const n = parsed.icp_number;
      if (n === null) return { icpNumber: null, reasoning: String(parsed.reasoning ?? ""), model: res.model };
      if (typeof n === "number" && icpByNumber(n)) {
        return { icpNumber: n, reasoning: String(parsed.reasoning ?? ""), model: res.model };
      }
      // Unknown number: treat as malformed and retry once.
      malformed = true;
      lastTransportError = null;
    } catch (err) {
      lastTransportError = err as Error;
    }
  }
  if (lastTransportError) throw lastTransportError;
  if (malformed) throw new MalformedOutputError("classifier returned unparseable output twice");
  return null;
}

export async function runModel(
  system: string,
  user: string,
  usage: Usage[],
  warnings: string[],
  agreement: { top: number; total: number },
  deadlineAt?: number
): Promise<Vote | null> {
  // Resolve on the first two votes that agree, rather than waiting for the
  // slowest of three. A majority of three is decided the moment two match, so
  // waiting on the third buys nothing but latency — and latency here is the
  // difference between meeting the 15s bar on a lead's first sighting and not.
  // Stragglers are left to finish; their tokens are already committed.
  const pending = Array.from({ length: CLASSIFIER_VOTES }, () => oneVote(system, user, usage, deadlineAt));
  const settled: PromiseSettledResult<Vote | null>[] = [];
  const votes: Vote[] = [];

  await new Promise<void>((done) => {
    let outstanding = pending.length;
    const counts = new Map<string, number>();
    for (const p of pending) {
      p.then(
        (value) => {
          settled.push({ status: "fulfilled", value });
          if (value) {
            votes.push(value);
            const key = value.icpNumber === null ? "not_core" : String(value.icpNumber);
            const n = (counts.get(key) ?? 0) + 1;
            counts.set(key, n);
            if (n * 2 > CLASSIFIER_VOTES) done();
          }
        },
        (reason) => settled.push({ status: "rejected", reason })
      ).finally(() => {
        if (--outstanding === 0) done();
      });
    }
  });

  if (!votes.length) {
    // Every vote failed. A transport failure must reach the caller as a 502,
    // never as a label; persistent malformed output from a healthy provider is
    // the one case that legitimately falls back (API-007).
    const rejections = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    const allMalformed = rejections.length > 0 && rejections.every((r) => r.reason instanceof MalformedOutputError);
    if (allMalformed) {
      // Every vote came back unreadable from a provider that answered. That is
      // the fixture's case: fall back, do not report an outage.
      warnings.push("Classifier output was unparseable on every vote; failing closed to Not Core ICP.");
      return { icpNumber: null, reasoning: "classifier output unparseable", model: "" };
    }
    const transport = rejections.find((r) => !(r.reason instanceof MalformedOutputError));
    if (transport) {
      throw new ClassificationError(
        `Classifier model unavailable: ${String((transport.reason as Error)?.message ?? transport.reason).slice(0, 140)}`,
        "model"
      );
    }
    return null;
  }

  const tally = new Map<string, { vote: Vote; count: number }>();
  for (const v of votes) {
    const key = v.icpNumber === null ? "not_core" : String(v.icpNumber);
    const entry = tally.get(key);
    if (entry) entry.count++;
    else tally.set(key, { vote: v, count: 1 });
  }

  const ranked = [...tally.values()].sort((a, b) => b.count - a.count);
  const top = ranked[0]!;
  agreement.top = top.count;
  agreement.total = votes.length;

  if (top.count * 2 <= votes.length) {
    // No majority — every vote disagreed. That is the definition of a lead the
    // classifier cannot call, so it fails closed rather than picking one.
    warnings.push(
      `Classifier votes did not agree (${ranked.map((r) => `${r.vote.icpNumber ?? "Not Core"}×${r.count}`).join(", ")}); failing closed.`
    );
    return { icpNumber: null, reasoning: "no majority among independent classifier votes", model: votes[0]?.model ?? "" };
  }

  if (top.count < votes.length) {
    warnings.push(`Classifier majority was ${top.count}/${votes.length}, not unanimous.`);
  }
  return top.vote;
}
