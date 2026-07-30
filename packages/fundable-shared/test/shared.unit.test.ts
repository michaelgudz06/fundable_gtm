/**
 * Offline unit tests. No network, no keys — these must pass in CI.
 *
 * The cases here are not arbitrary: most of them encode a specific live-probe
 * finding or a specific way this pipeline could ship a wrong claim about a real
 * person. If one of these starts failing, a guard has been removed.
 */

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  checkLength,
  blockingIssues,
  dealDate,
  firstNameOf,
  loadVoice,
  money,
  normalizeDomain,
  normalizeLinkedIn,
  provenanceWarning,
  roundLabel,
  stripEmDashes,
  verifyCopy,
  wordCount,
} from "../src/index.js";
import type { Evidence } from "../src/index.js";

// ---------------------------------------------------------------------------
describe("normalizeDomain", () => {
  test("strips the www. that Fundable silently fails to match", () => {
    // Probed: www.ramp.com returned zero matches in the same call where a bare
    // domain matched, and the miss is indistinguishable from a fake company.
    assert.equal(normalizeDomain("www.ramp.com").domain, "ramp.com");
  });

  test("lowercases, and accepts a full email address", () => {
    assert.equal(normalizeDomain("Eric@RAMP.com").domain, "ramp.com");
    assert.equal(normalizeDomain("ANTHROPIC.COM").domain, "anthropic.com");
  });

  test("accepts a URL and drops scheme, path, port", () => {
    assert.equal(normalizeDomain("https://ramp.com/pricing?x=1").domain, "ramp.com");
    assert.equal(normalizeDomain("ramp.com:443").domain, "ramp.com");
  });

  test("warns rather than guessing when a non-www subdomain survives", () => {
    // Guessing the registrable domain without a public-suffix list breaks
    // foo.co.uk, so the client reports instead of mangling.
    const r = normalizeDomain("mail.corp.example.com");
    assert.equal(r.domain, "mail.corp.example.com");
    assert.match(r.warning ?? "", /subdomain/i);
  });

  test("does not warn on a real multi-label public suffix", () => {
    assert.equal(normalizeDomain("monzo.co.uk").warning, undefined);
  });
});

// ---------------------------------------------------------------------------
describe("normalizeLinkedIn", () => {
  test("rejects blank input — the single most dangerous call in the API", () => {
    // Probed: {"linkedin_urls":[""]} returns the entire 365k-row people dataset
    // and hands back an arbitrary stranger as people[0], billed 1 credit. A
    // blank must never reach the request.
    assert.equal(normalizeLinkedIn(""), null);
    assert.equal(normalizeLinkedIn("   "), null);
    assert.equal(normalizeLinkedIn("not-a-url"), null);
    assert.equal(normalizeLinkedIn("https://twitter.com/eglyman"), null);
  });

  test("collapses every variant the server accepts to one cache key", () => {
    // The server matches on the slug, so all of these are the same person and
    // must be the same cache key — otherwise one person costs five credits.
    const canonical = "https://www.linkedin.com/in/eglyman";
    for (const variant of [
      "https://www.linkedin.com/in/eglyman",
      "https://linkedin.com/in/eglyman",
      "http://www.linkedin.com/in/eglyman",
      "https://www.linkedin.com/in/eglyman/",
      "linkedin.com/in/eglyman",
      "https://www.linkedin.com/in/EGlyman",
      "  https://www.linkedin.com/in/eglyman?originalSubdomain=us  ",
    ]) {
      assert.equal(normalizeLinkedIn(variant), canonical, `variant failed: ${variant}`);
    }
  });
});

// ---------------------------------------------------------------------------
describe("firstNameOf", () => {
  test("derives a greeting name, because the API's first_name is always null", () => {
    assert.equal(firstNameOf("Eric Glyman"), "Eric");
    assert.equal(firstNameOf("  Karim   Atiyeh "), "Karim");
  });

  test("strips honorifics", () => {
    assert.equal(firstNameOf("Dr. Jane Holloway"), "Jane");
  });

  test("returns null rather than guessing", () => {
    // "Hi Ramp," in the first two words is worse than no greeting.
    assert.equal(firstNameOf("Ramp"), null);
    assert.equal(firstNameOf("J. Smith"), null);
    assert.equal(firstNameOf(""), null);
    assert.equal(firstNameOf(null), null);
  });
});

