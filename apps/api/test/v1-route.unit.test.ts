/**
 * Offline tests for the /api/v1/personalize HTTP gates: auth and request
 * validation (API-002). Every case here returns before any upstream call, so
 * no network, no spend. The decision pipeline behind the gates is covered by
 * the live suites (scripts/contract-check.ts) and the compose/classify
 * fixtures in v2.unit.test.ts.
 */

import assert from "node:assert/strict";
import { before, beforeEach, describe, test } from "node:test";

import { loadRootEnv } from "@fundable/shared";

import { POST } from "../src/app/api/v1/personalize/route";

const KEY = "test-key-for-route-gates";

function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return POST(
    new Request("http://localhost/api/v1/personalize", {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    })
  );
}

async function errorCode(res: Response): Promise<string> {
  const j = (await res.json()) as { error: { code: string } };
  return j.error.code;
}

/** Both names are mandatory as of 2026-08-16, so every case that means to
 *  prove a LATER gate has to clear this one first. */
const NAMES = { first_name: "Sam", last_name: "Rivera" };

describe("v1/personalize HTTP gates (offline)", () => {
  before(() => loadRootEnv());

  beforeEach(() => {
    process.env.PERSONALIZE_API_KEY = KEY;
  });

  test("fails closed with 503 when no API key is configured", async () => {
    delete process.env.PERSONALIZE_API_KEY;
    const res = await post({ email: "a@b.co" });
    assert.equal(res.status, 503);
    assert.equal(await errorCode(res), "NOT_CONFIGURED");
  });

  test("401 on a wrong bearer token, with version headers even on errors", async () => {
    const res = await POST(
      new Request("http://localhost/api/v1/personalize", {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
        body: "{}",
      })
    );
    assert.equal(res.status, 401);
    assert.equal(await errorCode(res), "UNAUTHORIZED");
    assert.ok(res.headers.get("X-Icp-Registry-Version"), "errors still pin the registry version");
    assert.equal(res.headers.get("X-Body-Source"), "none");
  });

  test("PERSONALIZE_API_KEY is comma-separated: every listed key authenticates", async () => {
    process.env.PERSONALIZE_API_KEY = `other-key-1, ${KEY} ,other-key-2`;
    // The configured KEY still works (post() sends it)...
    const ok = await post("{not json");
    assert.equal(ok.status, 400, "authenticated: failed on JSON, not auth");
    // ...and so does a sibling key from the same list.
    const sibling = await POST(
      new Request("http://localhost/api/v1/personalize", {
        method: "POST",
        headers: { Authorization: "Bearer other-key-2" },
        body: "{not json",
      })
    );
    assert.equal(sibling.status, 400);
    // A key on no list is still a 401.
    const bad = await POST(
      new Request("http://localhost/api/v1/personalize", {
        method: "POST",
        headers: { Authorization: "Bearer other-key-3" },
        body: "{}",
      })
    );
    assert.equal(bad.status, 401);
  });

  test("400 INVALID_JSON on an unparseable body", async () => {
    const res = await post("{not json");
    assert.equal(res.status, 400);
    assert.equal(await errorCode(res), "INVALID_JSON");
  });

  test("400 on a missing or implausible email", async () => {
    for (const email of [undefined, "", "not-an-email", "a@b"]) {
      const res = await post({ email, message_type: "cold_outbound", template_id: "x" });
      assert.equal(res.status, 400, String(email));
      assert.equal(await errorCode(res), "INVALID_REQUEST", String(email));
    }
  });

  test("400 on an unknown message_type", async () => {
    const res = await post({ email: "a@b.co", message_type: "carrier_pigeon", template_id: "x" });
    assert.equal(res.status, 400);
    assert.equal(await errorCode(res), "INVALID_REQUEST");
  });

  test("the exactly-one rule: both or neither template inputs is a 400", async () => {
    const neither = await post({ email: "a@b.co", message_type: "cold_outbound" });
    assert.equal(neither.status, 400);
    const both = await post({
      email: "a@b.co",
      message_type: "cold_outbound",
      template_id: "website_visitor_use_case",
      email_template: "Hi {{greeting}}",
    });
    assert.equal(both.status, 400);
  });

  test("422 UNKNOWN_TEMPLATE for an id not in the catalog", async () => {
    const res = await post({
      email: "a@b.co",
      message_type: "cold_outbound",
      template_id: "no_such_template",
      known_fields: NAMES,
    });
    assert.equal(res.status, 422);
    assert.equal(await errorCode(res), "UNKNOWN_TEMPLATE");
  });

  test("422 TEMPLATE_MESSAGE_TYPE_CONFLICT when the template forbids the type", async () => {
    // website_visitor_use_case does not allow cold_outbound.
    const res = await post({
      email: "a@b.co",
      message_type: "cold_outbound",
      template_id: "website_visitor_use_case",
      known_fields: NAMES,
    });
    assert.equal(res.status, 422);
    assert.equal(await errorCode(res), "TEMPLATE_MESSAGE_TYPE_CONFLICT");
  });

  test("422 on a structurally invalid raw email_template (HTML)", async () => {
    const res = await post({
      email: "a@b.co",
      message_type: "cold_outbound",
      email_template: "<p>Hey {{greeting}}</p>",
      known_fields: NAMES,
    });
    assert.equal(res.status, 422);
    assert.equal(await errorCode(res), "TEMPLATE_VALIDATION_FAILED");
  });

  // ---- stop_at (Jacob's ask #7) --------------------------------------------
  // Every case below returns before any upstream call, so the run modes cost
  // nothing to test. That the SHORT modes return the right key set is asserted
  // live, in scripts/contract-check.ts — it needs a real classification.
  test("400 on an unknown stop_at, naming the three modes", async () => {
    const res = await post({ email: "a@b.co", known_fields: NAMES, stop_at: "everything" });
    assert.equal(res.status, 400);
    assert.equal(await errorCode(res), "INVALID_REQUEST");
    const j = (await (await post({ email: "a@b.co", known_fields: NAMES, stop_at: "" })).json()) as {
      error: { message: string };
    };
    assert.match(j.error.message, /linkedin, icp, email/);
  });

  test("the short modes reject copy instructions instead of silently dropping them", async () => {
    // The quiet failure this prevents: accepting a template, returning no
    // email_body, and leaving the caller to believe their copy was rendered.
    for (const [stop_at, extra] of [
      ["linkedin", { template_id: "website_visitor_use_case" }],
      ["icp", { email_template: "Hi {{first_name}}," }],
    ] as const) {
      const res = await post({ email: "a@b.co", known_fields: NAMES, stop_at, ...extra });
      assert.equal(res.status, 400, stop_at);
      assert.equal(await errorCode(res), "INVALID_REQUEST", stop_at);
    }
  });

  test("a message_type that IS sent is still validated in the short modes", async () => {
    const res = await post({ email: "a@b.co", known_fields: NAMES, stop_at: "linkedin", message_type: "carrier_pigeon" });
    assert.equal(res.status, 400);
    assert.equal(await errorCode(res), "INVALID_REQUEST");
  });

  test("omitting stop_at leaves the six-key contract's gates exactly as they were", async () => {
    // Regression guard on backwards compatibility: the template pair is still
    // mandatory, and still exactly-one, for every caller predating stop_at.
    for (const body of [
      { email: "a@b.co", known_fields: NAMES, message_type: "cold_outbound" },
      {
        email: "a@b.co",
        known_fields: NAMES,
        message_type: "cold_outbound",
        template_id: "website_visitor_use_case",
        email_template: "Hi {{first_name}},",
      },
    ]) {
      const res = await post(body);
      assert.equal(res.status, 400);
      assert.equal(await errorCode(res), "INVALID_REQUEST");
    }
  });
});
