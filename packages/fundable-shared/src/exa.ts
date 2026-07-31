/**
 * Exa client — recency and long-tail enrichment. Fundable owns what happened to
 * the company; Exa covers what the person said and did.
 *
 * ---------------------------------------------------------------------------
 * PROBED LIVE 2026-07-29. Two corrections to the PRD:
 * ---------------------------------------------------------------------------
 *
 *  1. `category: "people"` does NOT return "recent LinkedIn posts" as the PRD
 *     says. It queries a dedicated person index and returns a structured PERSON
 *     ENTITY: name, location, and a full dated `workHistory`. That is more
 *     useful than posts — it is what makes the repeat-founder tie computable at
 *     all, since Fundable's own `employment_history` comes back empty.
 *
 *  2. That index rejects `startPublishedDate` outright ("dedicated indices that
 *     only support semantic search"). Date-filtered recency needs a plain
 *     neural search with no category. So the two jobs are two calls, not one.
 *
 * THE IDENTITY GATE IS THE POINT. A semantic search for "Eric Glyman" also
 * returned "Jason Glyman" at score 0. Attributing a stranger's career history to
 * the prospect would be the worst possible failure of this product, so a person
 * result is only accepted when the name actually matches and the score clears a
 * floor — and confidence is reduced when the employer cannot be confirmed.
 */

import { fetchWithDeadline, LEG_TIMEOUT_MS } from "./deadline.js";
import { optionalEnv, requireEnv } from "./env.js";

const EXA_SEARCH_URL = "https://api.exa.ai/search";

export type ExaCost = { usd: number };

export class ExaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly tag?: string
  ) {
    super(message);
    this.name = "ExaError";
  }
}

type RawResult = {
  id?: string;
  url?: string;
  title?: string;
  author?: string;
  publishedDate?: string;
  score?: number;
  text?: string;
  highlights?: string[];
  entities?: {
    id?: string;
    type?: string;
    properties?: Record<string, unknown>;
  }[];
};

type RawResponse = {
  requestId?: string;
  error?: string;
  tag?: string;
  results?: RawResult[];
  costDollars?: { total?: number };
  resolvedSearchType?: string;
};

/** Accumulates Exa spend across a pipeline run, mirroring Fundable's Ledger. */
export type ExaLedger = { usd: number; calls: number; deadlineAt?: number };

export function newExaLedger(deadlineAt?: number): ExaLedger {
  return deadlineAt === undefined ? { usd: 0, calls: 0 } : { usd: 0, calls: 0, deadlineAt };
}