// ---------------------------------------------------------------------------
describe("roundLabel", () => {
  test("reads round_type from /deals and type from an embedded company deal", () => {
    // Same object, two field names, verified across both endpoints.
    assert.equal(roundLabel({ id: "d", round_type: "SERIES_F" }), "series f");
    assert.equal(roundLabel({ type: "SERIES_F" }), "series f");
  });

  test("includes the intermediate flag the PRD omits", () => {
    // Rendering round_type alone prints "series e" for an actual Series E-2.
    assert.equal(roundLabel({ id: "d", round_type: "SERIES_E", intermediate: "TWO" }), "series e-2");
  });

  test("handles pre, extension, and HYBRID_ prefixes", () => {
    assert.equal(roundLabel({ id: "d", round_type: "SEED", pre: true }), "pre-seed");
    assert.equal(roundLabel({ id: "d", round_type: "SEED", extension: true }), "seed ext");
    assert.equal(roundLabel({ id: "d", round_type: "HYBRID_SERIES_A" }), "series a");
  });

  test("degrades to 'undisclosed' rather than throwing on an unfunded company", () => {
    assert.equal(roundLabel(null), "undisclosed");
    assert.equal(roundLabel(undefined), "undisclosed");
    assert.equal(roundLabel({}), "undisclosed");
  });
});

// ---------------------------------------------------------------------------
describe("money and dealDate", () => {
  test("formats whole-dollar values the way Jacob writes them", () => {
    assert.equal(money(750_000_000), "$750M");
    assert.equal(money(3_577_000_000), "$3.6B");
    assert.equal(money(7_000_000), "$7M");
    assert.equal(money(870_000), "$870K");
  });

  test("never renders a fake zero", () => {
    assert.equal(money(null), "undisclosed");
    assert.equal(money(0), "undisclosed");
  });

  test("truncates to day precision, because the API's times are placeholders", () => {
    // Many dates are exactly T12:00:00.000Z — a noon placeholder, not a real time.
    assert.equal(dealDate("2026-06-04T12:00:00.000Z"), "2026-06-04");
    assert.equal(dealDate(null), null);
    assert.equal(dealDate("nonsense"), null);
  });
});

// ---------------------------------------------------------------------------
describe("voice profile", () => {
  test("loads and validates the shipped profile", () => {
    const v = loadVoice("jacob");
    assert.equal(v.id, "jacob");
    assert.ok(v.limits.email.max_words > 0);
    assert.ok(v.limits.linkedin.max_words < v.limits.email.max_words);
  });

  test("surfaces a warning while provenance is a placeholder", () => {
    // Until Jacob's real sent emails land, callers must be told this is inferred.
    const v = loadVoice("jacob");
    assert.equal(v.provenance, "placeholder");
    assert.match(provenanceWarning(v) ?? "", /placeholder/i);
  });

  test("throws a named error for a profile that does not exist", () => {
    assert.throws(() => loadVoice("nobody"), /could not be read/i);
  });

  test("strips em dashes without mangling the sentence", () => {
    assert.equal(stripEmDashes("We track rounds — every one of them."), "We track rounds, every one of them.");
    assert.ok(!stripEmDashes("a — b — c").includes("—"));
  });

  test("checkLength measures against the profile's own limit", () => {
    const v = loadVoice("jacob");
    assert.equal(wordCount("one two three"), 3);
    assert.equal(checkLength("short enough", v, "email").ok, true);

    const tooLong = Array.from({ length: v.limits.email.max_words + 10 }, () => "word").join(" ");
    const check = checkLength(tooLong, v, "email");
    assert.equal(check.ok, false);
    assert.match(check.message ?? "", /over the/);
  });
});

