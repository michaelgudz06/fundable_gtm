/**
 * Fundable REST client.
 *
 * Ported from post-studio/src/lib/fundable.ts and extended with the calls the
 * personalize pipeline needs: domain -> company, LinkedIn URL -> person, round
 * history, and investor hydration.
 *
 * ---------------------------------------------------------------------------
 * EVERY GUARD IN THIS FILE EXISTS BECAUSE A LIVE PROBE CAUGHT THE FAILURE.
 * (Probed against production on 2026-07-29. Several of these contradict the PRD.)
 * ---------------------------------------------------------------------------
 *
 *  1. `page_size` DEFAULTS TO 10. A 100-domain batch sent without it returns 10
 *     rows, HTTP 200, no warning. The 90 absent rows look exactly like unknown
 *     domains. Every batch call here sends an explicit page_size.
 *
 *  2. UNKNOWN IDENTIFIERS ARE SILENTLY DROPPED — no error, no per-item status.
 *     And `meta.total_count` counts MATCHES, not requests, so it can never
 *     reveal a drop on its own. Only a set-difference against what we sent can.
 *
 *  3. RESULT ORDER IS NOT REQUEST ORDER (verified reversed on /investors). Never
 *     zip response[i] to request[i]: one dropped domain shifts every later index
 *     and silently attributes one company's funding round to a different
 *     prospect. Everything here resolves through a Map keyed on the identifier.
 *
 *  4. A MISS IS HTTP 200 with `success: true` and an empty array. Code that
 *     branches on `!res.ok` or `success === false` never fires.
 *
 *  5. AN EMPTY-STRING LinkedIn URL RETURNS THE ENTIRE 365k-ROW PEOPLE DATASET
 *     and hands back an arbitrary stranger as people[0], billed 1 credit. This
 *     is the worst failure mode in the whole API: it yields confident,
 *     completely wrong personalization about someone who is not the prospect.
 *     Blank identifiers are rejected before the request, and a single-URL
 *     lookup that returns more than one row is a hard error.
 *
 *  6. THE SAME DEAL HAS DIFFERENT FIELD NAMES ON DIFFERENT ENDPOINTS:
 *       /deals              -> round_type, investor_ids,  deal_descriptions
 *       /companies (nested) -> type,       investors,     description {obj}
 *     They are typed separately on purpose. Sharing one interface reads
 *     `undefined` at runtime with no type error.
 */

import { INDUSTRY_ALIASES, LOCATION_ALIASES, ROUND_EXPANSIONS, ROUND_PHRASES } from "./aliases.js";
import { DeadlineError, fetchWithDeadline, LEG_TIMEOUT_MS, retryOnce } from "./deadline.js";
import { optionalEnv, requireEnv } from "./env.js";

const DEFAULT_BASE_URL = "https://www.tryfundable.ai/api/v1";

function baseUrl(): string {
  return optionalEnv("FUNDABLE_BASE_URL") ?? DEFAULT_BASE_URL;
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * `message` appears ONLY on zero-match responses, and `meta` is null on errors,
 * so both are optional. Getting this wrong crashes the failure path.
 */
export type Meta = {
  total_count?: number;
  page?: number;
  page_size?: number;
  credits_used?: number;
};

type Envelope<T> = {
  success: boolean;
  data?: T;
  meta?: Meta | null;
  message?: string;
  error?: { code?: string; message?: string; details?: { errors?: unknown[] } };
  statusCode?: number;
};

/** Accumulates spend across a pipeline run so the response can report `usage`. */
export type Ledger = { credits: number; calls: number; deadlineAt?: number };

export function newLedger(deadlineAt?: number): Ledger {
  return deadlineAt === undefined ? { credits: 0, calls: 0 } : { credits: 0, calls: 0, deadlineAt };
}

export class FundableError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** 422s report every problem at once; `error.message` mirrors only the first. */
    readonly details?: unknown[]
  ) {
    super(message);
    this.name = "FundableError";
  }
}

export type CallResult<T> = { data: T; meta: Meta; message?: string; creditsUsed: number };

