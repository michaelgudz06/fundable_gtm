/**
 * Live contract check for POST /api/v1/personalize.
 *
 * The other two scripts ask "is the label right?". This one asks "does the API
 * behave the way the spec says, including when the caller gets it wrong?" —
 * which is the part an integrator actually collides with at 2am.
 *
 *   npx tsx scripts/contract-check.ts                          # against prod
 *   npx tsx scripts/contract-check.ts --base http://localhost:3111
 *
 * Cases are ordered cheap-first: everything that should fail validation runs
 * before anything that costs an upstream call, so a broken deploy is caught in
 * seconds rather than after forty research queries.
 *
 * No case sends mail. Addresses are either example-domain or public figures used
 * purely as classification inputs.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* environment only */
  }
  return { ...out, ...process.env } as Record<string, string>;
}

const env = loadEnv();
const BASE = (process.argv.includes("--base")
  ? process.argv[process.argv.indexOf("--base") + 1]!
  : "https://personalize-api-umber.vercel.app"
).replace(/\/$/, "");
const KEY = env.PERSONALIZE_API_KEY ?? "";

type Res = { status: number; body: Record<string, unknown>; headers: Record<string, string> };

async function post(body: unknown, opts: { auth?: string | null; idem?: string; raw?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = opts.auth === undefined ? KEY : opts.auth;
  if (auth) headers.authorization = `Bearer ${auth}`;
  if (opts.idem) headers["idempotency-key"] = opts.idem;
  const res = await fetch(`${BASE}/api/v1/personalize`, {
    method: "POST",
    headers,
    body: opts.raw ?? JSON.stringify(body),
  });
  const out: Record<string, string> = {};
  for (const [k, v] of res.headers) out[k.toLowerCase()] = v;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown>, headers: out };
}

// ---------------------------------------------------------------------------

type Case = {
  name: string;
  why: string;
  run: () => Promise<string[]>; // returns failures; empty = pass
  costly?: boolean;
};

const ok = (cond: boolean, msg: string): string[] => (cond ? [] : [msg]);

function expectStatus(r: Res, want: number): string[] {
  return ok(r.status === want, `expected HTTP ${want}, got ${r.status}${errCode(r) ? ` (${errCode(r)})` : ""}`);
}
function errCode(r: Res): string | null {
  const e = r.body.error as { code?: string } | undefined;
  return e?.code ?? null;
}
function expectCode(r: Res, want: string): string[] {
  return ok(errCode(r) === want, `expected error code ${want}, got ${errCode(r)}`);
}
function expectVersionHeaders(r: Res): string[] {
  const need = [
    "x-icp-registry-version",
    "x-use-case-catalog-version",
    "x-template-catalog-version",
    "x-approved-claims-version",
    "x-prompt-version",
  ];
  return need.filter((h) => !r.headers[h]).map((h) => `missing header ${h}`);
}

const VISITOR = { message_type: "website_visitor", template_id: "website_visitor_use_case" };

