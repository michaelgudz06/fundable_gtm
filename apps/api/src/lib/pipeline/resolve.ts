/**
 * Stage 1: RESOLVE — identifiers in, Fundable entities out. Deterministic.
 *
 * email domain -> /companies, LinkedIn URL -> /people, run in parallel when both
 * are present. A person with no email still yields a company when their
 * current_company carries a domain (one chained lookup).
 *
 * Cached per person, source-split (spec §2): the Fundable half lives 30 days.
 * Misses are NOT cached — a company Fundable adds tomorrow should not be
 * invisible for a month because we asked today.
 */

import {
  companyByDomain,
  normalizeDomain,
  normalizeLinkedIn,
  personByLinkedIn,
  type Company,
  type Ledger,
  type Person,
} from "@fundable/shared";

import { CACHE_TTL_MS, type Storage } from "../storage";

export type Resolved = {
  company: Company | null;
  person: Person | null;
  domain: string | null;
  warnings: string[];
  fromCache: boolean;
};

type CachePayload = { company: Company | null; person: Person | null };

export function cacheKey(email?: string, linkedin?: string): string {
  const domain = email ? normalizeDomain(email).domain : "";
  const slug = linkedin ? normalizeLinkedIn(linkedin) ?? "" : "";
  return `${domain}|${slug}`;
}

export async function resolve(
  input: { email?: string; linkedin?: string },
  storage: Storage,
  ledger: Ledger
): Promise<Resolved> {
  const warnings: string[] = [];
  const key = cacheKey(input.email, input.linkedin);

  const cached = (await storage.cacheGet(key, "fundable")) as CachePayload | null;
  if (cached && (cached.company || cached.person)) {
    return {
      company: cached.company,
      person: cached.person,
      domain: cached.company?.domain ?? null,
      warnings,
      fromCache: true,
    };
  }

  const [companyRes, personRes] = await Promise.all([
    input.email
      ? companyByDomain(input.email, ledger)
      : Promise.resolve({ company: null as Company | null, warnings: [] as string[] }),
    input.linkedin
      ? personByLinkedIn(input.linkedin, ledger)
      : Promise.resolve({ person: null as Person | null, warnings: [] as string[] }),
  ]);

  warnings.push(...companyRes.warnings, ...personRes.warnings);
  let company = companyRes.company;
  const person = personRes.person;

  // No email (or unknown domain), but the person's employer carries a domain:
  // chain one more lookup so a LinkedIn-only request still gets company facts.
  if (!company && person?.current_company?.domain) {
    const chained = await companyByDomain(person.current_company.domain, ledger);
    company = chained.company;
    warnings.push(...chained.warnings);
  }

  // Personal-vs-work email mismatch is worth telling the caller about: the
  // company facts describe the employer, not the inbox we were handed.
  if (company && person?.current_company?.domain && input.email) {
    const emailDomain = normalizeDomain(input.email).domain;
    const employer = normalizeDomain(person.current_company.domain).domain;
    if (emailDomain !== employer) {
      warnings.push(
        `Email domain "${emailDomain}" differs from the person's current employer "${employer}"; company facts follow the email domain.`
      );
    }
  }

  if (company || person) {
    await storage.cacheSet(key, "fundable", { company, person }, CACHE_TTL_MS.fundable);
  }

  return { company, person, domain: company?.domain ?? null, warnings, fromCache: false };
}
