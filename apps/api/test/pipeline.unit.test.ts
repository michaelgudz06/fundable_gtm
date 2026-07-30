/**
 * Offline tests for the deterministic pipeline stages: request parsing, the
 * fact builder, and confidence scoring. The generative stages are covered by
 * the live acceptance run, not here.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Company, Person } from "@fundable/shared";

import { buildFacts, prospectFacts, recencyFacts, tieFacts } from "../src/lib/pipeline/facts";
import { isInternalIdentity, TRIGGER_POLICY } from "../src/lib/pipeline/triggers";
import { scoreConfidence, TEMPLATE_ONLY_BELOW } from "../src/lib/pipeline/confidence";
import { parseRequest } from "../src/lib/pipeline/types";
import { cacheKey } from "../src/lib/pipeline/resolve";
import { loadSenderContext } from "../src/lib/pipeline/sender";

// Shaped from the live probe of ramp.com, trimmed to the fields the pipeline reads.
const RAMP: Company = {
  id: "f4a7c292-b25e-4fc3-9250-cf602fd82b32",
  name: "Ramp",
  domain: "ramp.com",
  short_description: "Ramp is a corporate expense management platform.",
  num_employees: "1001-5000",
  total_raised: 3_577_000_000,
  latest_valuation_usd: 44_000_000_000,
  // Same day as the deal (probe-verified) — so the valuation priced this round.
  latest_valuation_date: "2026-06-04T15:08:34.000Z",
  location: { city: { name: "New York" } },
  latest_deal: {
    id: "15dad760-5388-45ac-85dd-e663343d1964",
    type: "SERIES_F",
    total_round_raised: 750_000_000,
    date: "2026-06-04T12:00:00.000Z",
    pre: false,
    extension: false,
    intermediate: "NONE",
    investors: ["db0b218d-de39-4b46-940d-d145f644cdb2"],
    description: {
      short_description:
        "Ramp raised $750 million in a Series F at a $44 billion valuation led by ICONIQ, GIC, and Ontario Teachers' Pension Plan.",
    },
  },
};

const GLYMAN: Person = {
  id: "48153d29-5cf9-4973-9289-3dd40bab3f56",
  name: "Eric Glyman",
  linkedin_url: "https://www.linkedin.com/in/eglyman",
  title: "Co-CEO",
  current_company: { id: RAMP.id, name: "Ramp", domain: "ramp.com" },
};

describe("parseRequest", () => {
  test("accepts the PRD example shape and defaults channel + max_facts", () => {
    const r = parseRequest({ person: { email: "eric@ramp.com" }, trigger: "post-raise" });
    assert.ok(r.ok);
    assert.equal(r.req.channel, "email");
    assert.equal(r.req.max_facts, 3);
  });

  test("requires at least one identifier", () => {
    const r = parseRequest({ person: {}, trigger: "post-raise" });
    assert.ok(!r.ok);
    assert.ok(r.errors.some((e) => e.field === "person"));
  });

  test("rejects an unknown trigger and channel", () => {
    const r = parseRequest({ person: { email: "a@b.co" }, trigger: "won-the-lottery", channel: "fax" });
    assert.ok(!r.ok);
    assert.deepEqual(r.errors.map((e) => e.field).sort(), ["channel", "trigger"]);
  });

  test("clamps max_facts into [1,3] instead of rejecting", () => {
    for (const [input, expected] of [
      [99, 3],
      [0, 1],
      [-5, 1],
      [2, 2],
    ] as const) {
      const r = parseRequest({ person: { email: "a@b.co" }, trigger: "cold", max_facts: input });
      assert.ok(r.ok);
      assert.equal(r.req.max_facts, expected, `max_facts ${input}`);
    }
  });
});

describe("buildFacts", () => {
  test("post-raise anchor: a dated round fact from the embedded deal", () => {
    const { facts } = buildFacts({ company: RAMP, person: null, sender: null });
    const raise = facts.find((f) => f.tag === "raise");
    assert.ok(raise, "expected a raise fact");
    assert.match(raise.fact, /Ramp raised a series f round of \$750M at a \$44B valuation on 2026-06-04\./);
    assert.equal(raise.source, "fundable");
  });

  test("valuation folds into the raise fact ONLY when Fundable's dates tie them", () => {
    // Same-day valuation (Ramp): folded, no separate valuation fact to conflate.
    const folded = buildFacts({ company: RAMP, person: null, sender: null }).facts;
    assert.ok(!folded.some((f) => f.tag === "valuation"));

    // Valuation dated later than the round (a secondary, a markup): kept as a
    // separate fact whose wording forbids attaching it to the round.
    const later: Company = { ...RAMP, latest_valuation_date: "2026-07-15T00:00:00.000Z" };
    const separate = buildFacts({ company: later, person: null, sender: null }).facts;
    const raise = separate.find((f) => f.tag === "raise");
    const valuation = separate.find((f) => f.tag === "valuation");
    assert.ok(raise && !/valuation/.test(raise.fact), "raise fact must not carry the valuation");
    assert.ok(valuation, "expected a separate valuation fact");
    assert.match(valuation.fact, /as of 2026-07-15/);
    assert.match(valuation.fact, /not the price of the latest financing/);
  });

  test("warns when Fundable's structured amount contradicts its own deal prose", () => {
    // Seen live: Anthropic's total_round_raised says $50B, its prose says $65B.
    const contradictory: Company = {
      ...RAMP,
      latest_deal: {
        ...RAMP.latest_deal!,
        total_round_raised: 50_000_000_000,
        description: {
          short_description:
            "Anthropic raised $65 billion in a Series H led by Altimeter Capital.",
        },
      },
    };
    const { warnings } = buildFacts({ company: contradictory, person: null, sender: null });
    assert.ok(
      warnings.some((w) => /differs from its own deal description/.test(w)),
      warnings.join("; ")
    );
    // Ramp's prose agrees with its structured amount: no warning.
    const clean = buildFacts({ company: RAMP, person: null, sender: null }).warnings;
    assert.ok(!clean.some((w) => /deal description/.test(w)), clean.join("; "));
  });

  test("quotes the lead-investor prose instead of parsing names from it", () => {
    const { facts } = buildFacts({ company: RAMP, person: null, sender: null });
    const lead = facts.find((f) => f.tag === "lead");
    assert.ok(lead);
    assert.match(lead.fact, /led by ICONIQ, GIC/);
  });

  test("adds momentum, profile, and person facts when available", () => {
    const { facts } = buildFacts({ company: RAMP, person: GLYMAN, sender: null });
    const tags = facts.map((f) => f.tag);
    for (const t of ["momentum", "profile", "person"]) {
      assert.ok(tags.includes(t as never), `missing ${t}`);
    }
    const person = facts.find((f) => f.tag === "person");
    assert.match(person!.fact, /Eric Glyman is Co-CEO at Ramp\./);
    assert.equal(person!.confidence, 0.9);
  });

  test("an unfunded company yields no round fact and no crash", () => {
    const bare: Company = { id: "x", name: "Bootstrapped Co" };
    const { facts } = buildFacts({ company: bare, person: null, sender: null });
    assert.ok(!facts.some((f) => f.tag === "raise"));
  });

  test("sender facts ride along but are excluded from prospect facts", () => {
    const { facts } = buildFacts({
      company: RAMP,
      person: null,
      sender: { id: "default", sender_facts: ["Fundable tracks funding rounds in real time."] },
    });
    assert.ok(facts.some((f) => f.tag === "sender" && f.source === "sender_context"));
    assert.ok(!prospectFacts(facts).some((f) => f.tag === "sender"));
  });
});

describe("scoreConfidence", () => {
  test("company + person + dated fact lands in the full-personalization band", () => {
    const { confidence } = scoreConfidence({ company: RAMP, person: GLYMAN, trigger: "post-raise" });
    assert.ok(confidence >= 0.8, `expected >= 0.8, got ${confidence}`);
  });

  test("company only with a dated fact lands in the company-level band", () => {
    const { confidence } = scoreConfidence({ company: RAMP, person: null, trigger: "post-raise" });
    assert.ok(confidence >= 0.5 && confidence < 0.8, `expected [0.5, 0.8), got ${confidence}`);
  });

  test("person only stays under the template_only gate", () => {
    const { confidence } = scoreConfidence({ company: null, person: GLYMAN, trigger: "post-raise" });
    assert.ok(confidence < TEMPLATE_ONLY_BELOW, `expected < ${TEMPLATE_ONLY_BELOW}, got ${confidence}`);
  });

  test("nothing resolved scores zero", () => {
    assert.equal(scoreConfidence({ company: null, person: null, trigger: "cold" }).confidence, 0);
  });

  test("a stale raise is penalized for the post-raise trigger, with a warning", () => {
    const stale: Company = {
      ...RAMP,
      latest_deal: { ...RAMP.latest_deal!, date: "2020-01-15T12:00:00.000Z", description: {} },
      latest_valuation_usd: null,
    };
    const fresh = scoreConfidence({ company: RAMP, person: null, trigger: "post-raise" });
    const old = scoreConfidence({ company: stale, person: null, trigger: "post-raise" });
    assert.ok(old.confidence < fresh.confidence);
    assert.ok(old.warnings.some((w) => /18 months/.test(w)));
  });
});

describe("cache key", () => {
  test("normalises both halves so spelling variants share one entry", () => {
    assert.equal(
      cacheKey("Eric@RAMP.com", "linkedin.com/in/EGlyman/"),
      "ramp.com|https://www.linkedin.com/in/eglyman"
    );
    assert.equal(cacheKey("eric@ramp.com", undefined), "ramp.com|");
    assert.equal(cacheKey(undefined, "https://www.linkedin.com/in/eglyman"), "|https://www.linkedin.com/in/eglyman");
  });
});

describe("trigger policy", () => {
  test("website-visitor structurally cannot reference the person", () => {
    // An anonymous company-level signal must never name an individual. This is
    // the creepy failure mode, so it is enforced by the allowed-tag list, not
    // by asking the prompt nicely.
    const policy = TRIGGER_POLICY["website-visitor"];
    assert.ok(!policy.allowedTags.includes("person"));
    assert.ok(!policy.allowedTags.includes("recency"));
    assert.ok(policy.allowedTags.includes("profile"));
  });

  test("only post-raise penalizes a stale raise", () => {
    assert.equal(TRIGGER_POLICY["post-raise"].penalizeStaleRaise, true);
    for (const t of ["sign-up", "website-visitor", "cold"] as const) {
      assert.equal(TRIGGER_POLICY[t].penalizeStaleRaise, false, t);
    }
  });

  test("cold weights ties highest, and prefers them as the angle", () => {
    assert.ok(TRIGGER_POLICY.cold.tieBonus > TRIGGER_POLICY["post-raise"].tieBonus);
    assert.equal(TRIGGER_POLICY.cold.preferred[0], "tie");
  });

  test("Exa is only paid for where recency earns its cost", () => {
    assert.equal(TRIGGER_POLICY.cold.useExa, true);
    assert.equal(TRIGGER_POLICY["post-raise"].useExa, true);
    assert.equal(TRIGGER_POLICY["sign-up"].useExa, false);
    assert.equal(TRIGGER_POLICY["website-visitor"].useExa, false);
  });
});

describe("internal identity guard", () => {
  test("catches Fundable's own domains and test aliases", () => {
    for (const email of [
      "jacob@tryfundable.ai",
      "JACOB@TryFundable.AI",
      "someone@mail.tryfundable.ai",
      "anyone@fundable.ai",
      "test+ramp@gmail.com",
      "qa+7@example.com",
    ]) {
      assert.equal(isInternalIdentity(email), true, email);
    }
  });

  test("does not catch real prospects", () => {
    for (const email of ["eric@ramp.com", "someone@stripe.com", undefined]) {
      assert.equal(isInternalIdentity(email), false, String(email));
    }
  });
});

describe("ties → facts", () => {
  test("a tie becomes an ordinary fact so verification treats it alike", () => {
    const facts = tieFacts([
      {
        kind: "shared_investor",
        fact: "Ribbit Capital is an investor in both Ramp and Brex.",
        source: "fundable",
        endpoint: "/investors",
        confidence: 1,
      },
    ]);
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.tag, "tie");
    assert.equal(facts[0]!.source, "fundable");
  });

  test("a tie raises confidence, weighted more on cold than post-raise", () => {
    const tie = {
      kind: "shared_investor" as const,
      fact: "X is an investor in both A and B.",
      source: "fundable" as const,
      confidence: 1,
    };
    const coldBare = scoreConfidence({ company: RAMP, person: null, trigger: "cold" });
    const coldTied = scoreConfidence({ company: RAMP, person: null, trigger: "cold", ties: [tie] });
    assert.ok(coldTied.confidence > coldBare.confidence);
    assert.ok(coldTied.reasons.some((r) => /shared_investor/.test(r)));
  });
});

describe("recency → facts", () => {
  test("undated articles are never cited", () => {
    const facts = recencyFacts(
      [
        { title: "Dated piece", url: "https://example.com/a", publishedDate: "2026-06-04T00:00:00.000Z", score: 1, snippet: null },
        { title: "Undated piece", url: "https://example.com/b", publishedDate: null, score: 1, snippet: null },
      ],
      "Ramp"
    );
    assert.equal(facts.length, 1);
    assert.match(facts[0]!.fact, /^2026-06-04: "Dated piece"/);
    assert.equal(facts[0]!.url, "https://example.com/a");
    assert.equal(facts[0]!.source, "exa");
  });
});

describe("sender context", () => {
  test("loads the default block", () => {
    const { sender, warnings } = loadSenderContext(undefined);
    assert.ok(sender, warnings.join("; "));
    assert.equal(sender.id, "default");
    assert.ok(sender.sender_facts.length >= 1);
  });

  test("unknown name is a warning, not an error", () => {
    const { sender, warnings } = loadSenderContext("does_not_exist");
    assert.equal(sender, null);
    assert.ok(warnings.some((w) => /not found/.test(w)));
  });
});
