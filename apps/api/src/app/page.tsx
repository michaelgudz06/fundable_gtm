/**
 * / — the overview page. What this is, who it is for, what it can and cannot do.
 *
 * A server component: it renders the dependency status from /api/health at
 * request time so the page cannot claim things work when they do not.
 */

import Link from "next/link";

import { optionalEnv, provenanceWarning } from "@fundable/shared";

import { VOICE } from "../lib/config-registry";
import { checkHealth, type Dep } from "../lib/health";

export const dynamic = "force-dynamic";

const USE_CASES = [
  {
    trigger: "post-raise",
    who: "Fundable deal alert fires",
    what: "A company in your target list just raised. You want to be the first credible email in the founder's inbox, referencing the actual round rather than a generic congratulations.",
    example: 'Angle: the_raise → "Ramp raised a $750M Series F at a $44B valuation on June 4."',
    status: "live",
  },
  {
    trigger: "cold",
    who: "Outbound sequence / HeyReach list",
    what: "No signal from them at all. The message has to earn attention on specificity, so it leads with a real tie — a shared investor beats everything else, because no generic tool can know it.",
    example: 'Angle: investor_overlap → "Insight Partners is an investor in both Ramp and Anthropic."',
    status: "live",
  },
  {
    trigger: "sign-up",
    who: "Product sign-up webhook (Clerk)",
    what: "Someone created an account. They already know who you are, so this is not a pitch — it keys on their company's stage and getting them value fast. Skips Exa (no news hook needed) and refuses to write about internal or test accounts.",
    example: 'Angle: stage_fit / company_profile → keyed to their round stage, not a news event.',
    status: "live",
  },
  {
    trigger: "website-visitor",
    who: "Reverse-IP or form fill",
    what: "A company-level signal with no identified person. This trigger structurally cannot name an individual or reference their personal news — it is addressed to no one in particular, because pretending to know who was browsing is the fastest way to get marked as spam.",
    example: 'Opens "Hi," — never "Hi Eric," even when a person is resolvable.',
    status: "live",
  },
];

const PIPELINE = [
  { n: 1, stage: "RESOLVE", kind: "deterministic", what: "email domain → Fundable company, LinkedIn URL → person. Cached 30 days." },
  { n: 2, stage: "ENRICH", kind: "deterministic", what: "Fundable facts (round, lead, valuation, profile) + Exa (dated coverage, career history). Exa cached 3 days." },
  { n: 3, stage: "TIE", kind: "deterministic", what: "shared investor, same city, same stage, repeat founder — computed against your sender context." },
  { n: 4, stage: "ANGLE", kind: "DeepSeek V4-flash", what: "picks ONE angle and up to max_facts facts, by index, from the closed set." },
  { n: 5, stage: "WRITE", kind: "DeepSeek V4-pro", what: "the only generative step. Facts are a closed set; voice comes from config." },
  { n: 6, stage: "VERIFY", kind: "code, not prompt", what: "every claim checked against the evidence. One corrective retry, then it refuses to ship." },
];