async function search(body: Record<string, unknown>, ledger?: ExaLedger): Promise<RawResponse> {
  const res = await fetchWithDeadline(
    EXA_SEARCH_URL,
    {
      method: "POST",
      headers: { "x-api-key": requireEnv("EXA_API_KEY"), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    },
    { leg: "exa/search", cap: LEG_TIMEOUT_MS.exa, budget: ledger }
  );

  const json = (await res.json().catch(() => ({}))) as RawResponse;

  // Exa reports validation problems as a 200-shaped body with `error` + `tag`,
  // so status alone is not the check.
  if (!res.ok || json.error) {
    throw new ExaError(json.error ?? `Exa ${res.status}`, res.status, json.tag);
  }

  if (ledger) {
    ledger.usd += json.costDollars?.total ?? 0;
    ledger.calls += 1;
  }
  return json;
}

// ---------------------------------------------------------------------------
// Identity matching
// ---------------------------------------------------------------------------

function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Both the given AND family name must appear. "Eric Glyman" vs "Jason Glyman"
 * shares a surname and nothing else, which is exactly the case that must fail.
 */
function nameMatches(queried: string, returned: string): boolean {
  const q = normalizeName(queried).split(" ").filter((t) => t.length > 1);
  const r = new Set(normalizeName(returned).split(" ").filter(Boolean));
  if (q.length < 2) return false;
  return q.every((token) => r.has(token));
}

/** Score floor for accepting a person entity at all. */
const PERSON_SCORE_FLOOR = 0.5;

// ---------------------------------------------------------------------------
// Person lookup (the people index)
// ---------------------------------------------------------------------------

export type WorkHistoryEntry = {
  title: string | null;
  company: string | null;
  from: string | null;
  to: string | null;
};

export type ExaPerson = {
  name: string;
  location: string | null;
  url: string | null;
  workHistory: WorkHistoryEntry[];
  /** True when a workHistory entry names the employer we expected. */
  employerConfirmed: boolean;
  score: number;
};

function parseWorkHistory(properties: Record<string, unknown>): WorkHistoryEntry[] {
  const raw = properties.workHistory;
  if (!Array.isArray(raw)) return [];
  const out: WorkHistoryEntry[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as {
      title?: unknown;
      company?: { name?: unknown };
      dates?: { from?: unknown; to?: unknown };
    };
    out.push({
      title: typeof entry.title === "string" ? entry.title : null,
      company: typeof entry.company?.name === "string" ? entry.company.name : null,
      from: typeof entry.dates?.from === "string" ? entry.dates.from : null,
      to: typeof entry.dates?.to === "string" ? entry.dates.to : null,
    });
  }
  return out;
}

/**
 * Look a person up in Exa's person index.
 *
 * Returns null rather than a best guess whenever identity is not solid — the
 * caller cannot tell a confident wrong answer from a right one, so this
 * function refuses to hand one over.
 */
export async function findPerson(
  input: { name: string; company?: string | undefined },
  ledger?: ExaLedger
): Promise<{ person: ExaPerson | null; warnings: string[] }> {
  const warnings: string[] = [];
  const name = input.name?.trim();
  if (!name || normalizeName(name).split(" ").filter((t) => t.length > 1).length < 2) {
    // A single token cannot be identity-checked, so it is never searched.
    return { person: null, warnings: ["Exa person lookup skipped: need a full name to verify identity."] };
  }

  const query = input.company ? `${name} ${input.company}` : name;
  const res = await search(
    { query, numResults: 3, type: "neural", category: "people" },
    ledger
  );

  for (const result of res.results ?? []) {
    const entity = result.entities?.find((e) => e.type === "person");
    const props = entity?.properties;
    if (!props) continue;

    const returnedName = typeof props.name === "string" ? props.name : result.title ?? "";
    const score = result.score ?? 0;

    if (!nameMatches(name, returnedName)) continue;
    if (score < PERSON_SCORE_FLOOR) {
      warnings.push(
        `Exa matched "${returnedName}" for "${name}" but at score ${score}, below the ${PERSON_SCORE_FLOOR} floor; ignored.`
      );
      continue;
    }

    const workHistory = parseWorkHistory(props);
    const employerConfirmed = input.company
      ? workHistory.some(
          (w) => w.company && normalizeName(w.company).includes(normalizeName(input.company!))
        )
      : false;

    if (input.company && !employerConfirmed) {
      warnings.push(
        `Exa person "${returnedName}" matched by name but no work history entry names ${input.company}; treating career facts as lower confidence.`
      );
    }

    return {
      person: {
        name: returnedName,
        location: typeof props.location === "string" ? props.location : null,
        url: result.url ?? null,
        workHistory,
        employerConfirmed,
        score,
      },
      warnings,
    };
  }

  return { person: null, warnings };
}

// ---------------------------------------------------------------------------
// Recency (plain neural search, date-filtered)
// ---------------------------------------------------------------------------

export type ExaArticle = {
  title: string;
  url: string;
  publishedDate: string | null;
  score: number;
  snippet: string | null;
};

/** Score floor for citing an article. Below this the result is off-topic noise. */
const ARTICLE_SCORE_FLOOR = 0.3;

export async function findRecentNews(
  input: { query: string; sinceDays?: number; limit?: number },
  ledger?: ExaLedger
): Promise<{ articles: ExaArticle[]; warnings: string[] }> {
  const warnings: string[] = [];
  const since = new Date(Date.now() - (input.sinceDays ?? 180) * 86_400_000);

  const res = await search(
    {
      query: input.query,
      numResults: Math.min(Math.max(input.limit ?? 4, 1), 10),
      type: "neural",
      startPublishedDate: since.toISOString(),
      contents: { text: { maxCharacters: 400 } },
    },
    ledger
  );

  const articles: ExaArticle[] = [];
  for (const r of res.results ?? []) {
    if (!r.title || !r.url) continue;
    const score = r.score ?? 0;
    if (score < ARTICLE_SCORE_FLOOR) continue;
    articles.push({
      title: r.title,
      url: r.url,
      publishedDate: r.publishedDate ?? null,
      score,
      snippet: typeof r.text === "string" ? r.text.slice(0, 400) : null,
    });
  }

  if (!articles.length && (res.results ?? []).length) {
    warnings.push("Exa returned only low-relevance articles; none cited.");
  }
  return { articles, warnings };
}

// ---------------------------------------------------------------------------
// Answer (research, not retrieval)
// ---------------------------------------------------------------------------

const EXA_ANSWER_URL = "https://api.exa.ai/answer";

/**
 * Exa's /answer endpoint: a synthesised answer with citations rather than a
 * result list. Used by the email-only ICP path, where all we have is a domain
 * and the question is "what does this company do and who does it sell to".
 *
 * Measured at $0.005 per call — cheaper than a neural search.
 */
export async function answer(
  query: string,
  ledger?: ExaLedger
): Promise<{ text: string; citations: { url: string; title?: string }[] }> {
  const res = await fetchWithDeadline(
    EXA_ANSWER_URL,
    {
      method: "POST",
      headers: { "x-api-key": requireEnv("EXA_API_KEY"), "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      cache: "no-store",
    },
    { leg: "exa/answer", cap: LEG_TIMEOUT_MS.exa, budget: ledger }
  );

  const json = (await res.json().catch(() => ({}))) as {
    answer?: string;
    citations?: { url?: string; title?: string }[];
    error?: string;
    tag?: string;
    costDollars?: { total?: number };
  };

  if (!res.ok || json.error) {
    throw new ExaError(json.error ?? `Exa answer ${res.status}`, res.status, json.tag);
  }

  if (ledger) {
    ledger.usd += json.costDollars?.total ?? 0;
    ledger.calls += 1;
  }

  return {
    text: json.answer ?? "",
    citations: (json.citations ?? [])
      .filter((c): c is { url: string; title?: string } => typeof c.url === "string")
      .map((c) => ({ url: c.url, ...(c.title ? { title: c.title } : {}) })),
  };
}

/** Day-precision date for a citable fact, or null. */
export function articleDate(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

export function exaConfigured(): boolean {
  return !!optionalEnv("EXA_API_KEY");
}