export async function call<T>(
  path: string,
  body?: unknown,
  ledger?: Ledger
): Promise<CallResult<T>> {
  const key = requireEnv("FUNDABLE_API_KEY");
  const res = await retryOnce(
    () =>
      fetchWithDeadline(
        `${baseUrl()}${path}`,
        {
          method: body ? "POST" : "GET",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
          cache: "no-store",
        },
        { leg: `fundable${path}`, cap: LEG_TIMEOUT_MS.fundable, budget: ledger }
      ),
    // A dropped socket is worth one more try; a deadline is not — the budget
    // that produced it will not have grown.
    (err) => !(err instanceof DeadlineError) && err instanceof TypeError,
    ledger
  );

  let json: Envelope<T>;
  try {
    json = (await res.json()) as Envelope<T>;
  } catch {
    throw new FundableError(`Fundable ${path} returned unparseable body`, res.status);
  }

  if (!json.success) {
    // Validation errors carry no data and no meta at all.
    throw new FundableError(
      json.error?.message ?? `Fundable ${path} failed (${res.status})`,
      json.statusCode ?? res.status,
      json.error?.code,
      json.error?.details?.errors
    );
  }

  const meta = json.meta ?? {};
  const creditsUsed = meta.credits_used ?? 0;
  if (ledger) {
    ledger.credits += creditsUsed;
    ledger.calls += 1;
  }

  return {
    data: (json.data ?? ({} as T)),
    meta,
    ...(json.message !== undefined ? { message: json.message } : {}),
    creditsUsed,
  };
}

// ---------------------------------------------------------------------------
// Batch results
// ---------------------------------------------------------------------------

/**
 * The shape every batch lookup returns. `missing` and `truncated` are the two
 * things the caller must surface as warnings — see guards 1 and 2 in the header.
 */
export type BatchResult<T> = {
  /** Identifier (already normalised) -> row. */
  found: Map<string, T>;
  /** Requested identifiers with no row returned. Genuine not-founds. */
  missing: string[];
  /**
   * True when the API reported more matches than it returned, i.e. we were
   * paginated rather than told "not found". Absences are NOT trustworthy when
   * this is set, so callers must not report `missing` as unknown identifiers.
   */
  truncated: boolean;
  creditsUsed: number;
};

function buildBatch<T>(
  requested: string[],
  rows: T[],
  keyOf: (row: T) => string | undefined,
  meta: Meta,
  creditsUsed: number
): BatchResult<T> {
  const found = new Map<string, T>();
  for (const row of rows) {
    const k = keyOf(row);
    if (k) found.set(k, row);
  }

  const total = meta.total_count ?? rows.length;
  // total_count > rows.length means a page boundary, not a miss.
  const truncated = total > rows.length;

  return {
    found,
    missing: truncated ? [] : requested.filter((r) => !found.has(r)),
    truncated,
    creditsUsed,
  };
}

// ---------------------------------------------------------------------------
// Identifier normalisation
// ---------------------------------------------------------------------------

/**
 * `www.ramp.com` matched NOTHING while `ramp.com` matched — and the miss is
 * indistinguishable from a nonexistent company. Only `www.` was verified, so
 * other subdomains are reported rather than silently mangled: guessing the
 * registrable domain without a public-suffix list breaks `foo.co.uk`.
 */
/**
 * Canonical form of an address, for identity and cache keys.
 *
 * Plus-addressing is the common case: `reed+fundable@acme.com` and
 * `reed@acme.com` are one person, and treating them as two splits the cache and
 * can hand the same human two different labels — which the spec's first
 * acceptance criterion forbids.
 *
 * Deliberately NOT doing Gmail's dot-folding: it is provider-specific, and
 * silently merging `a.b@` with `ab@` on a domain that treats them as separate
 * mailboxes would be worse than the split it fixes.
 */
export function normalizeEmail(input: string): string {
  const raw = input.trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  if (at <= 0) return raw;
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  const plus = local.indexOf("+");
  return `${plus > 0 ? local.slice(0, plus) : local}@${domain}`;
}

