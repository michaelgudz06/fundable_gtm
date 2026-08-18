/**
 * Cached Fundable identity lookups.
 *
 * Lifted out of `/api/v1/personalize/route.ts` so the find-LinkedIn work has
 * somewhere to sit that both routes can reach, rather than growing a 520-line
 * route file further.
 */

import { DeadlineError, newLedger, normalizeLinkedIn, personByLinkedIn } from "@fundable/shared";

import { getStorage } from "../storage";

/** Fundable's own TTL for person records elsewhere in this codebase. */
export const PERSON_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Identity lookups are cached because the upstream endpoint is slow on a cold
 * path (19s measured, against 2.6s warm) and a lead list re-run — a retry, a
 * second campaign, an n8n replay — asks the same question about the same people.
 *
 * A miss is cached too: "this LinkedIn URL is not in Fundable" is a stable
 * answer, and without it every unknown lead pays the slow path on every send.
 */
export async function personCached(
  linkedin: string,
  ledger: ReturnType<typeof newLedger>
): Promise<{ person: Awaited<ReturnType<typeof personByLinkedIn>>["person"]; timedOut: boolean }> {
  const storage = getStorage();
  const key = `person:${normalizeLinkedIn(linkedin) ?? linkedin.trim().toLowerCase()}`;
  const hit = (await storage.cacheGet(key, "fundable")) as { person: unknown } | null;
  if (hit && typeof hit === "object" && "person" in hit) {
    return { person: hit.person as never, timedOut: false };
  }

  let person: Awaited<ReturnType<typeof personByLinkedIn>>["person"];
  try {
    ({ person } = await personByLinkedIn(linkedin, ledger));
  } catch (e) {
    // `LEG_TIMEOUT_MS.fundable` is documented as degrading to "not resolved",
    // and until this catch existed it did not. /people is 19s cold against an
    // 8s cap, so the FIRST request for any uncached person escaped as a 502 and
    // the caller lost the whole lead over a lookup it can survive without. The
    // live contract check caught it the moment prod ran on an empty cache
    // (2026-08-18) — two costly cases, both the ones that pass a linkedin_url.
    //
    // Degrading is safe for ID-004 specifically because it is all-or-nothing:
    // without the profile we take no title, no company, and no employer from
    // it, so there is nothing to conflict with and nothing to personalize
    // wrongly. The lead falls back to the email-domain research path that a
    // lead with no LinkedIn already takes.
    //
    // Only OUR deadline degrades. A FundableError — a dead key, a 4xx — is a
    // real misconfiguration and must still surface as a 502. Nothing is cached
    // here either: a timeout is not an answer about this person.
    if (e instanceof DeadlineError) return { person: null, timedOut: true };
    throw e;
  }

  await storage.cacheSet(key, "fundable", { person: person ?? null }, PERSON_TTL_MS);
  return { person, timedOut: false };
}
