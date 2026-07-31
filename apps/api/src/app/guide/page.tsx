/**
 * /guide — the operator's guide. Everything needed to run this and to demo it,
 * in the order you actually need it.
 *
 * Deliberately a page in the app rather than a markdown file: it is read right
 * before a demo, on the same localhost that is about to be demoed, and it can
 * show the real config (which sender contexts exist, whether the voice is still
 * a placeholder) instead of describing it from memory.
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
        <div className="ov-eyebrow">Fundable · operator guide</div>
        <h1>Running and demoing the Personalization API</h1>
        <p className="gd-lede">
          Read top to bottom the first time. Before a demo, jump to{" "}
          <a href="#checklist">the checklist</a> and <a href="#demo">the five beats</a>.
        </p>
      </header>

      <nav className="gd-toc">
        <a href="#model">1 · Mental model</a>
        <a href="#start">2 · Start it</a>
        <a href="#keys">3 · Which key is which</a>
        <a href="#checklist">4 · Pre-demo checklist</a>
        <a href="#demo">5 · The demo</a>
        <a href="#send">6 · What to send Jacob</a>
        <a href="#voice">7 · Applying his voice</a>
        <a href="#api">8 · API reference</a>
        <a href="#trouble">9 · Troubleshooting</a>
        <a href="#limits">10 · Honest limits</a>
      </nav>

      {/* ------------------------------------------------------------- 1 */}
      <section id="model" className="gd-section">
        <h2>1 · Mental model</h2>
        <p>
          This is <strong>one POST endpoint</strong>. Person + reason for writing in; copy +
          evidence out. It sends nothing.
        </p>
        <p>
          <strong>Jacob never touches it.</strong> In production a machine calls it and drops a
          draft in his inbox:
        </p>
        <pre className="gd-flow">{`Fundable deal alert fires
  → n8n webhook
  → POST /api/personalize          ← the caller's key lives here, in n8n config
  → copy + evidence returned
  → if confidence ≥ 0.5, n8n creates a Gmail DRAFT
  → Jacob reads it in Gmail, edits if he wants, hits send`}</pre>
        <p className="gd-note">
          The <code>/demo</code> page is a stand-in for n8n — a window so a human can watch what the
          machine does. That is why <em>you</em> paste a key there and Jacob never would.
        </p>
      </section>

      {/* ------------------------------------------------------------- 2 */}
      <section id="start" className="gd-section">
        <h2>2 · Start it</h2>
        <pre className="gd-code">{`cd ~/Developer/work/fundable/personalize-api
npm run dev`}</pre>
        <table className="ov-table">
          <thead>
            <tr><th>Page</th><th>What it is for</th></tr>
          </thead>
          <tbody>
            <tr><td><Link href="/">/</Link></td><td>Overview + live dependency health. Open this first in a demo.</td></tr>
            <tr><td><Link href="/guide">/guide</Link></td><td>This page.</td></tr>
            <tr><td><Link href="/demo">/demo</Link></td><td>The live tool. Needs the bearer key once.</td></tr>
          </tbody>
        </table>
      </section>

      {/* ------------------------------------------------------------- 3 */}
      <section id="keys" className="gd-section">
        <h2>3 · Which key is which</h2>
        <p>
          Four keys live in <code>.env</code> and <strong>only one</strong> opens the demo. This is
          the single easiest thing to get wrong.
        </p>
        <table className="ov-table">
          <thead>
            <tr><th>Key</th><th>Who uses it</th><th>Do you ever paste it?</th></tr>
          </thead>
          <tbody>
            <tr>
              <td><code>PERSONALIZE_API_KEY</code></td>
              <td>the <em>caller</em> — n8n, or you in the demo</td>
              <td><strong className="ov-ok">Yes — this is the demo one</strong></td>
            </tr>
            <tr><td><code>FUNDABLE_API_KEY</code></td><td>the server, calling Fundable</td><td className="ov-no">No</td></tr>
            <tr><td><code>EXA_API_KEY</code></td><td>the server, calling Exa</td><td className="ov-no">No</td></tr>
            <tr><td><code>OPENROUTER_API_KEY</code></td><td>the server, calling DeepSeek</td><td className="ov-no">No</td></tr>
            <tr><td><code>SUPABASE_SECRET_KEY</code></td><td>the server, for cache + log</td><td className="ov-no">No</td></tr>
          </tbody>
        </table>
        <p>Get the demo key onto your clipboard:</p>
        <pre className="gd-code">{`grep '^PERSONALIZE_API_KEY=' ~/Developer/work/fundable/personalize-api/.env | cut -d= -f2 | pbcopy`}</pre>
        <p className="gd-note">
          Paste the bare 64-character hex value. No <code>Bearer </code> prefix, no quotes — the
          field adds those itself. {keySet ? "It is set." : "It is NOT set — the API will fail closed with 503."}
        </p>
      </section>

      {/* ------------------------------------------------------------- 4 */}
      <section id="checklist" className="gd-section">
        <h2>4 · Pre-demo checklist</h2>
        <p className="gd-sub">Ten minutes before, not live.</p>
        <ol className="gd-check">
          <li>
            <strong>Warm the presets.</strong> Cold runs take 12s+, warm ones about 4s. The Exa half
            of the cache expires after 3 days, so re-warm if it has been a while.
            <pre className="gd-code">{`python3 /private/tmp/claude-501/-Users-test/bb563f82-a00b-4042-a679-0dd55784fdf4/scratchpad/warm.py \\
  $(grep '^PERSONALIZE_API_KEY=' ~/Developer/work/fundable/personalize-api/.env | cut -d= -f2)`}</pre>
          </li>
          <li>
            <strong>Restart the dev server.</strong> The rate limit is in-memory, so a restart
            resets your 120/hour and you cannot hit the cap mid-demo.
          </li>
          <li>
            <strong>Load <Link href="/">/</Link> and check the health table is green.</strong> Catches
            a dead key before Jacob sees a 502.
          </li>
          <li>
            <strong>Unlock <Link href="/demo">/demo</Link> and leave the tab open.</strong> A refresh
            forgets the key, so do not reload once you are live.
          </li>
          <li>
            <strong>Have <Link href="/">/</Link> open in a second tab</strong> so you can switch back
            without re-pasting.
          </li>
        </ol>
      </section>

      {/* ------------------------------------------------------------- 5 */}
      <section id="demo" className="gd-section">
        <h2>5 · The demo, five beats</h2>
        <p className="gd-sub">
          About five minutes. Close on beat 5, not beat 2 — the refusal is the product.
        </p>

        <div className="gd-beats">
          <div className="gd-beat">
            <div className="gd-beat-n">1</div>
            <div>
              <h3>Orient · 30s</h3>
              <p>
                Open <Link href="/">/</Link>. <em>&ldquo;You said the alert isn&apos;t the email.
                This is the last mile, as an endpoint.&rdquo;</em> Let him read the four use-case
                cards himself.
              </p>
            </div>
          </div>

          <div className="gd-beat">
            <div className="gd-beat-n">2</div>
            <div>
              <h3>It works · 60s</h3>
              <p>
                <Link href="/demo">/demo</Link> → <strong>Ramp</strong> preset → Personalize. Do not
                narrate over the stream. Let him watch resolve → enrich → tie → angle → write →
                verify tick past. ~4s.
              </p>
            </div>
          </div>

          <div className="gd-beat">
            <div className="gd-beat-n">3</div>
            <div>
              <h3>The receipts · 60s</h3>
              <p>
                Point at the <strong>evidence cards</strong>, not the email. <em>&ldquo;Every figure
                in that copy traces to a row here, with the endpoint it came from.&rdquo;</em> This
                is what separates it from every AI-outbound demo he has seen.
              </p>
            </div>
          </div>

          <div className="gd-beat">
            <div className="gd-beat-n">4</div>
            <div>
              <h3>The moat · 90s</h3>
              <p>
                Switch trigger to <code>cold</code>, sender context to <code>EXAMPLE_not_real_customers</code>. You
                get <em>&ldquo;Insight Partners is an investor in both Ramp and Anthropic.&rdquo;</em>{" "}
                Say it plainly: <strong>a web-search tool cannot produce that sentence.</strong> It
                needs the investor graph. Fundable owns it.
              </p>
            </div>
          </div>

          <div className="gd-beat">
            <div className="gd-beat-n">5</div>
            <div>
              <h3>The trust moment · 60s</h3>
              <p>
                Type <code>ceo@zzz-not-real-9931.com</code>, tick <strong>use my template</strong>,
                run it. Comes back <code>no_match</code> with the template untouched.{" "}
                <em>&ldquo;It would rather hand your template back than invent a round.&rdquo;</em>
              </p>
              <p>
                Then flip trigger to <code>website-visitor</code> on Ramp — the email opens{" "}
                <code>&ldquo;Hi,&rdquo;</code> with no name, because an anonymous signal does not get
                to know who is reading.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------------- 6 */}
      <section id="send" className="gd-section">
        <h2>6 · What to send Jacob</h2>
        <div className="gd-two">
          <div className="gd-dont">
            <h3>Do not send</h3>
            <ul>
              <li><code>.env</code>, or any key</li>
              <li>A link — nothing is deployed, this is your laptop</li>
            </ul>
          </div>
          <div className="gd-do">
            <h3>Send</h3>
            <ul>
              <li>
                <strong>A 3-minute screen recording</strong> of the five beats. No setup, no key,
                works on his phone.
              </li>
              <li>
                <strong>The three asks</strong> (below) — that is the actual point of the demo.
              </li>
              <li>
                <strong>The data bugs you found</strong> — a gift to his team.
              </li>
            </ul>
          </div>
        </div>

        <h3 className="gd-h3">The three asks — what you actually need from him</h3>
        <ol className="gd-asks">
          <li>
            <strong>10–20 real sent emails</strong>, or his <code>jacob voice</code> Claude skill.
            The voice is currently inferred from his LinkedIn posts, and cold email is a different
            register. <em>This is the one thing between demo and daily use.</em>
          </li>
          <li>
            <strong>Which customers may be named in outbound.</strong> The investor-overlap tie —
            the highest-value angle — is dormant in the default config until he says.
          </li>
          <li>
            <strong>Lead investor: quote or extract?</strong> Fundable has no structured lead field;
            the lead appears only in prose. Quoting is safe; extracting reads better and risks
            naming the wrong fund.
          </li>
        </ol>

        <h3 className="gd-h3">The data bugs (send these — you found them by building on his product)</h3>
        <ul className="gd-bugs">
          <li>
            Anthropic&apos;s round is <strong>$50B</strong> in the structured field and{" "}
            <strong>$65B</strong> in Fundable&apos;s own deal description. Same deal, same response.
          </li>
          <li>
            A <strong>blank</strong> LinkedIn URL returns the entire 365k-row people table and an
            arbitrary stranger as row 0, billed 1 credit.
          </li>
          <li>
            <code>page_size</code> defaults to 10, so a documented 100-domain batch silently returns
            10 and the other 90 look like unknown domains.
          </li>
          <li>Unknown identifiers are dropped with no error, and <code>meta.total_count</code> counts matches rather than requests, so nothing in the response reveals the drop.</li>
          <li><code>www.</code>-prefixed domains match nothing, indistinguishable from a fake company.</li>
        </ul>

        <h3 className="gd-h3">Say this before he asks</h3>
        <p className="gd-caveat">
          The 12% downgrade rate was measured with four ubiquitously-funded reference companies, so
          investor-overlap fired on almost every row. A real customer list will downgrade more often.
          Volunteering that is worth more than the 12%.
        </p>
      </section>

      {/* ------------------------------------------------------------- 7 */}
      <section id="voice" className="gd-section">
        <h2>7 · Applying his voice when it arrives</h2>
        <p>
          The voice lives in <code>config/voice/jacob.json</code> — data, not code, so this is an
          edit rather than a refactor. Current provenance:{" "}
          <code className={voice.provenance === "placeholder" ? "gd-warnpill" : "gd-okpill"}>
            {voice.provenance}
          </code>
        </p>
        <ol className="gd-check">
          <li>
            Replace <code>subject_line.good_examples</code> with his real subject lines, and drop the
            invented ones.
          </li>
          <li>
            Measure his real average word count and sentence length; overwrite <code>limits</code>.
          </li>
          <li>
            Capture his actual sign-off and how he actually opens a cold email (does he greet at all?).
          </li>
          <li>
            Add 3–5 real emails as few-shot anchors, the way <code>EXAMPLES</code> works in
            post-studio&apos;s <code>voice.ts</code>.
          </li>
          <li>
            Flip <code>provenance</code> to <code>&quot;real_examples&quot;</code>. The placeholder
            warning then disappears from every response on its own — nothing else to remember.
          </li>
        </ol>
        <p className="gd-note">
          <strong>Then re-run the audit.</strong> Each adversarial pass so far found exactly one new
          defect class. Changing the voice changes what the writer produces, so treat re-auditing as
          part of the change, not optional.
        </p>
      </section>

      {/* ------------------------------------------------------------- 8 */}
      <section id="api" className="gd-section">
        <h2>8 · API reference (for the n8n wiring)</h2>

        <h3 className="gd-h3">Sync — the one you want from n8n</h3>
        <pre className="gd-code">{`curl -s -X POST http://localhost:3111/api/personalize \\
  -H "Authorization: Bearer $PERSONALIZE_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "person": { "email": "eric@ramp.com",
                "linkedin": "https://www.linkedin.com/in/eglyman",
                "name": "Eric Glyman" },
    "trigger": "post-raise",
    "channel": "email",
    "template": "Hi {{first_name}},\\n\\n{{opener}}\\n\\nJacob",
    "sender_context": "default",
    "max_facts": 3
  }'`}</pre>

        <p>
          <code>person</code> needs <strong>email or linkedin</strong> (both is better).{" "}
          <code>trigger</code> is one of <code>post-raise</code>, <code>cold</code>,{" "}
          <code>sign-up</code>, <code>website-visitor</code>. <code>channel</code> is{" "}
          <code>email</code> or <code>linkedin</code>. <code>template</code> and{" "}
          <code>sender_context</code> are optional; <code>max_facts</code> is clamped to 1–3.
        </p>

        <h3 className="gd-h3">What comes back</h3>
        <table className="ov-table">
          <thead><tr><th>Field</th><th>Meaning</th></tr></thead>
          <tbody>
            <tr><td><code>status</code></td><td><code>personalized</code> · <code>template_only</code> · <code>no_match</code></td></tr>
            <tr><td><code>confidence</code></td><td>0–1. <strong>Gate your n8n branch on ≥ 0.5.</strong></td></tr>
            <tr><td><code>subject</code> / <code>body</code></td><td>the copy. <code>subject</code> is null for LinkedIn.</td></tr>
            <tr><td><code>angle</code></td><td>which angle was used — log it, this is how reply-rate-by-angle gets measured later</td></tr>
            <tr><td><code>evidence[]</code></td><td>every fact used, with source and endpoint. The audit trail.</td></tr>
            <tr><td><code>warnings[]</code></td><td>always surface these to whoever reviews the draft</td></tr>
            <tr><td><code>usage</code></td><td>credits, Exa cost, tokens, latency</td></tr>
          </tbody>
        </table>

        <h3 className="gd-h3">The branch n8n should implement</h3>
        <pre className="gd-flow">{`status === "personalized" && confidence >= 0.5
  → create a Gmail DRAFT with subject + body, attach warnings as a note
  → drop the evidence array on the HubSpot contact
otherwise
  → use the generic sequence copy, and log the angle + confidence anyway`}</pre>
        <p className="gd-note">
          Drafts only. Never wire this to send — nothing in this codebase can send, and the n8n layer
          should keep it that way.
        </p>

        <h3 className="gd-h3">Streaming (what the demo uses)</h3>
        <pre className="gd-code">{`curl -sN -X POST http://localhost:3111/api/personalize/stream \\
  -H "Authorization: Bearer $PERSONALIZE_API_KEY" \\
  -H "Content-Type: application/json" -d '{ ...same body... }'`}</pre>
        <p>
          NDJSON, one stage event per line, ending with a <code>done</code> event carrying the full
          response. Use the sync endpoint for automation; this exists for the demo.
        </p>

        <h3 className="gd-h3">Also available</h3>
        <ul className="gd-bugs">
          <li><code>GET /api/health</code> — unauthenticated, no paid calls, safe to poll</li>
          <li><code>GET /api/meta</code> — sender contexts + voice provenance (needs the bearer key)</li>
        </ul>

        <h3 className="gd-h3">Sender contexts on disk right now</h3>
        <ul className="gd-bugs">
          {contexts.map((c) => (
            <li key={c}>
              <code>{c}</code>
              {c === "default" && " — safe, generic. customer_domains is empty so the investor-overlap tie is dormant."}
              {c === "EXAMPLE_not_real_customers" && " — DEMO ONLY. Its companies are well-known reference companies, NOT Fundable customers."}
            </li>
          ))}
        </ul>
      </section>

      {/* ------------------------------------------------------------- 9 */}
      <section id="trouble" className="gd-section">
        <h2>9 · Troubleshooting</h2>
        <table className="ov-table">
          <thead><tr><th>Symptom</th><th>Cause / fix</th></tr></thead>
          <tbody>
            <tr>
              <td>Demo says &ldquo;that looks like your Fundable API key&rdquo;</td>
              <td>You pasted an upstream key. The demo wants <code>PERSONALIZE_API_KEY</code> — see §3.</td>
            </tr>
            <tr>
              <td><code>503 NOT_CONFIGURED</code></td>
              <td><code>PERSONALIZE_API_KEY</code> is unset in <code>.env</code>. The API fails closed rather than running open.</td>
            </tr>
            <tr>
              <td><code>429 RATE_LIMITED</code></td>
              <td>Over 120/hour. Restart the dev server to reset the in-memory counter.</td>
            </tr>
            <tr>
              <td><code>502 UPSTREAM_FUNDABLE</code></td>
              <td>Fundable rejected the call — usually an expired or rotated key. Check <Link href="/">/</Link>.</td>
            </tr>
            <tr>
              <td>First run takes 15s+</td>
              <td>Cold route compile plus uncached enrichment. Warm the presets (§4).</td>
            </tr>
            <tr>
              <td>Everything is <code>no_match</code></td>
              <td>Check the health table. A missing <code>FUNDABLE_API_KEY</code> looks exactly like &ldquo;nothing resolves&rdquo;.</td>
            </tr>
            <tr>
              <td>Copy is bland</td>
              <td>Expected while voice provenance is <code>placeholder</code> and sender facts are generic. See §7.</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* ------------------------------------------------------------- 10 */}
      <section id="limits" className="gd-section">
        <h2>10 · Honest limits</h2>
        <ul className="gd-limits">
          <li>
            <strong>Nothing is deployed.</strong> This is localhost only. If you deploy it, two
            things break: the in-memory rate limit becomes per-instance and meaningless, and the
            racing latency hedge doubles LLM calls under concurrency.
          </li>
          <li>
            <strong>Verification is pattern-based.</strong> Three adversarial audits found three
            distinct defect classes — welded facts, a valuation worn as a raise, and pronoun
            compression. A fourth audit would likely find a fourth. Re-audit after any prompt or
            voice change.
          </li>
          <li>
            <strong>The proper-noun check is advisory only.</strong> It warns, never blocks, because
            it is heuristic. Read those warnings before sending.
          </li>
          <li>
            <strong>No async queue.</strong> Fine for manual use and the demo; needed before
            sequencer volume.
          </li>
          <li>
            <strong>Repeat-founder ties depend on Exa</strong>, because Fundable&apos;s own
            <code> employment_history</code> comes back empty. If the Exa identity gate cannot
            confirm the employer, the tie is skipped rather than guessed.
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
