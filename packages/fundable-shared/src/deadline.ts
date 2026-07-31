/**
 * Request deadlines.
 *
 * Until this file existed, not one of the five upstream fetches had a timeout:
 * Exa search, Exa answer, the model call, and the Fundable REST call would all
 * wait as long as the socket stayed open. The spec's p95 <= 15s is an acceptance
 * criterion, and nothing in the code enforced it — the only reason latency
 * looked fine is that the upstreams usually behaved. `/people` was measured at
 * 19s cold, so "usually" was already doing a lot of work.
 *
 * Two bounds, and a request needs both:
 *
 *   - a PER-LEG cap, so one pathological call cannot hang on its own
 *   - a PER-REQUEST budget, so several well-behaved-but-slow legs cannot add up
 *     past the SLO between them
 *
 * The budget travels on the ledger. That object is already created once per
 * request and already passed to every upstream call, so it is the natural place
 * to carry "how much time is left" without threading a parameter through every
 * signature.
 */

/** Per-leg caps. Generous enough not to fail healthy calls, tight enough to bound the tail. */
export const LEG_TIMEOUT_MS = {
  /** Identity lookup. Degrades to "not resolved", which is already a tested path. */
  fundable: 8_000,
  /** Company research. A miss becomes a fail-closed classification, not an error. */
  exa: 10_000,
  /** One classifier vote. Votes run concurrently and resolve on the first two that agree. */
  model: 12_000,
} as const;

/**
 * Whole-request budget, slightly under the 15s bar so the response still has
 * room to compose and serialise after the last upstream call returns.
 */
export const REQUEST_BUDGET_MS = 13_500;

export class DeadlineError extends Error {
  constructor(readonly leg: string, readonly waitedMs: number) {
    super(`${leg} exceeded its deadline after ${waitedMs}ms`);
    this.name = "DeadlineError";
  }
}

/** Anything carrying a per-request deadline. Both ledgers satisfy this. */
export type Budgeted = { deadlineAt?: number };

export function startBudget(budgetMs: number = REQUEST_BUDGET_MS): number {
  return Date.now() + budgetMs;
}

/**
 * How long this leg may take: the smaller of its own cap and whatever remains
 * of the request budget. Never returns zero — a caller that is already out of
 * budget still gets a token amount so the failure comes back as a timeout with
 * a real message rather than an immediately-aborted fetch with none.
 */
export function legTimeoutMs(cap: number, budget?: Budgeted): number {
  const remaining = budget?.deadlineAt ? budget.deadlineAt - Date.now() : Infinity;
  return Math.max(250, Math.min(cap, remaining));
}

/**
 * A fetch that cannot outlive its deadline.
 *
 * Composes with a caller-supplied signal rather than replacing it — the model
 * client aborts the losing half of its hedge that way, and losing that would
 * turn a latency optimisation into a leak.
 */
export async function fetchWithDeadline(
  url: string,
  init: RequestInit,
  opts: { leg: string; cap: number; budget?: Budgeted | undefined; signal?: AbortSignal | undefined }
): Promise<Response> {
  const ms = legTimeoutMs(opts.cap, opts.budget);
  const timeout = AbortSignal.timeout(ms);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

  const started = Date.now();
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    // Distinguish OUR deadline from the caller's abort: the hedge aborting its
    // loser is normal and must not be reported as an upstream timeout.
    if (timeout.aborted && !opts.signal?.aborted) {
      throw new DeadlineError(opts.leg, Date.now() - started);
    }
    throw err;
  }
}

/**
 * One retry for a transient read.
 *
 * "Transient" is decided by the caller, because only it knows which of its own
 * error shapes are worth repeating: a 422 from a bad request never is, a dropped
 * socket usually is. Deliberately one retry, not a backoff loop — the request
 * budget above is the real bound, and a second attempt that cannot finish inside
 * it is worse than a clean failure.
 */
export async function retryOnce<T>(
  fn: () => Promise<T>,
  isTransient: (err: unknown) => boolean,
  budget?: Budgeted
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const outOfBudget = budget?.deadlineAt !== undefined && Date.now() >= budget.deadlineAt;
    if (!isTransient(err) || outOfBudget) throw err;
    return await fn();
  }
}
