/**
 * Offline fixtures for the v2 spec (SPEC-v2 §6). Every deterministic gate the
 * spec names gets a test here; the model-judgment fixtures run live instead.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  MESSAGE_TYPES,
  REGISTRY_VERSIONS,
  getTemplate,
  genericFallback,
  icpByNumber,
  icpEntries,
  icpLabel,
  useCasesFor,
} from "../src/lib/v2/registry";
import { buildClassifierPrompt } from "../src/lib/v2/classify";
import { composeFromTemplate, composeNotCore, validateEmailBody } from "../src/lib/v2/compose";

describe("icp registry (v2)", () => {
  test("preserves numbering with no #3, includes #19 Investor and the #20 catch-all", () => {
    const nums = icpEntries().map((i) => i.number);
    assert.ok(!nums.includes(3), "there is intentionally no ICP #3");
    assert.ok(nums.includes(19), "#19 Investor is core in v2");
    const catchAll = icpEntries().find((i) => i.catch_all);
    assert.equal(catchAll?.number, 20);
    assert.equal(nums.length, 19, "19 core labels");
  });

  test("labels render canonically", () => {
    assert.equal(icpLabel(2), "ICP #2: CRE Broker");
    assert.equal(icpLabel(19), "ICP #19: Investor");
    assert.equal(icpLabel(null), "Not Core ICP");
    assert.equal(icpLabel(3 as never), "Not Core ICP");
  });

  test("every core ICP has 1-3 use cases with all four fields; Not Core has none", () => {
    for (const e of icpEntries()) {
      const ucs = useCasesFor(e.number);
      assert.ok(ucs.length >= 1 && ucs.length <= 3, `#${e.number}`);
      for (const u of ucs) {
        assert.ok(u.id && u.name && u.why_relevant && u.example_alert, `#${e.number}/${u.id}`);
      }
    }
    assert.deepEqual(useCasesFor(null), []);
  });

  test("the classifier prompt is built from the registry, not hardcoded", () => {
    const p = buildClassifierPrompt();
    for (const e of icpEntries()) {
      assert.ok(p.includes(`#${e.number} ${e.name}`), `prompt missing #${e.number}`);
    }
    assert.ok(p.includes("catch-all") || p.includes("CATCH-ALL"));
    assert.ok(/never infer/i.test(p), "customer-evidence gate must be stated");
  });

  test("versions exist for all four registries", () => {
    for (const v of Object.values(REGISTRY_VERSIONS)) assert.match(v, /^\d+\.\d+\.\d+$/);
  });
});

describe("template catalog (v2)", () => {
  test("all nine seed templates resolve and declare allowed message types", () => {
    for (const id of [
      "signup_paid_initial",
      "signup_unpaid_initial",
      "website_visitor_use_case",
      "followup_alerts_paid",
      "followup_alerts_unpaid",
      "followup_api",
      "followup_mcp",
      "followup_use_case_question",
      "cold_outbound_cre_daily_raise",
    ]) {
      const t = getTemplate(id);
      assert.ok(t, id);
      assert.ok(t.allowed_message_types.length >= 1, id);
    }
  });

  test("every message type has a Not Core generic fallback that validates", () => {
    for (const mt of MESSAGE_TYPES) {
      const { body, issues } = composeNotCore({ messageType: mt, ctx: { sender_name: "Jacob" } });
      assert.deepEqual(issues, [], `${mt}: ${JSON.stringify(issues)}`);
      assert.ok(!/\{\{/.test(body), mt);
    }
  });
});

describe("composition fixtures (spec §6)", () => {
  const cre = getTemplate("cold_outbound_cre_daily_raise")!;
  const useCases = useCasesFor(2);

  test("CRE template preserves Bay Area and COO context (canonical fixture)", () => {
    const { body, issues } = composeFromTemplate({
      template: cre,
      useCases,
      ctx: { first_name: "Reed", territory: "Bay Area", target_buyer_role: "COO", sender_name: "Jacob" },
    });
    assert.deepEqual(issues, [], JSON.stringify(issues));
    assert.match(body, /^Hey Reed,/);
    assert.match(body, /Bay Area startups that raised in the past 24 hours/);
    assert.match(body, /verified COO contact info/);
    assert.match(body, /Best,\nJacob$/);
  });

  test("missing context falls back grammatically, never a raw token", () => {
    const { body, issues } = composeFromTemplate({ template: cre, useCases, ctx: {} });
    assert.deepEqual(issues, [], JSON.stringify(issues));
    assert.match(body, /^Hi there,/, "greeting fallback when first name unavailable");
    assert.ok(!/\{\{|\}\}/.test(body), "no unresolved tokens");
    assert.match(body, /the startups that raised/, "territory clause degrades to 'the'");
    assert.match(body, /verified buyer contact info/, "buyer-role clause degrades generically");
  });

  test("validator catches the failure classes the spec names", () => {
    assert.ok(validateEmailBody("Hey {{first_name}},\n\nHi.").some((i) => i.rule === "unresolved-variable"));
    assert.ok(validateEmailBody("Hey ,\n\nHi.").some((i) => i.rule === "empty-greeting"));
    assert.ok(validateEmailBody("<p>Hey</p>").some((i) => i.rule === "no-html"));
    assert.ok(validateEmailBody("Subject: hello\n\nHey Reed,").some((i) => i.rule === "no-subject-line"));
    assert.ok(validateEmailBody("   ").some((i) => i.rule === "empty-body"));
    assert.deepEqual(validateEmailBody("Hey Reed,\n\nAll good here.\n\nBest,\nJacob"), []);
  });

  test("Not Core makes no positive ICP claim and no personalization pretence", () => {
    const { body } = composeNotCore({ messageType: "cold_outbound", ctx: { sender_name: "Jacob" } });
    assert.ok(!/your (icp|sector|industry|team's)/i.test(body));
    assert.match(body, /^Hi there,/);
  });
});

describe("registry gates that must hold at build time", () => {
  test("templates may only reference approved claims (fail-closed already ran at import)", () => {
    // If a template referenced a pending_review claim, the registry module
    // would have thrown on import and every test above would have failed.
    // This test exists to document the mechanism.
    assert.ok(icpByNumber(2));
  });
});