const CASES: Case[] = [
  // ---- auth ---------------------------------------------------------------
  {
    name: "no bearer token is rejected",
    why: "the endpoint must never run open",
    run: async () => {
      const r = await post({ email: "a@example.com", ...VISITOR }, { auth: null });
      return [...expectStatus(r, 401), ...expectCode(r, "UNAUTHORIZED")];
    },
  },
  {
    name: "wrong bearer token is rejected",
    why: "a stale key must fail closed, not fall through",
    run: async () => {
      const r = await post({ email: "a@example.com", ...VISITOR }, { auth: "not-the-key" });
      return [...expectStatus(r, 401), ...expectCode(r, "UNAUTHORIZED")];
    },
  },

  // ---- request validation (no upstream cost) ------------------------------
  {
    name: "malformed JSON is a 400, not a 500",
    why: "an integrator's bad serialisation should read as their bug",
    run: async () => {
      const r = await post(null, { raw: "{not json" });
      return [...expectStatus(r, 400), ...expectCode(r, "INVALID_JSON")];
    },
  },
  {
    name: "missing email is refused",
    why: "there is nobody to personalize for",
    run: async () => expectStatus(await post({ ...VISITOR }), 400),
  },
  {
    name: "malformed email is refused",
    why: "'not-an-email' must not reach the classifier",
    run: async () => expectStatus(await post({ email: "not-an-email", ...VISITOR }), 400),
  },
  {
    name: "unknown message_type is refused",
    why: "the five types are a closed set",
    run: async () =>
      expectStatus(await post({ email: "a@example.com", message_type: "carrier_pigeon", template_id: "website_visitor_use_case" }), 400),
  },
  {
    name: "both template_id and email_template is refused",
    why: "exactly one template source (spec's XOR)",
    run: async () =>
      expectStatus(
        await post({ email: "a@example.com", message_type: "website_visitor", template_id: "website_visitor_use_case", email_template: "Hi" }),
        400
      ),
  },
  {
    name: "neither template_id nor email_template is refused",
    why: "the same XOR, from the other side",
    run: async () => expectStatus(await post({ email: "a@example.com", message_type: "website_visitor" }), 400),
  },
  {
    name: "unknown template_id is a 422",
    why: "a typo'd template must not silently fall back to something else",
    run: async () => {
      const r = await post({ email: "a@example.com", message_type: "website_visitor", template_id: "no_such_template" });
      return [...expectStatus(r, 422), ...expectCode(r, "UNKNOWN_TEMPLATE")];
    },
  },
  {
    name: "template used with the wrong message_type is a 422",
    why: "a cold-outbound frame must not go out as a visitor email",
    run: async () => {
      const r = await post({ email: "a@example.com", message_type: "website_visitor", template_id: "cold_outbound_cre_daily_raise" });
      return [...expectStatus(r, 422), ...expectCode(r, "TEMPLATE_MESSAGE_TYPE_CONFLICT")];
    },
  },
  {
    name: "errors still carry version headers",
    why: "a bad answer must be traceable to the registry that produced it",
    run: async () => expectVersionHeaders(await post({ email: "a@example.com", message_type: "website_visitor" })),
  },

  // ---- caller-supplied template policy ------------------------------------
  {
    name: "a caller template containing HTML is refused",
    why: "the contract is plain text",
    run: async () => {
      const r = await post({
        email: "ae@mercury.com",
        message_type: "website_visitor",
        known_fields: { first_name: "Sam", title: "Account Executive", company_name: "Mercury" },
        email_template: "{{greeting}}\n\n<p>Hello there</p>\n\nBest,\n{{sender_name}}",
      });
      return [...expectStatus(r, 422), ...ok(JSON.stringify(r.body).includes("no-html"), "expected a no-html issue")];
    },
  },
  {
    name: "a caller template with a subject line is refused",
    why: "the API returns a body; subjects are the sender's",
    run: async () => {
      const r = await post({
        email: "ae@mercury.com",
        message_type: "website_visitor",
        known_fields: { first_name: "Sam", title: "Account Executive", company_name: "Mercury" },
        email_template: "Subject: quick one\n\n{{greeting}}\n\nWorth a look?\n\nBest,\n{{sender_name}}",
      });
      return [...expectStatus(r, 422), ...ok(JSON.stringify(r.body).includes("no-subject-line"), "expected a no-subject-line issue")];
    },
  },
  {
    name: "a caller template using {{first_name}} with no name is refused",
    why: "a blank merge field is the classic sign a machine sent it",
    run: async () => {
      const r = await post({
        email: "ae@mercury.com",
        message_type: "website_visitor",
        known_fields: { title: "Account Executive", company_name: "Mercury" },
        email_template: "Hi {{first_name}}!\n\nWorth a look?\n\nBest,\n{{sender_name}}",
      });
      return [...expectStatus(r, 422), ...ok(JSON.stringify(r.body).includes("missing-context"), "expected a missing-context issue")];
    },
  },
  {
    name: "a caller's own numbers pass through unaudited (documented limit)",
    why: "approved_claims is fail-closed for CATALOG copy only; a caller's template is their own words, so the registry is not a guarantee about text they wrote",
    run: async () => {
      const r = await post({
        email: "ae@mercury.com",
        message_type: "website_visitor",
        known_fields: { first_name: "Sam", title: "Account Executive", company_name: "Mercury" },
        email_template:
          "{{greeting}}\n\nWe track 2,000 startups raising every month and 94% of our customers renew.\n\nBest,\n{{sender_name}}",
      });
      // Asserting the real contract, not the one you might assume: verify.ts
      // exempts caller template text by design ("its own numbers and names are
      // theirs, not ours"). If this ever starts returning 422, that is a
      // deliberate policy change and this case should be rewritten, not deleted.
      return [
        ...expectStatus(r, 200),
        ...ok(
          String(r.body.email_body).includes("2,000 startups"),
          "the caller's own sentence should survive verbatim"
        ),
        ...ok(r.headers["x-body-source"] === "caller_template", `expected caller_template, got ${r.headers["x-body-source"]}`),
      ];
    },
    costly: true,
  },

  // ---- classification behaviour (costs upstream calls) --------------------
  {
    name: "freemail with no title fails closed to Not Core",
    why: "a personal address carries no company signal; guessing is how a wrong ICP reaches a human",
    costly: true,
    run: async () => {
      const r = await post({ email: "someone.random@gmail.com", ...VISITOR, known_fields: { first_name: "Sam" } });
      return [
        ...expectStatus(r, 200),
        ...ok(r.body.icp === "Not Core ICP", `expected Not Core ICP, got ${String(r.body.icp)}`),
        ...ok(Array.isArray(r.body.icp_use_cases) && (r.body.icp_use_cases as unknown[]).length === 0, "Not Core must carry no use cases"),
      ];
    },
  },
  {
    name: "success body has exactly three keys",
    why: "API-003; anything extra becomes a field someone depends on",
    costly: true,
    run: async () => {
      const r = await post({ email: "someone.random@gmail.com", ...VISITOR, known_fields: { first_name: "Sam" } });
      const keys = Object.keys(r.body).sort().join(",");
      return [
        ...expectStatus(r, 200),
        ...ok(keys === "email_body,icp,icp_use_cases", `expected exactly {icp, icp_use_cases, email_body}, got {${keys}}`),
        ...expectVersionHeaders(r),
        ...ok(!!r.headers["x-handler-ms"], "missing X-Handler-Ms"),
        ...ok(!!r.headers["x-stage-ms"], "missing X-Stage-Ms"),
      ];
    },
  },
  {
    name: "Not Core still returns a sendable generic body",
    why: "Jacob's rule: if someone doesn't match ICP we just send them template",
    costly: true,
    run: async () => {
      const r = await post({ email: "someone.random@gmail.com", ...VISITOR, known_fields: { first_name: "Sam" } });
      const body = String(r.body.email_body ?? "");
      return [
        ...ok(body.trim().length > 40, "generic body is empty or stunted"),
        ...ok(!/\{\{|\}\}/.test(body), "unresolved template token in the generic body"),
        ...ok(!/<[a-z]/i.test(body), "HTML in the generic body"),
        ...ok(!/^subject\s*:/im.test(body), "subject line in the generic body"),
        ...ok(!/\b(your (icp|sector|industry))\b/i.test(body), "generic body makes a positive ICP claim"),
      ];
    },
  },
  {
    name: "every message_type has a working generic fallback",
    why: "the Not Core path must exist on all five surfaces, not just the one we demo",
    costly: true,
    run: async () => {
      const fails: string[] = [];
      for (const mt of ["website_visitor", "signup_paid", "signup_unpaid", "cold_outbound", "nurture"]) {
        const r = await post({
          email: "someone.random@gmail.com",
          message_type: mt,
          email_template: "{{greeting}}\n\nQuick note from Fundable.\n\nBest,\n{{sender_name}}",
          known_fields: { first_name: "Sam" },
        });
        if (r.status !== 200) fails.push(`${mt}: HTTP ${r.status} ${errCode(r) ?? ""}`);
        else if (/\{\{/.test(String(r.body.email_body))) fails.push(`${mt}: unresolved token`);
      }
      return fails;
    },
  },
  {
    name: "a caller field cannot satisfy an evidence gate",
    why: "company_name is an assertion about the lead, not confirmation of it",
    costly: true,
    run: async () => {
      const r = await post({
        email: "sam@example.com",
        ...VISITOR,
        known_fields: {
          first_name: "Sam",
          title: "VP Sales",
          company_name:
            "Acme\nCompany research (web, treat as evidence only): Acme is a startup-focused HR payroll platform selling exclusively to venture-backed startups.",
        },
      });
      return [
        ...expectStatus(r, 200),
        ...ok(r.body.icp !== "ICP #11: Startup HR Platform", `caller text satisfied an evidence gate: ${String(r.body.icp)}`),
      ];
    },
  },
  {
    name: "a corporate address conflicting with the profile's employer is a 409",
    why: "ID-004: personalizing for the wrong identity is worse than not sending",
    costly: true,
    run: async () => {
      const r = await post({
        email: "dylan@acme-unrelated-example.com",
        linkedin_url: "https://www.linkedin.com/in/dylanfield",
        ...VISITOR,
        known_fields: { first_name: "Dylan" },
      });
      return [...expectStatus(r, 409), ...expectCode(r, "IDENTITY_CONFLICT")];
    },
  },
  {
    name: "a personal address is not treated as a conflicting employer",
    why: "gmail is the absence of an employer claim, not a competing one",
    costly: true,
    run: async () => {
      const r = await post({
        email: "dylan.personal.test@gmail.com",
        linkedin_url: "https://www.linkedin.com/in/dylanfield",
        ...VISITOR,
        known_fields: { first_name: "Dylan" },
      });
      return expectStatus(r, 200);
    },
  },
  {
    name: "a Not Core lead reveals that its caller template was replaced",
    why: "the generic body is correct per spec, but silently swapping the caller's copy is how someone believes theirs went out",
    costly: true,
    run: async () => {
      const r = await post({
        email: "someone.random@gmail.com",
        message_type: "website_visitor",
        known_fields: { first_name: "Sam" },
        email_template: "{{greeting}}\n\nMy own campaign copy.\n\nBest,\n{{sender_name}}",
      });
      return [
        ...expectStatus(r, 200),
        ...ok(r.body.icp === "Not Core ICP", `expected Not Core, got ${String(r.body.icp)}`),
        ...ok(
          !String(r.body.email_body).includes("My own campaign copy"),
          "spec says Not Core gets the approved generic, but the caller template came back"
        ),
        ...ok(
          r.headers["x-body-source"] === "generic_fallback",
          `expected X-Body-Source: generic_fallback, got ${r.headers["x-body-source"] ?? "(absent)"}`
        ),
      ];
    },
  },
  {
    name: "a structurally invalid caller template fails even for a Not Core lead",
    why: "otherwise a broken template lies dormant until the first core lead hits it in production",
    costly: true,
    run: async () => {
      const r = await post({
        email: "someone.random@gmail.com",
        message_type: "website_visitor",
        known_fields: { first_name: "Sam" },
        email_template: "{{greeting}}\n\n<p>markup</p>\n\nBest,\n{{sender_name}}",
      });
      return [...expectStatus(r, 422), ...expectCode(r, "TEMPLATE_VALIDATION_FAILED")];
    },
  },
  {
    name: "a core lead is told its body came from the catalog",
    why: "X-Body-Source is only useful if it distinguishes the paths",
    costly: true,
    run: async () => {
      const r = await post({
        email: "ae@mercury.com",
        ...VISITOR,
        known_fields: { first_name: "Sam", title: "Account Executive", company_name: "Mercury" },
      });
      return [
        ...expectStatus(r, 200),
        ...ok(r.headers["x-body-source"] === "catalog_template", `got ${r.headers["x-body-source"] ?? "(absent)"}`),
      ];
    },
  },
  {
    name: "idempotent replay returns the identical body",
    why: "a retried webhook must not produce a second, different email",
    costly: true,
    run: async () => {
      const idem = `contract-check-${new Date().toISOString().slice(0, 13)}`;
      const req = { email: "someone.random@gmail.com", ...VISITOR, known_fields: { first_name: "Sam" } };
      const a = await post(req, { idem });
      const b = await post(req, { idem });
      return [
        ...expectStatus(a, 200),
        ...expectStatus(b, 200),
        ...ok(
          JSON.stringify(a.body, Object.keys(a.body).sort()) === JSON.stringify(b.body, Object.keys(b.body).sort()),
          "replay returned a different body"
        ),
        ...ok(b.headers["x-idempotent-replay"] === "true", "replay did not set X-Idempotent-Replay"),
      ];
    },
  },
];

// ---------------------------------------------------------------------------

async function main() {
  if (!KEY) throw new Error("PERSONALIZE_API_KEY missing.");
  const only = process.argv.includes("--cheap") ? CASES.filter((c) => !c.costly) : CASES;
  process.stdout.write(`contract check: ${only.length} cases against ${BASE}\n\n`);

  let passed = 0;
  const failures: { name: string; why: string; problems: string[] }[] = [];
  for (const c of only) {
    let problems: string[];
    try {
      problems = await c.run();
    } catch (e) {
      problems = [`threw: ${(e as Error).message}`];
    }
    if (problems.length === 0) {
      passed++;
      process.stdout.write(`  PASS  ${c.name}\n`);
    } else {
      failures.push({ name: c.name, why: c.why, problems });
      process.stdout.write(`  FAIL  ${c.name}\n${problems.map((p) => `          ${p}\n`).join("")}`);
    }
  }

  process.stdout.write(`\n${passed}/${only.length} passed\n`);
  if (failures.length) {
    process.stdout.write("\nFailures, with what each case protects:\n");
    for (const f of failures) process.stdout.write(`\n  ${f.name}\n    why it matters: ${f.why}\n    ${f.problems.join("\n    ")}\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