export default async function Home() {
  const voice = VOICE;
  const warning = provenanceWarning(voice);
  const keySet = !!optionalEnv("PERSONALIZE_API_KEY");

  // Called directly rather than self-fetched over HTTP — a hardcoded hostname
  // works locally and breaks everywhere else.
  let deps: Dep[] = [];
  let healthOk = false;
  try {
    const health = await checkHealth();
    deps = health.deps;
    healthOk = health.ok;
  } catch {
    deps = [];
  }

  return (
    <main className="ov-shell">
      <header className="ov-hero">
        <div className="ov-eyebrow">Fundable · internal tooling</div>
        <h1>Personalization API</h1>
        <p className="ov-lede">
          One endpoint you call before sending any automated email or LinkedIn message. Give it a
          person and a reason for writing; it returns copy in your voice plus the evidence behind
          every claim. When it cannot find an honest angle, it hands your template back
          untouched and says so.
        </p>
        <div className="ov-cta">
          <Link className="ov-btn" href="/demo">
            Open the live demo →
          </Link>
          <span className="ov-cta-note">
            {keySet
              ? "The demo asks for the bearer key once (held in memory, never stored). Sample mode works without it."
              : "PERSONALIZE_API_KEY is not set — the demo will report 503 until it is."}
          </span>
        </div>
      </header>

      {warning && (
        <div className="ov-banner ov-warn">
          <strong>The voice is not tuned yet.</strong> It was inferred from LinkedIn posts,
          because that is what was available — and cold email is a different register: shorter, no
          hook, one ask. So the copy below reads competent and generic rather than like a specific
          person. Every API response carries this warning until it is rebuilt from real sent
          emails. See <a href="/guide#voice">tuning the voice</a>.
        </div>
      )}

      {/* ---------------------------------------------------------- use cases */}
      <section className="ov-section">
        <h2>What it is for</h2>
        <p className="ov-sub">
          Four triggers, each a different claim about <em>why</em> you are writing — so each is
          allowed to use different evidence. All four are live.
        </p>
        <div className="ov-cards">
          {USE_CASES.map((u) => (
            <article key={u.trigger} className="ov-card">
              <div className="ov-card-head">
                <code className="ov-trigger">{u.trigger}</code>
                <span className="ov-pill ov-pill-live">{u.status}</span>
              </div>
              <div className="ov-who">{u.who}</div>
              <p>{u.what}</p>
              <div className="ov-example">{u.example}</div>
            </article>
          ))}
        </div>
      </section>

      {/* ----------------------------------------------------------- pipeline */}
      <section className="ov-section">
        <h2>How a request runs</h2>
        <p className="ov-sub">
          Five of six stages are deterministic. Only stage 5 writes anything, and stage 6 checks it
          in code rather than trusting the prompt.
        </p>
        <ol className="ov-pipeline">
          {PIPELINE.map((s) => (
            <li key={s.n}>
              <span className="ov-stage-n">{s.n}</span>
              <div>
                <div className="ov-stage-name">
                  {s.stage} <span className="ov-stage-kind">{s.kind}</span>
                </div>
                <div className="ov-stage-what">{s.what}</div>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* -------------------------------------------------------- guarantees */}
      <section className="ov-section">
        <h2>The guarantee that matters</h2>
        <div className="ov-guarantee">
          <p>
            An LLM handed thin data invents a plausible detail. &ldquo;Congrats on the Series
            A&rdquo; to someone who never raised is <strong>worse than sending nothing</strong> — it
            tells the recipient your data is wrong, while you are selling them your data.
          </p>
          <p>So verification is not a prompt instruction. It is code:</p>
          <ul>
            <li>Facts reach the writer as a closed set, passed by index.</li>
            <li>
              Every figure, date, name, and event in the output is checked against that set.
              Rounding is allowed; a new number is not.
            </li>
            <li>
              Two true facts may not be welded into a third claim. &ldquo;Raised $750M&rdquo; plus
              &ldquo;valued at $44B&rdquo; does not license &ldquo;raised at a $44B
              valuation&rdquo; unless one fact says so.
            </li>
            <li>
              Claims implying a relationship you do not have (&ldquo;great speaking last
              week&rdquo;) are blocked outright.
            </li>
            <li>
              Anything unresolved after one corrective retry <strong>downgrades</strong> to
              template_only. The endpoint never ships a claim it cannot trace.
            </li>
          </ul>
          <p className="ov-measured">
            Measured across two 10-case adversarial audits and a 20-run latency suite:{" "}
            <strong>zero unsupported claims</strong>, p95 6.9s warm.
          </p>
        </div>
      </section>

      {/* ------------------------------------------------------------ status */}
      <section className="ov-section">
        <h2>
          Live status{" "}
          <span className={healthOk ? "ov-pill ov-pill-live" : "ov-pill ov-pill-warn"}>
            {healthOk ? "all wired" : "attention"}
          </span>
        </h2>
        <p className="ov-sub">
          Read from <code>/api/health</code> at page load. Paid upstreams are checked for
          configuration only — a health check that spends credits is a bug.
        </p>
        <table className="ov-table">
          <thead>
            <tr>
              <th>Dependency</th>
              <th>Configured</th>
              <th>Reachable</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {deps.length === 0 && (
              <tr>
                <td colSpan={4}>Could not read /api/health.</td>
              </tr>
            )}
            {deps.map((d) => (
              <tr key={d.name}>
                <td>{d.name}</td>
                <td>{d.configured ? <span className="ov-ok">yes</span> : <span className="ov-no">no</span>}</td>
                <td>
                  {d.reachable === null ? (
                    <span className="ov-na">not probed</span>
                  ) : d.reachable ? (
                    <span className="ov-ok">yes</span>
                  ) : (
                    <span className="ov-no">no</span>
                  )}
                </td>
                <td className="ov-detail">{d.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* ------------------------------------------------------------- built */}
      <section className="ov-section">
        <h2>Built, and not built</h2>
        <div className="ov-two">
          <div>
            <h3>Done</h3>
            <ul className="ov-list">
              <li><code>POST /api/personalize/stream</code> — NDJSON stage events, all four triggers</li>
              <li><code>/demo</code> — live pipeline view, evidence cards, clipboard</li>
              <li>Evidence + confidence on every response (0.5 / 0.8 gates)</li>
              <li>Claim verification in code, one corrective retry, honest downgrade</li>
              <li>Shared investor / city / stage / repeat-founder ties</li>
              <li>Exa recency + career history, with a strict identity gate</li>
              <li>Neon cache (30d Fundable / 3d Exa) + request log with 90-day retention</li>
              <li>Bearer auth, per-key rate limit, internal-identity guard</li>
              <li>Offline tests for every deterministic gate (<code>npm test</code>)</li>
            </ul>
          </div>
          <div>
            <h3>Deliberately not yet</h3>
            <ul className="ov-list ov-list-muted">
              <li>
                <strong>Voice tuning</strong> — needs 10-20 of your real sent emails, or your
                <code> jacob voice</code> skill. The single thing that decides whether this is
                usable day to day.
              </li>
              <li>
                <strong>Real customer names</strong> in <code>sender_context</code> — the
                shared-investor tie is dormant in <code>default</code> until someone confirms which
                customers may be named in outbound.
              </li>
              <li>
                <strong>Lead-investor extraction</strong> — Fundable has no structured lead field; the
                lead exists only as prose. Quote it, or extract and accept the risk. Open decision.
              </li>
              <li>
                <strong>Async queue + webhooks</strong> — needed for sequencer volume, not for the
                demo or manual use.
              </li>
              <li>
                <strong>Sending anything.</strong> Not a milestone. This returns copy; a human
                sends it, and the n8n layer only ever creates drafts.
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- next steps */}
      <section className="ov-section">
        <h2>Next steps</h2>
        <p className="ov-sub">
          Roughly in order of value. The first two are inputs, not engineering.
        </p>
        <ol className="ov-next">
          <li>
            <strong>Tune the voice.</strong> 10-20 real sent emails, or the{" "}
            <code>jacob voice</code> skill. Right now the profile is inferred from LinkedIn posts,
            which is a different register, so the copy reads competent-generic rather than like a
            person. Everything else is polish next to this.
          </li>
          <li>
            <strong>Name the referenceable customers.</strong> Investor overlap is the strongest
            angle available and the one no competitor can produce, and it is switched off by
            default because naming a customer in outbound is a business decision, not a technical
            one. One list turns it on.
          </li>
          <li>
            <strong>Decide lead-investor handling.</strong> Quote the sentence Fundable already
            writes, or extract the fund names and accept the risk of naming the wrong lead.
          </li>
          <li>
            <strong>Wire it to n8n.</strong> Roughly an afternoon. Deal alert fires, this returns
            copy, a Gmail <em>draft</em> appears for review. That is the step where this stops
            being a demo. Nothing sends automatically, by design.
          </li>
          <li>
            <strong>Measure reply rate by angle.</strong> Every message logs which angle it used
            and how confident it was, so once volume exists the question &ldquo;does investor
            overlap actually beat a generic opener&rdquo; answers itself.
          </li>
          <li>
            <strong>Then decide whether it is a product.</strong> That measurement is the argument
            for making it customer-facing, and it is worth far more than any feature added before
            it exists.
          </li>
        </ol>
      </section>

      <footer className="ov-footer">
        <span>
          Voice profile <code>{voice.id}</code> · provenance{" "}
          <code>{voice.provenance}</code>
        </span>
        <Link href="/guide">How to use it →</Link>
      </footer>
    </main>
  );
}
