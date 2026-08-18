/**
 * /guide — how to use the API.
 *
 * Audience is whoever is evaluating or wiring this up. It reads the real config
 * (which sender contexts exist, whether the voice is still a placeholder) rather
 * than describing it from memory, so it cannot drift out of date.
 */

import Link from "next/link";

import { optionalEnv } from "@fundable/shared";

import { getVoice, senderContextIds } from "../../lib/config-registry";

export const dynamic = "force-dynamic";

export default function GuidePage() {
  const voice = getVoice("jacob");
  const contexts = senderContextIds();
  const keySet = !!optionalEnv("PERSONALIZE_API_KEY");

  return (
    <main className="gd-shell">
      <header className="gd-head">
        <div className="ov-eyebrow">Personalization API</div>
        <h1>How to use it</h1>
        <p className="gd-lede">
          What it does, how to call it, and what it would take to put into daily use. For the
          product rationale, start at the <Link href="/">overview</Link>.
        </p>
      </header>

      <nav className="gd-toc">
        <a href="#model">1 · Where it fits</a>
        <a href="#try">2 · Trying it</a>
        <a href="#api">3 · Calling it</a>
        <a href="#triggers">4 · The four triggers</a>
        <a href="#voice">5 · Tuning the voice</a>
        <a href="#wiring">6 · Wiring it up</a>
        <a href="#trouble">7 · Troubleshooting</a>
        <a href="#limits">8 · Honest limits</a>
      </nav>

      {/* ------------------------------------------------------------- 1 */}
      <section id="model" className="gd-section">
        <h2>1 · Where it fits</h2>
        <p>
          This is <strong>one POST endpoint</strong>. A person and a reason for writing go in; copy
          and the evidence behind every claim come out. <strong>It sends nothing.</strong>
        </p>
        <p>In production nobody opens this. A workflow calls it and a draft appears for review:</p>
        <pre className="gd-flow">{`Fundable deal alert fires
  → n8n webhook
  → POST /api/personalize
  → copy + evidence returned
  → if confidence ≥ 0.5, n8n creates a Gmail DRAFT
  → you read it, edit if you want, hit send`}</pre>
        <p className="gd-note">
          The <Link href="/demo">demo page</Link> is a stand-in for that workflow — a window so a
          human can watch what the machine does, stage by stage. It exists to make the pipeline
          legible, not because anyone would use it daily.
        </p>
      </section>

      {/* ------------------------------------------------------------- 2 */}
      <section id="try" className="gd-section">
        <h2>2 · Trying it</h2>
        <p>
          Open the <Link href="/demo">demo</Link>. Two ways in:
        </p>
        <ul className="gd-bugs">
          <li>
            <strong>Sample data</strong> — one click, no key. It replays a captured real run
            (ramp.com) so the interface and the evidence trail are visible immediately.
          </li>
          <li>
            <strong>Live</strong> — needs the bearer key (<code>PERSONALIZE_API_KEY</code>), which
            is what stops anyone else from spending Fundable credits on this endpoint.{" "}
            {keySet ? "It is configured on this deployment." : "It is NOT configured here."}
          </li>
        </ul>
        <p>Worth doing in this order, because the third one is the point:</p>
        <ol className="gd-check">
          <li>
            <strong>Run the Ramp preset.</strong> Watch the pipeline stream: resolve → enrich → tie
            → angle → write → verify. About four seconds.
          </li>
          <li>
            <strong>Read the evidence cards, not the email.</strong> Every figure in the copy
            traces to a row there, with the endpoint it came from. That is the audit trail, and it
            is what makes this safe to automate.
          </li>
          <li>
            <strong>Try a company that will not resolve.</strong> Put{" "}
            <code>ceo@zzz-not-real-9931.com</code> in, tick <em>use my template</em>, run it. It
            returns <code>no_match</code> and hands the template back untouched. It would rather
            return nothing than invent a funding round.
          </li>
          <li>
            <strong>Switch the trigger to <code>website-visitor</code>.</strong> The email now
            opens &ldquo;Hi,&rdquo; with no name, even though the person is resolvable — an
            anonymous company-level signal does not get to know who is reading.
          </li>
        </ol>
      </section>

      {/* ------------------------------------------------------------- 3 */}
      <section id="api" className="gd-section">
        <h2>3 · Calling it</h2>
        <pre className="gd-code">{`curl -s -X POST https://personalize-api-umber.vercel.app/api/personalize \\
  -H "Authorization: Bearer $PERSONALIZE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "person": { "email": "eric@ramp.com",
                "linkedin": "https://www.linkedin.com/in/eglyman",
                "name": "Eric Glyman" },
    "trigger": "post-raise",
    "channel": "email",
    "template": "Hi {{first_name}},\\n\\n{{opener}}\\n\\nBest",
    "sender_context": "default",
    "max_facts": 3
  }'`}</pre>
        <p>
          <code>person</code> needs <strong>email or linkedin</strong> (both is better).{" "}
          <code>channel</code> is <code>email</code> or <code>linkedin</code>.{" "}
          <code>template</code> and <code>sender_context</code> are optional.{" "}
          <code>max_facts</code> is clamped to 1&ndash;3.
        </p>

        <h3 className="gd-h3">What comes back</h3>
        <table className="ov-table">
          <thead><tr><th>Field</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td><code>status</code></td><td><code>personalized</code> · <code>template_only</code> · <code>no_match</code></td></tr>
            <tr><td><code>confidence</code></td><td>0&ndash;1. <strong>Gate on ≥ 0.5.</strong> Below that it returns your template untouched.</td></tr>
            <tr><td><code>subject</code> / <code>body</code></td><td>the copy. <code>subject</code> is null for LinkedIn.</td></tr>
            <tr><td><code>angle</code></td><td>which angle was used — worth logging, it is how reply-rate-by-angle gets measured</td></tr>
            <tr><td><code>evidence[]</code></td><td>every fact used, with source and endpoint. The audit trail.</td></tr>
            <tr><td><code>warnings[]</code></td><td>surface these to whoever reviews the draft</td></tr>
            <tr><td><code>usage</code></td><td>Fundable credits, Exa cost, tokens, latency</td></tr>
          </tbody>
        </table>

        <h3 className="gd-h3">Cost per message</h3>
        <p>
          Roughly <strong>1&ndash;5 Fundable credits</strong>, <strong>$0.006</strong> of web
          search, and <strong>$0.003</strong> of tokens. Lookups are cached (30 days for funding
          data, 3 days for news), so a second message about the same company costs no credits at
          all.
        </p>

        <h3 className="gd-h3">Also available</h3>
        <ul className="gd-bugs">
          <li><code>POST /api/personalize/stream</code> — same thing as NDJSON, one stage event per line. This is what the demo renders.</li>
          <li><code>GET /api/health</code> — unauthenticated, makes no paid calls, safe to poll.</li>
          <li><code>GET /api/meta</code> — sender contexts and voice provenance.</li>
        </ul>
      </section>

      {/* ------------------------------------------------------------- 4 */}
      <section id="triggers" className="gd-section">
        <h2>4 · The four triggers</h2>
        <p>
          Each trigger is a different claim about <em>why</em> you are writing, so each is allowed
          different evidence. That policy lives in one table in the code rather than scattered
          through it, so what a trigger may use is auditable at a glance.
        </p>
        <table className="ov-table">
          <thead><tr><th>Trigger</th><th>Fires on</th><th>Notable policy</th></tr></thead>
          <tbody>
            <tr>
              <td><code>post-raise</code></td><td>Fundable deal alert</td>
              <td>The only one that penalises a stale raise — a &ldquo;congrats&rdquo; about a four-year-old round scores lower and says why.</td>
            </tr>
            <tr>
              <td><code>cold</code></td><td>outbound sequence or list</td>
              <td>Weights computed ties highest. A shared investor is the reason for writing.</td>
            </tr>
            <tr>
              <td><code>sign-up</code></td><td>product sign-up</td>
              <td>They already know you, so it does not pitch. Skips paid news lookups, and refuses to write about internal or test accounts.</td>
            </tr>
            <tr>
              <td><code>website-visitor</code></td><td>reverse-IP or form fill</td>
              <td><strong>Cannot name a person at all.</strong> Company facts only.</td>
            </tr>
          </tbody>
        </table>
        <p className="gd-note">
          That last one is enforced structurally, not by asking the model nicely. The first live
          test still opened &ldquo;Hi Eric,&rdquo; because the greeting name arrived by a different
          route than the facts did — so recipient identity is now withheld from the writer
          entirely, and the response reports that it was.
        </p>
      </section>

      {/* ------------------------------------------------------------- 5 */}
      <section id="voice" className="gd-section">
        <h2>5 · Tuning the voice</h2>
        <p>
          The voice is a config file, not code, so changing it is an edit rather than a refactor.
          Current provenance:{" "}
          <code className={voice.provenance === "placeholder" ? "gd-warnpill" : "gd-okpill"}>
            {voice.provenance}
          </code>
        </p>
        <p className="gd-caveat">
          <strong>This is the one thing worth doing before anything else.</strong> The profile was
          inferred from LinkedIn posts, because that is what was available. Cold email is a
          different register — a post opens with a number engineered to survive truncation; a cold
          email opens quietly and asks once. So the copy currently reads competent and generic
          rather than like a specific person, and every API response says so.
        </p>
        <p>What replacing it involves, given 10-20 real sent emails:</p>
        <ol className="gd-check">
          <li>Swap in real subject lines for the invented examples.</li>
          <li>Measure actual word count and sentence length; overwrite the limits.</li>
          <li>Capture the real sign-off, and whether a cold email gets a greeting at all.</li>
          <li>Add 3&ndash;5 of the emails as few-shot anchors.</li>
          <li>
            Flip <code>provenance</code> to <code>&quot;real_examples&quot;</code>. The warning then
            disappears from every response on its own.
          </li>
        </ol>
        <p className="gd-note">
          Then re-run the verification audit. Three adversarial passes so far each found exactly one
          new class of defect, and changing the voice changes what the writer produces — so
          re-auditing is part of the change, not an optional extra.
        </p>
      </section>

      {/* ------------------------------------------------------------- 6 */}
      <section id="wiring" className="gd-section">
        <h2>6 · Wiring it up</h2>
        <p>
          The GTM stack already runs on n8n, HubSpot and HeyReach, so this is webhook wiring rather
          than new infrastructure. Roughly an afternoon.
        </p>
        <pre className="gd-flow">{`status === "personalized" && confidence >= 0.5
  → create a Gmail DRAFT, attach warnings as a note
  → write angle + confidence onto the HubSpot contact
otherwise
  → use the generic sequence copy, and log angle + confidence anyway`}</pre>
        <p className="gd-note">
          <strong>Drafts only.</strong> Nothing in this codebase can send, and the workflow layer
          should keep it that way. A human sends every message.
        </p>
        <p>
          Writing angle and confidence back on <em>every</em> message, including the ones that fell
          back to generic copy, is what makes reply-rate-by-angle measurable later. It costs
          nothing now, and it is the whole argument for whether this becomes a product.
        </p>

        <h3 className="gd-h3">Sender contexts currently configured</h3>
        <ul className="gd-bugs">
          {contexts.map((c) => (
            <li key={c}>
              <code>{c}</code>
              {c === "default" &&
                " — safe and generic. Its customer list is empty, which is why the investor-overlap angle is currently dormant."}
              {c === "EXAMPLE_not_real_customers" &&
                " — demonstration only. Its companies are well-known reference companies, NOT customers, and it exists purely so the investor-overlap mechanic can be exercised."}
            </li>
          ))}
        </ul>
      </section>

      {/* ------------------------------------------------------------- 7 */}
      <section id="trouble" className="gd-section">
        <h2>7 · Troubleshooting</h2>
        <table className="ov-table">
          <thead><tr><th>Symptom</th><th>Cause</th></tr></thead>
          <tbody>
            <tr>
              <td>Demo says it recognised a different key</td>
              <td>The gate wants <code>PERSONALIZE_API_KEY</code>, not the Fundable, OpenRouter or database key — the server holds those itself.</td>
            </tr>
            <tr><td><code>401</code></td><td>Missing or wrong bearer token.</td></tr>
            <tr><td><code>503</code></td><td>No API key configured server-side. It fails closed rather than running open.</td></tr>
            <tr><td><code>429</code></td><td>Over the hourly rate limit.</td></tr>
            <tr><td><code>502 UPSTREAM_FUNDABLE</code></td><td>Fundable rejected the call, usually an expired key. Check <code>/api/health</code>.</td></tr>
            <tr><td>Everything returns <code>no_match</code></td><td>Check <code>/api/health</code> — a missing Fundable key looks exactly like &ldquo;nothing resolves&rdquo;.</td></tr>
            <tr><td>Copy is bland</td><td>Expected while the voice provenance is <code>placeholder</code>. See section 5.</td></tr>
          </tbody>
        </table>
      </section>

      {/* ------------------------------------------------------------- 8 */}
      <section id="limits" className="gd-section">
        <h2>8 · Honest limits</h2>
        <ul className="gd-limits">
          <li>
            <strong>The voice is not tuned.</strong> Stated twice because it is the one that
            matters. Everything else here is polish next to it.
          </li>
          <li>
            <strong>Verification is pattern-based, not comprehensive.</strong> Three adversarial
            audits found three distinct defect classes: two true facts welded into a false third, a
            valuation worn as a raise amount, and a pronoun that quietly moved who a claim was
            about. A fourth audit would likely find a fourth. The right conclusion is to re-audit
            after any change, not to assume it stays clean.
          </li>
          <li>
            <strong>The measured 12% fallback rate is flattered by its fixture.</strong> It used
            four extremely well-connected reference companies, so the investor-overlap angle fired
            on almost every row. A real cold list would fall back more often — and would also
            settle whether the confidence gate is well calibrated or simply too loose.
          </li>
          <li>
            <strong>The rate limit is per-instance.</strong> On serverless each instance keeps its
            own counter, so the effective ceiling is higher than the configured one. Fine at this
            volume; needs replacing before sequencer traffic.
          </li>
          <li>
            <strong>Repeat-founder ties depend on a third-party index</strong>, because
            Fundable&apos;s own employment history comes back empty. If the identity match cannot be
            confirmed against the employer, the tie is skipped rather than guessed.
          </li>
          <li>
            <strong>No async queue.</strong> Fine for review-and-send; needed before high volume.
          </li>
        </ul>
      </section>

      <footer className="ov-footer">
        <span>
          voice <code>{voice.id}</code> · provenance <code>{voice.provenance}</code> ·{" "}
          {contexts.length} sender context{contexts.length === 1 ? "" : "s"}
        </span>
        <Link href="/demo">Open the demo →</Link>
      </footer>
    </main>
  );
}