export function normalizeDomain(input: string): { domain: string; warning?: string } {
  let d = input.trim().toLowerCase();

  // Accept a full email or a URL and reduce it to a host.
  if (d.includes("@")) d = d.slice(d.lastIndexOf("@") + 1);
  d = d.replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
  d = d.replace(/^www\./, "").replace(/\.$/, "");

  const labels = d.split(".");
  const warning =
    labels.length > 2 && !/\.(co|com|org|net|gov|ac|edu)\.[a-z]{2}$/.test(d)
      ? `Domain "${d}" still has a subdomain after stripping "www."; Fundable matches only registrable domains, so this may resolve to nothing.`
      : undefined;

  return warning ? { domain: d, warning } : { domain: d };
}

/**
 * The server matches on the `/in/<slug>` regardless of scheme, www, or trailing
 * slash — the PRD's "exact URL match required" is wrong. Normalisation is still
 * required, for cache coherence and cost: five spellings of one profile are
 * five cache keys and five credits otherwise.
 *
 * Returns null for anything without a usable slug. A blank string MUST never
 * reach the API (guard 5).
 */
export function normalizeLinkedIn(input: string): string | null {
  const raw = input?.trim();
  if (!raw) return null;

  const match = raw.toLowerCase().match(/linkedin\.com\/in\/([^/?#\s]+)/);
  const slug = match?.[1];
  if (!slug) return null;

  return `https://www.linkedin.com/in/${slug}`;
}

// ---------------------------------------------------------------------------
// Types — /companies
// ---------------------------------------------------------------------------

export type NamedPermalink = { name?: string; permalink?: string };

/** `location` can be `{}`, so every level is optional. */
export type Location = {
  city?: NamedPermalink;
  state?: NamedPermalink;
  country?: NamedPermalink;
  region?: NamedPermalink;
};

/**
 * The deal embedded in a /companies response. Field names differ from a
 * top-level /deals row — see guard 6.
 */
export type EmbeddedDeal = {
  id?: string;
  /** On /deals this same field is called `round_type`. */
  type?: string;
  total_round_raised?: number | null;
  date?: string | null;
  pre?: boolean;
  extension?: boolean;
  /** Third round modifier: "NONE" | "TWO" | ... encodes Series E-2 style rounds. */
  intermediate?: string;
  /** Flat array of investor UUIDs. NOT `investor_ids`, and NOT objects. */
  investors?: string[];
  angel_investor_ids?: string[];
  /** An OBJECT, not a string. Rendering it directly gives "[object Object]". */
  description?: { short_description?: string; long_description?: string };
  financings?: { size_usd?: number | null; size_native?: number | null; currency?: string }[];
};

export type Company = {
  id: string;
  name: string;
  domain?: string | null;
  short_description?: string | null;
  long_description?: string | null;
  linkedin?: string | null;
  num_employees?: string | null;
  total_raised?: number | null;
  latest_valuation_usd?: number | null;
  /** When this is the same DAY as latest_deal.date, the valuation prices that round. */
  latest_valuation_date?: string | null;
  industries?: NamedPermalink[];
  location?: Location;
  /** Null/absent for unfunded companies — always guard before dereferencing. */
  latest_deal?: EmbeddedDeal | null;
  /**
   * Every investor across every round (54 for Ramp vs 26 on the latest deal).
   * This is the right set for the investor-overlap tie, and it arrives free
   * with the company lookup.
   */
  all_investor_ids?: string[];
  /** Semantic-search score. Always null for domain lookups — never rank on it. */
  similarity?: number | null;
};

/** Fundable caps a page at 500; 100 domains per call is verified working. */
const MAX_DOMAINS_PER_CALL = 100;

export async function companiesByDomains(
  domains: string[],
  ledger?: Ledger
): Promise<BatchResult<Company> & { warnings: string[] }> {
  const warnings: string[] = [];
  const normalized: string[] = [];

  for (const d of domains) {
    const { domain, warning } = normalizeDomain(d);
    if (!domain) continue;
    if (warning) warnings.push(warning);
    if (!normalized.includes(domain)) normalized.push(domain);
  }

  if (!normalized.length) {
    return { found: new Map(), missing: [], truncated: false, creditsUsed: 0, warnings };
  }
  if (normalized.length > MAX_DOMAINS_PER_CALL) {
    throw new FundableError(
      `companiesByDomains: ${normalized.length} domains exceeds the ${MAX_DOMAINS_PER_CALL}-per-call limit; chunk upstream.`,
      400
    );
  }

  const { data, meta, creditsUsed } = await call<{ companies?: Company[] }>(
    "/companies",
    {
      identifiers: { domains: normalized },
      // Explicit, always. Guard 1.
      page_size: Math.max(normalized.length, 1),
      page: 0,
    },
    ledger
  );

  const rows = data.companies ?? [];
  const batch = buildBatch(normalized, rows, (c) => c.domain?.toLowerCase(), meta, creditsUsed);

  if (batch.truncated) {
    warnings.push(
      `Fundable /companies reported ${meta.total_count} matches but returned ${rows.length}; absences are unreliable for this call.`
    );
  }
  for (const d of batch.missing) {
    warnings.push(`No Fundable company matched domain "${d}".`);
  }

  return { ...batch, warnings };
}

export async function companyByDomain(
  domain: string,
  ledger?: Ledger
): Promise<{ company: Company | null; warnings: string[]; creditsUsed: number }> {
  const res = await companiesByDomains([domain], ledger);
  const { domain: key } = normalizeDomain(domain);
  return {
    company: res.found.get(key) ?? null,
    warnings: res.warnings,
    creditsUsed: res.creditsUsed,
  };
}

// ---------------------------------------------------------------------------
// Types — /people
// ---------------------------------------------------------------------------

export type Person = {
  id: string;
  /**
   * The ONLY usable name field. `first_name` and `last_name` are both null even
   * on a successful hit, so they are deliberately not typed here — the greeting's
   * `{{first_name}}` comes from firstNameOf(), not from the API.
   */
  name?: string | null;
  /** Canonical form, echoed regardless of the variant sent. Use as the oracle. */
  linkedin_url?: string | null;
  title?: string | null;
  about?: string | null;
  /** Short value ("New York"). Inverted from intuition vs `city`. */
  location?: string | null;
  /** Full trail ("New York, New York, United States"). */
  city?: string | null;
  is_founder?: boolean;
  is_ceo?: boolean;
  is_investor?: boolean;
  is_angel?: boolean;
  has_led_deal?: boolean;
  current_company?: { id?: string; name?: string; domain?: string; permalink?: string } | null;
  /** Present but empty even for well-documented careers. Do not build on it. */
  employment_history?: unknown[];
  education_history?: { school?: string; degree?: string | null; field_of_study?: string | null }[];
  investor_highlights?: Record<string, unknown> | null;
};

/**
 * LinkedIn URL -> person.
 *
 * Guard 5 lives here. A blank URL is rejected before the request, because the
 * API answers a blank identifier with the entire people dataset and an
 * arbitrary stranger in row 0.
 */
export async function peopleByLinkedIn(
  urls: string[],
  ledger?: Ledger
): Promise<BatchResult<Person> & { warnings: string[] }> {
  const warnings: string[] = [];
  const normalized: string[] = [];

  for (const u of urls) {
    const n = normalizeLinkedIn(u);
    if (!n) {
      warnings.push(
        `Ignored unusable LinkedIn URL ${JSON.stringify(u)} — no /in/<slug> found. ` +
          `Blank or malformed URLs are never sent: Fundable answers a blank identifier ` +
          `with the entire people dataset and an unrelated person in row 0.`
      );
      continue;
    }
    if (!normalized.includes(n)) normalized.push(n);
  }

  if (!normalized.length) {
    return { found: new Map(), missing: [], truncated: false, creditsUsed: 0, warnings };
  }

  const { data, meta, creditsUsed } = await call<{ people?: Person[] }>(
    "/people",
    { identifiers: { linkedin_urls: normalized }, page_size: normalized.length, page: 0 },
    ledger
  );

  const rows = data.people ?? [];

  // A filter that failed to apply returns an absurd total_count. Refuse it
  // rather than personalising a message about whoever happens to be row 0.
  const total = meta.total_count ?? rows.length;
  if (total > normalized.length) {
    throw new FundableError(
      `Fundable /people returned total_count=${total} for ${normalized.length} URL(s). ` +
        `The identifier filter did not apply; refusing to use these rows.`,
      502,
      "FILTER_NOT_APPLIED"
    );
  }

  const batch = buildBatch(
    normalized,
    rows,
    (p) => (p.linkedin_url ? normalizeLinkedIn(p.linkedin_url) ?? undefined : undefined),
    meta,
    creditsUsed
  );

  for (const u of batch.missing) {
    warnings.push(`No Fundable person matched ${u} (the people dataset skews to funded-company staff and investors).`);
  }

  return { ...batch, warnings };
}

export async function personByLinkedIn(
  url: string,
  ledger?: Ledger
): Promise<{ person: Person | null; warnings: string[]; creditsUsed: number }> {
  const res = await peopleByLinkedIn([url], ledger);
  const key = normalizeLinkedIn(url);
  return {
    person: key ? res.found.get(key) ?? null : null,
    warnings: res.warnings,
    creditsUsed: res.creditsUsed,
  };
}

// ---------------------------------------------------------------------------
// Types — /deals
// ---------------------------------------------------------------------------

export type DealSort = "most_recent_deal" | "oldest_deal" | "largest_raise" | "smallest_raise";

/** A top-level /deals row. Field names differ from EmbeddedDeal — guard 6. */
export type Deal = {
  id: string;
  /** On /companies' latest_deal this same field is called `type`. */
  round_type?: string;
  date?: string | null;
  total_round_raised?: number | null;
  pre?: boolean;
  extension?: boolean;
  intermediate?: string;
  /** An object, not a scalar. Absent when no valuation was disclosed. */
  valuation?: { valuation_usd?: number | null; valuation_currency?: string } | null;
  /**
   * Order is NOT meaningful. investor_ids[0] is NOT the lead — verified: the
   * same deal returns the same 26-element set in a different order from
   * /companies. There is no lead flag anywhere in the API.
   */
  investor_ids?: string[];
  /** The ONLY place a lead investor is named, and it is prose. See leadInvestorProse(). */
  deal_descriptions?: { short_description?: string; long_description?: string };
  articles?: { url?: string; title?: string; is_primary?: boolean }[];
  company_id?: string;
};

export async function dealsForCompany(
  companyId: string,
  opts: { limit?: number; sortBy?: DealSort } = {},
  ledger?: Ledger
): Promise<{ deals: Deal[]; totalCount: number; creditsUsed: number }> {
  if (!companyId) throw new FundableError("dealsForCompany: companyId is required", 400);

  // Charged per deal RETURNED, so the limit is the cost lever. Default small.
  const pageSize = Math.min(Math.max(opts.limit ?? 5, 1), 500);

  const { data, meta, creditsUsed } = await call<{ deals?: Deal[] }>(
    "/deals",
    {
      // Must be nested under `company`; a top-level company_ids is a 422.
      company: { company_ids: [companyId] },
      page_size: pageSize,
      page: 0,
      sort_by: opts.sortBy ?? "most_recent_deal",
    },
    ledger
  );

  return {
    deals: data.deals ?? [],
    totalCount: meta.total_count ?? (data.deals?.length ?? 0),
    creditsUsed,
  };
}

/** Chunked at 50 per the PRD; the API does not enforce it, so we do. */
export const MAX_COMPANIES_PER_DEALS_CALL = 50;

// ---------------------------------------------------------------------------
// Types — /investors
// ---------------------------------------------------------------------------

export type Investor = {
  id: string;
  name?: string | null;
  /** Bare hostname. `website` is the full URL — don't swap them. */
  domain?: string | null;
  website?: string | null;
  linkedin?: string | null;
  short_description?: string | null;
  /** Can be `{}` — a truthiness check passes but `.city.name` throws. */
  location?: Location;
  /** Comma-and-space-joined STRING, not an array. */
  investment_stage?: string | null;
  /** All-time. Different time base from deal_count_last_12_months. */
  lead_deal_count?: number | null;
  lead_deal_count_last_12_months?: number | null;
  deal_count_last_12_months?: number | null;
  total_deal_count?: number | null;
  most_recent_deal_date?: string | null;
  top_industries?: NamedPermalink[];
  top_locations?: (NamedPermalink & { full_name?: string; type?: string })[];
  top_round_types?: { name?: string; count?: number }[];
};

const MAX_INVESTORS_PER_CALL = 100;

export async function investorsByIds(
  ids: string[],
  ledger?: Ledger
): Promise<BatchResult<Investor>> {
  const unique = [...new Set(ids.filter(Boolean))];
  // An empty ids array is a 422, not an empty result. Guard before spending.
  if (!unique.length) {
    return { found: new Map(), missing: [], truncated: false, creditsUsed: 0 };
  }

  const slice = unique.slice(0, MAX_INVESTORS_PER_CALL);
  const { data, meta, creditsUsed } = await call<{ investors?: Investor[] }>(
    "/investors",
    { identifiers: { ids: slice }, page_size: slice.length, page: 0 },
    ledger
  );

  return buildBatch(slice, data.investors ?? [], (i) => i.id, meta, creditsUsed);
}

/** Split the comma-joined `investment_stage` string into usable stages. */
export function investmentStages(investor: Investor): string[] {
  return (investor.investment_stage ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Lead investor
// ---------------------------------------------------------------------------

/**
 * There is NO structured lead-investor field anywhere in the API: no
 * lead_investor_id, no per-investor role, no lead flag on a deal. The only
 * signal is prose in `deal_descriptions.short_description` ("...led by ICONIQ,
 * GIC, and Ontario Teachers' Pension Plan").
 *
 * So this returns the sentence, not a parsed name. The pipeline should quote it
 * as evidence rather than extract from it: an LLM-extracted lead is exactly the
 * kind of unverifiable claim the whole verify stage exists to stop, and naming
 * the wrong fund as lead is a credibility-destroying error in an outbound email.
 */
export function leadInvestorProse(deal: Deal | EmbeddedDeal): string | null {
  const d = deal as Deal & EmbeddedDeal;
  const short = d.deal_descriptions?.short_description ?? d.description?.short_description;
  if (!short) return null;
  return /\bled by\b/i.test(short) ? short : null;
}

// ---------------------------------------------------------------------------
// Resolvers (alias-backed). Unchanged from post-studio.
// ---------------------------------------------------------------------------

export type FinancingType = { type: string; pre?: boolean; extension?: boolean };

export async function resolveIndustry(term: string, ledger?: Ledger): Promise<string | null> {
  const key = term.trim().toLowerCase();
  const alias = INDUSTRY_ALIASES[key];
  const search = alias?.search ?? key;

  const { data } = await call<{ industries?: { permalink: string; name: string }[] }>(
    `/industry/search?name=${encodeURIComponent(search)}&limit=25`,
    undefined,
    ledger
  );
  const hits = data.industries ?? [];
  if (!hits.length) return null;

  if (alias) {
    const exact = hits.find((h) => h.permalink === alias.permalink);
    if (exact) return exact.permalink;
  }
  const nameMatch = hits.find((h) => h.name.toLowerCase() === search);
  return (nameMatch ?? hits[0])!.permalink;
}

export async function resolveLocation(term: string, ledger?: Ledger): Promise<string | null> {
  const key = term.trim().toLowerCase();
  const alias = LOCATION_ALIASES[key];
  const search = alias?.search ?? key;

  const { data } = await call<{ locations?: { permalink: string; name: string }[] }>(
    `/location/search?name=${encodeURIComponent(search)}&limit=25`,
    undefined,
    ledger
  );
  const hits = data.locations ?? [];
  if (!hits.length) return null;

  // Fundable returns no relevance order, so "austin" can yield Austin, Indiana
  // first. Only the curated permalink disambiguates the well-known cities.
  if (alias) {
    const exact = hits.find((h) => h.permalink === alias.permalink);
    if (exact) return exact.permalink;
  }
  return hits[0]!.permalink;
}

export function resolveRounds(phrases: string[]): FinancingType[] {
  const out: FinancingType[] = [];
  for (const raw of phrases) {
    const key = raw.trim().toLowerCase();
    const expanded = ROUND_EXPANSIONS[key];
    if (expanded) {
      out.push(...expanded);
      continue;
    }
    const single = ROUND_PHRASES[key];
    if (single) out.push(single);
  }
  const seen = new Set<string>();
  return out.filter((f) => {
    const k = `${f.type}|${f.pre ?? false}|${f.extension ?? false}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/**
 * A correct round label needs all four modifiers. Rendering `round_type` alone
 * prints "series e" for a deal that is actually a Series E-2.
 */
export function roundLabel(deal?: Deal | EmbeddedDeal | null): string {
  if (!deal) return "undisclosed";
  const d = deal as Deal & EmbeddedDeal;
  const rawType = d.round_type ?? d.type;
  if (!rawType) return "undisclosed";

  // HYBRID_SEED / HYBRID_SERIES_A straddle two stages; Jacob writes the plain stage.
  const base = rawType.replace(/^HYBRID_/, "").toLowerCase().replace(/_/g, " ");

  let label = d.pre ? `pre-${base}` : base;

  const intermediate = (d.intermediate ?? "NONE").toUpperCase();
  const ORDINAL: Record<string, string> = { TWO: "2", THREE: "3", FOUR: "4" };
  const suffix = ORDINAL[intermediate];
  if (suffix) label = `${label}-${suffix}`;

  if (d.extension) label = `${label} ext`;
  return label;
}

export function money(usd: number | null | undefined): string {
  if (usd == null || usd <= 0) return "undisclosed";
  if (usd >= 1_000_000_000) return `$${+(usd / 1_000_000_000).toFixed(1)}B`;
  if (usd >= 1_000_000) {
    const m = usd / 1_000_000;
    return `$${m >= 10 ? Math.round(m) : +m.toFixed(1)}M`;
  }
  if (usd >= 1_000) return `$${Math.round(usd / 1_000)}K`;
  return `$${usd}`;
}

/**
 * Deal dates are day-precision only — many carry a placeholder T12:00:00.000Z,
 * so rendering a time of day invents precision the data does not have.
 */
export function dealDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Greeting name. Fundable returns `first_name`/`last_name` as null even on a hit,
 * so the only source is the full `name` string (or a caller-supplied name).
 *
 * Deliberately conservative: a mononym or an unparseable name returns null so the
 * caller can fall back rather than greet someone "Hi Dr.". Getting a first name
 * wrong is visible in the first two words of the email.
 */
export function firstNameOf(full: string | null | undefined): string | null {
  const name = full?.trim().replace(/\s+/g, " ");
  if (!name) return null;

  const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "dr", "prof", "professor", "sir"]);
  const parts = name
    .split(" ")
    .filter((p) => !HONORIFICS.has(p.replace(/\./g, "").toLowerCase()));

  const first = parts[0];
  // A single token is as likely to be a handle or a company as a given name.
  if (!first || parts.length < 2) return null;
  // "J." or "J" carries no greeting value.
  if (first.replace(/\./g, "").length < 2) return null;
  return first;
}

export function cityOf(company: Company): string | null {
  // `location.region.name` is the CONTINENT and the flat `region` is the state.
  // Only the structured city/state/country fields mean what they say.
  return (
    company.location?.city?.name ??
    company.location?.state?.name ??
    company.location?.country?.name ??
    null
  );
}