// ---------------------------------------------------------------------------
// The crux. Everything below is about not shipping a false claim about a real
// person, which is the failure mode that decides whether this ships at all.
// ---------------------------------------------------------------------------
describe("verifyCopy", () => {
  const evidence: Evidence[] = [
    {
      fact: "Ramp raised a $750M Series F on 2026-06-04 at a $44B valuation.",
      source: "fundable",
      endpoint: "/companies",
      confidence: 1.0,
    },
    {
      fact: "Ramp is a corporate expense management platform based in New York.",
      source: "fundable",
      endpoint: "/companies",
      confidence: 1.0,
    },
  ];

  const allowedNames = ["Eric Glyman", "Ramp", "Jacob Klionsky", "Fundable"];

  test("passes copy that only states supported facts", () => {
    const copy = [
      "Hi Eric,",
      "",
      "Congrats on the $750M Series F. We track every round in the market, so it came up on our side the day it closed.",
      "",
      "Worth a look at what we have on your investor set?",
      "",
      "Jacob",
    ].join("\n");

    const issues = verifyCopy({ copy, evidence, allowedNames });
    assert.deepEqual(
      blockingIssues(issues),
      [],
      `unexpected blocking issues: ${JSON.stringify(blockingIssues(issues), null, 2)}`
    );
  });

  test("blocks an invented funding figure", () => {
    const copy = "Hi Eric,\n\nCongrats on the $900M Series F.\n\nJacob";
    const blocked = blockingIssues(verifyCopy({ copy, evidence, allowedNames }));
    assert.ok(blocked.some((i) => i.quote.includes("900")), JSON.stringify(blocked));
  });

  test("allows honest rounding of a supported figure", () => {
    // Evidence says $44B; "$44 billion" is the same number, not a new claim.
    const copy = "Hi Eric,\n\nCongrats on the round at $44 billion.\n\nJacob";
    const blocked = blockingIssues(verifyCopy({ copy, evidence, allowedNames }));
    assert.deepEqual(blocked, [], JSON.stringify(blocked));
  });

  test("blocks a date the evidence does not support", () => {
    const copy = "Hi Eric,\n\nCongrats on the $750M Series F back in March 2024.\n\nJacob";
    const blocked = blockingIssues(verifyCopy({ copy, evidence, allowedNames }));
    assert.ok(blocked.some((i) => i.kind === "year" || i.kind === "month"), JSON.stringify(blocked));
  });

  test("blocks claims that imply a relationship we do not have", () => {
    for (const line of [
      "Great speaking last week.",
      "Just circling back on my last note.",
      "As we discussed, the Series F changes things.",
      "Our mutual connection suggested I reach out.",
    ]) {
      const blocked = blockingIssues(
        verifyCopy({ copy: `Hi Eric,\n\n${line}\n\nJacob`, evidence, allowedNames })
      );
      assert.ok(blocked.some((i) => i.kind === "relationship"), `not caught: ${line}`);
    }
  });

  test("blocks an em dash", () => {
    const copy = "Hi Eric,\n\nCongrats on the $750M Series F — a big one.\n\nJacob";
    const blocked = blockingIssues(verifyCopy({ copy, evidence, allowedNames }));
    assert.ok(blocked.some((i) => i.kind === "style" && i.quote === "—"));
  });

  test("blocks phrases the voice profile forbids", () => {
    const v = loadVoice("jacob");
    const copy = "Hi Eric,\n\nI hope this email finds you well.\n\nJacob";
    const blocked = blockingIssues(
      verifyCopy({ copy, evidence, allowedNames, forbiddenPhrases: v.forbidden_phrases })
    );
    assert.ok(blocked.some((i) => i.kind === "style"), JSON.stringify(blocked));
  });

  test("still catches the unsupported comparisons the ported checker was built for", () => {
    const copy = "Hi Eric,\n\nFintech is raising faster than any other sector right now.\n\nJacob";
    const blocked = blockingIssues(verifyCopy({ copy, evidence, allowedNames }));
    assert.ok(blocked.some((i) => i.kind === "comparison"), JSON.stringify(blocked));
  });

  test("does not audit numbers the caller put in their own template", () => {
    // The caller's template is theirs. Auditing it would make every request with
    // a templated figure undeliverable.
    const template = "We work with 40 funds already.";
    const copy = `Hi Eric,\n\nCongrats on the $750M Series F. ${template}\n\nJacob`;
    const blocked = blockingIssues(verifyCopy({ copy, evidence, allowedNames, template }));
    assert.deepEqual(blocked, [], JSON.stringify(blocked));
  });

  test("blocks welding a round to a valuation no single fact priced", () => {
    // The M1 acceptance audit caught this live on stripe.com: round fact and
    // valuation fact both true, their join unsupported.
    const split: Evidence[] = [
      { fact: "Stripe raised an equity round on 2025-02-27.", source: "fundable", confidence: 1 },
      {
        fact: "Stripe's latest disclosed valuation is $91.5B. This is Fundable's latest valuation on record, not the price of the latest financing.",
        source: "fundable",
        confidence: 1,
      },
    ];
    const copy =
      "Hi Patrick,\n\nStripe closed an equity round on 2025-02-27, at a disclosed valuation of $91.5B.\n\nJacob";
    const blocked = blockingIssues(
      verifyCopy({ copy, evidence: split, allowedNames: ["Stripe", "Patrick Collison"] })
    );
    assert.ok(blocked.some((i) => i.kind === "conflation"), JSON.stringify(blocked));

    // Same facts stated as separate sentences: no join, no block.
    const separate =
      "Hi Patrick,\n\nStripe closed an equity round on 2025-02-27. Fundable's latest valuation on record is $91.5B.\n\nJacob";
    const ok = blockingIssues(
      verifyCopy({ copy: separate, evidence: split, allowedNames: ["Stripe", "Patrick Collison"] })
    );
    assert.ok(!ok.some((i) => i.kind === "conflation"), JSON.stringify(ok));
  });

  test("blocks a valuation figure worn as a round size", () => {
    // Second live-caught variant: subject "stripe's $91.5b round" — the reader
    // takes that as money raised; the figure is the valuation.
    const stripeEvidence: Evidence[] = [
      {
        fact: "Stripe raised an equity round at a $91.5B valuation on 2025-02-27.",
        source: "fundable",
        confidence: 1,
      },
    ];
    const blocked = blockingIssues(
      verifyCopy({
        copy: "Hi Patrick,\n\nCongrats on stripe's $91.5B round.\n\nJacob",
        subject: "stripe's $91.5b round",
        evidence: stripeEvidence,
        allowedNames: ["Stripe", "Patrick Collison"],
      })
    );
    assert.ok(blocked.some((i) => i.kind === "conflation"), JSON.stringify(blocked));

    // Noun form misleads identically: "stripe's raise at $91.5b".
    const nounForm = blockingIssues(
      verifyCopy({
        copy: "Hi Patrick,\n\nCongrats on the round.\n\nJacob",
        subject: "stripe's raise at $91.5b",
        evidence: stripeEvidence,
        allowedNames: ["Stripe", "Patrick Collison"],
      })
    );
    assert.ok(nounForm.some((i) => i.kind === "conflation"), JSON.stringify(nounForm));

    // Same figure labeled as what it is: fine (the joint fact states it).
    const labeled = blockingIssues(
      verifyCopy({
        copy: "Hi Patrick,\n\nCongrats on the equity round at a $91.5B valuation.\n\nJacob",
        subject: "your round at a $91.5b valuation",
        evidence: stripeEvidence,
        allowedNames: ["Stripe", "Patrick Collison"],
      })
    );
    assert.deepEqual(labeled, [], JSON.stringify(labeled));

    // And a genuine raise amount in raise position stays allowed.
    const genuine = blockingIssues(
      verifyCopy({
        copy: "Hi Eric,\n\nCongrats on the $750M Series F.\n\nJacob",
        evidence,
        allowedNames,
      })
    );
    assert.ok(!genuine.some((i) => i.kind === "conflation"), JSON.stringify(genuine));
  });

  test("a raise amount adjacent to a valuation phrase is still a raise amount", () => {
    // Caught live on shopify.com: the fact "series c round of $100M at a $1B
    // valuation" had its $100M misclassified as valuation-owned by a blunt
    // proximity window, false-blocking an honest draft. Only the $1B prices.
    const shopifyEvidence: Evidence[] = [
      {
        fact: "Shopify raised a series c round of $100M at a $1B valuation on 2013-12-11.",
        source: "fundable",
        confidence: 1,
      },
    ];
    const honest = blockingIssues(
      verifyCopy({
        copy: "Hi Tobi,\n\nShopify raised $100M in its series c at a $1B valuation on 2013-12-11.\n\nJacob",
        subject: "shopify raised $100m",
        evidence: shopifyEvidence,
        allowedNames: ["Shopify", "Tobi Lutke"],
      })
    );
    assert.deepEqual(honest, [], JSON.stringify(honest));

    // The $1B stays valuation-owned: wearing IT as the raise still blocks.
    const swapped = blockingIssues(
      verifyCopy({
        copy: "Hi Tobi,\n\nCongrats on shopify's $1B round.\n\nJacob",
        evidence: shopifyEvidence,
        allowedNames: ["Shopify", "Tobi Lutke"],
      })
    );
    assert.ok(swapped.some((i) => i.kind === "conflation"), JSON.stringify(swapped));
  });

  test("allows the round-valuation join when a single fact states both", () => {
    // Ramp's own deal prose ties them, so the join is the fact.
    const copy =
      "Hi Eric,\n\nCongrats on the $750M Series F at a $44 billion valuation.\n\nJacob";
    const joint: Evidence[] = [
      ...evidence,
      {
        fact: "Ramp raised $750 million in a Series F at a $44 billion valuation led by ICONIQ.",
        source: "fundable",
        confidence: 1,
      },
    ];
    const blocked = blockingIssues(verifyCopy({ copy, evidence: joint, allowedNames }));
    assert.ok(!blocked.some((i) => i.kind === "conflation"), JSON.stringify(blocked));
  });

  test("flags an unrecognised company name as a warning, not a block", () => {
    // The proper-noun check is heuristic, so it must never downgrade on its own.
    const copy = "Hi Eric,\n\nCongrats on the $750M Series F, led by Sequoia Capital.\n\nJacob";
    const issues = verifyCopy({ copy, evidence, allowedNames });
    assert.ok(issues.some((i) => i.kind === "entity" && /Sequoia/.test(i.quote)), JSON.stringify(issues));
    assert.ok(!blockingIssues(issues).some((i) => i.kind === "entity"));
  });
});
