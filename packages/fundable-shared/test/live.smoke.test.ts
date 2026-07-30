/**
 * Live smoke tests. These spend real Fundable credits and real OpenRouter tokens.
 *
 *   npm run smoke --workspace @fundable/shared
 *
 * Skipped automatically when the keys are absent, so CI without secrets stays
 * green. Budget for a full run: roughly 8 Fundable credits and under $0.01 of
 * tokens.
 *
 * Their job is not coverage. It is to catch the day Fundable renames a field or
 * changes a default, because every one of the assertions below encodes a
 * contract the pipeline silently depends on.
 */

import assert from "node:assert/strict";
import { test, describe, before } from "node:test";

import {
  MODEL_PLAN,
  companiesByDomains,
  companyByDomain,
  complete,
  dealDate,
  dealsForCompany,
  investorsByIds,
  leadInvestorProse,
  loadRootEnv,
  newLedger,
  normalizeLinkedIn,
  personByLinkedIn,
  roundLabel,
} from "../src/index.js";

before(() => loadRootEnv());

const hasFundable = () => !!process.env.FUNDABLE_API_KEY;
const hasOpenRouter = () => !!process.env.OPENROUTER_API_KEY;

// A company chosen because it is heavily funded, so the enrichment path is
// exercised end to end rather than short-circuiting on missing data.
const DOMAIN = "ramp.com";

describe("Fundable — resolve", { skip: hasFundable() ? false : "FUNDABLE_API_KEY not set" }, () => {
  test("resolves an email domain to a company with a dated round", async () => {
    const ledger = newLedger();
    const { company, warnings } = await companyByDomain(`someone@${DOMAIN}`, ledger);

    assert.ok(company, "expected a company for ramp.com");
    assert.equal(company.domain, DOMAIN);
    assert.ok(company.name);
    assert.deepEqual(warnings, [], `unexpected warnings: ${warnings.join("; ")}`);

    // The contract the whole post-raise trigger rests on: a dated, citable fact.
    assert.ok(company.latest_deal, "expected latest_deal on a funded company");
    const date = dealDate(company.latest_deal.date);
    assert.match(date ?? "", /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(roundLabel(company.latest_deal) !== "undisclosed");

    // Field names the PRD got wrong. If these flip, the copy loses its facts
    // silently rather than erroring, so assert them explicitly.
    assert.ok(Array.isArray(company.latest_deal.investors), "latest_deal.investors must be an array");
    assert.equal(
      (company.latest_deal as Record<string, unknown>)["investor_ids"],
      undefined,
      "latest_deal.investor_ids should NOT exist — the real key is `investors`"
    );
    assert.equal(
      typeof company.latest_deal.description,
      "object",
      "latest_deal.description is an object, not a string"
    );
    assert.ok(Array.isArray(company.all_investor_ids), "all_investor_ids drives the overlap tie");

    assert.ok(ledger.credits >= 1, "expected credits to be recorded");
  });

  test("diffs requested against returned so a silent drop becomes a warning", async () => {
    // Unknown domains are dropped with no error and meta.total_count counts
    // matches, not requests, so only a set-difference can surface this.
    const fake = "zzz-not-a-real-company-9931.com";
    const res = await companiesByDomains([DOMAIN, fake]);

    assert.equal(res.truncated, false, "explicit page_size should prevent pagination truncation");
    assert.ok(res.found.has(DOMAIN), "the real domain should resolve");
    assert.deepEqual(res.missing, [fake], "the unknown domain must be reported as missing");
    assert.ok(
      res.warnings.some((w) => w.includes(fake)),
      `expected a warning naming the dropped domain, got: ${res.warnings.join("; ")}`
    );
  });
});

describe("Fundable — enrich", { skip: hasFundable() ? false : "FUNDABLE_API_KEY not set" }, () => {
  test("pulls round history and hydrates the investor set", async () => {
    const ledger = newLedger();
    const { company } = await companyByDomain(DOMAIN, ledger);
    assert.ok(company);

    const { deals, totalCount } = await dealsForCompany(company.id, { limit: 2 }, ledger);
    assert.ok(deals.length >= 1, "expected at least one deal");
    assert.ok(totalCount >= deals.length);

    const latest = deals[0];
    assert.ok(latest);
    // /deals calls this `round_type`; the embedded company deal calls it `type`.
    assert.ok(latest.round_type, "/deals rows use round_type, not type");
    assert.equal(
      (latest as Record<string, unknown>)["type"],
      undefined,
      "/deals should not carry `type` — that is the /companies spelling"
    );
    assert.ok(Array.isArray(latest.investor_ids), "/deals rows use investor_ids");

    // Newest first by default.
    const first = dealDate(latest.date);
    const second = deals[1] ? dealDate(deals[1].date) : null;
    if (first && second) assert.ok(first >= second, "deals should be newest-first");

    // The lead investor exists only as prose. Assert we can find the sentence,
    // and that we are returning a sentence rather than a parsed name.
    const prose = leadInvestorProse(latest);
    if (prose) assert.match(prose, /led by/i);

    const ids = (latest.investor_ids ?? []).slice(0, 2);
    if (ids.length) {
      const investors = await investorsByIds(ids, ledger);
      assert.equal(investors.found.size, ids.length, "every requested investor id should hydrate");
      // Order is not request order, so lookups must go through the Map.
      for (const id of ids) assert.ok(investors.found.get(id)?.name, `no name for investor ${id}`);
    }

    assert.ok(ledger.credits >= 2, `expected several credits, got ${ledger.credits}`);
  });

  test("resolves a LinkedIn URL to a person, and refuses a blank one", async () => {
    const { person } = await personByLinkedIn("linkedin.com/in/eglyman");
    assert.ok(person, "expected a person for the eglyman slug (non-canonical form)");
    assert.equal(normalizeLinkedIn(person.linkedin_url ?? ""), "https://www.linkedin.com/in/eglyman");
    assert.ok(person.name, "name is the only usable name field; first_name is always null");
    assert.ok(person.current_company?.domain || person.current_company?.id, "expected a company join key");

    // The catastrophic case: a blank URL must be rejected client-side, spending
    // nothing, rather than returning an arbitrary stranger from the full dataset.
    const ledger = newLedger();
    const blank = await personByLinkedIn("   ", ledger);
    assert.equal(blank.person, null);
    assert.equal(ledger.calls, 0, "a blank LinkedIn URL must never reach the API");
    assert.equal(ledger.credits, 0);
    assert.ok(blank.warnings.length > 0);
  });
});

describe("OpenRouter", { skip: hasOpenRouter() ? false : "OPENROUTER_API_KEY not set" }, () => {
  test("returns non-null content with reasoning disabled", async () => {
    // The failure this guards: DeepSeek V4 with reasoning enabled spends the
    // whole budget on reasoning and returns content: null.
    const res = await complete(
      [
        { role: "system", content: "Reply with exactly one word." },
        { role: "user", content: "Say the word: verified" },
      ],
      { model: MODEL_PLAN, maxTokens: 20, temperature: 0 }
    );

    assert.ok(res.text.trim().length > 0, "content must not be empty — check reasoning is disabled");
    assert.match(res.text.toLowerCase(), /verified/);
    assert.ok(res.usage.totalTokens > 0, "usage must be reported for the response's usage block");
  });
});
