"use client";

/**
 * /demo — the live pitch surface (spec §4). Three panels:
 *   left    request builder (+ presets that are known to resolve well)
 *   center  the pipeline streaming as it happens — the money shot
 *   right   result: status, confidence vs the 0.5/0.8 gates, copy, evidence
 *
 * Internal page behind the same bearer key. The key lives in component state
 * ONLY — no localStorage, no cookie — so a page refresh forgets it (spec §4).
 * Copy-only by design: the UI ends at the clipboard. No sending, no drafts.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Wire types (mirrors of the API contract; kept local so the page has no
// server-code imports and stays a pure client bundle).
// ---------------------------------------------------------------------------

type StageEvent = {
  t: number;
  stage: string;
  status: "start" | "done" | "skipped" | "retry" | "error";
  detail?: string;
  response?: PersonalizeResponse;
};

type Evidence = {
  fact: string;
  source: string;
  endpoint?: string;
  url?: string;
  confidence: number;
};

type PersonalizeResponse = {
  status: "personalized" | "template_only" | "no_match";
  confidence: number;
  subject: string | null;
  body: string | null;
  angle: string | null;
  evidence: Evidence[];
  resolved: {
    person_id: string | null;
    company_id: string | null;
    company: string | null;
    domain: string | null;
  };
  warnings: string[];
  usage: { fundable_credits: number; exa_cost_usd: number; llm_tokens: number; ms: number };
};

type Meta = {
  sender_contexts: string[];
  voice: { id: string; provenance: string; warning: string | null };
  triggers_implemented: string[];
};

const TRIGGERS = ["post-raise", "sign-up", "website-visitor", "cold"] as const;
const CHANNELS = ["email", "linkedin"] as const;

// Presets that resolve well and are already warm in the cache, so the demo
// never opens cold (spec §4: "known to resolve well").
const PRESETS: { label: string; email: string; linkedin?: string }[] = [
  { label: "Ramp — fresh Series F", email: "eric@ramp.com", linkedin: "https://www.linkedin.com/in/eglyman" },
  { label: "Anthropic — Series H", email: "someone@anthropic.com" },
  { label: "Figma — 2024 raise", email: "someone@figma.com" },
];

const DOT: Record<StageEvent["status"], string> = {
  start: "◌",
  done: "●",
  skipped: "◦",
  retry: "↻",
  error: "✕",
};

// ---------------------------------------------------------------------------
// Sample mode — canned data so the UI can be seen (and was verified) without a
// key. Loudly labeled; grants no API access. The payload below is a REAL run
// captured on 2026-07-29 (ramp.com), so what it shows is what live looks like.
// ---------------------------------------------------------------------------

const SAMPLE_EVENTS: StageEvent[] = [
  { t: 0, stage: "resolve", status: "start", detail: "Resolving ramp.com + https://www.linkedin.com/in/eglyman" },
  { t: 427, stage: "resolve", status: "done", detail: "ramp.com → Ramp (series f, 2026-06-04) · LinkedIn → Eric Glyman, Co-Founder, CEO (cache hit, 0 credits)" },
  { t: 428, stage: "enrich", status: "done", detail: "5 prospect facts from Fundable + 2 sender facts" },
  { t: 428, stage: "tie", status: "skipped", detail: "investor-overlap ties ship in M3" },
  { t: 428, stage: "angle", status: "start", detail: "picking one angle from 5 facts (max 3)" },
  { t: 1985, stage: "angle", status: "done", detail: "the_raise (3 facts)" },
  { t: 1985, stage: "write", status: "start", detail: "drafting the email in Jacob's voice" },
  { t: 3534, stage: "write", status: "done", detail: '56 words, subject "ramp\'s series f"' },
  { t: 3534, stage: "verify", status: "done", detail: "clean — every claim traces to evidence (0 advisory notes)" },
  { t: 3534, stage: "done", status: "done", detail: "personalized — every claim verified against evidence" },
];

const SAMPLE_RESPONSE: PersonalizeResponse = {
  status: "personalized",
  confidence: 0.9,
  subject: "ramp's series f",
  body: "Hi Eric,\n\nRamp raised a $750M Series F at a $44B valuation on June 4.\n\nFundable tracks rounds in real time, so our customers get alerts the day a deal closes.\n\nWorth a look at fundable.ai?\n\nJacob",
  angle: "the_raise",
  evidence: [
    { fact: "Ramp raised a series f round of $750M at a $44B valuation on 2026-06-04.", source: "fundable", endpoint: "/companies", confidence: 1 },
    { fact: "Ramp, a corporate spend and finance infrastructure platform, raised $750 million in a Series F at a $44 billion valuation led by ICONIQ, GIC, and Ontario Teachers' Pension Plan.", source: "fundable", endpoint: "/companies", confidence: 1 },
    { fact: "Eric Glyman is Co-Founder, CEO at Ramp.", source: "fundable", endpoint: "/people", confidence: 0.9 },
    { fact: "Fundable (fundable.ai) tracks startup funding rounds, investors, and people in real time, for VCs, founders, and GTM teams.", source: "sender_context", confidence: 1 },
  ],
  resolved: { person_id: "48153d29-…", company_id: "f4a7c292-…", company: "Ramp", domain: "ramp.com" },
  warnings: ["Voice profile is a placeholder adapted from LinkedIn posts, not tuned on real sent emails. Review copy before sending."],
  usage: { fundable_credits: 0, exa_cost_usd: 0, llm_tokens: 1707, ms: 3604 },
};

const SAMPLE_META: Meta = {
  sender_contexts: ["default"],
  voice: {
    id: "jacob",
    provenance: "placeholder",
    warning: "Voice profile is a placeholder adapted from LinkedIn posts, not tuned on real sent emails. Review copy before sending.",
  },
  triggers_implemented: ["post-raise"],
};

// ---------------------------------------------------------------------------

export default function DemoPage() {
  // -- auth gate (memory only) --
  const [key, setKey] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [gateError, setGateError] = useState<string | null>(null);
  const [meta, setMeta] = useState<Meta | null>(null);

  // -- request builder --
  const [email, setEmail] = useState(PRESETS[0]!.email);
  const [linkedin, setLinkedin] = useState(PRESETS[0]!.linkedin ?? "");
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<(typeof TRIGGERS)[number]>("post-raise");
  const [channel, setChannel] = useState<(typeof CHANNELS)[number]>("email");
  const [useTemplate, setUseTemplate] = useState(false);
  const [template, setTemplate] = useState(
    "Hi {{first_name}},\n\n{{opener}}\n\nWe help GTM teams reach companies right after they raise.\n\nWorth a quick look?\n\nJacob"
  );
  const [senderContext, setSenderContext] = useState("default");
  const [maxFacts, setMaxFacts] = useState(3);

  // -- run state --
  const [sampleMode, setSampleMode] = useState(false);
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<StageEvent[]>([]);
  const [result, setResult] = useState<PersonalizeResponse | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  const startedAt = useRef<number>(0);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setElapsed(Date.now() - startedAt.current), 100);
    return () => clearInterval(id);
  }, [running]);

  const unlock = useCallback(async () => {
    const candidate = keyDraft.trim();
    if (!candidate) return;
    setGateError(null);

    // Shape check before spending a round-trip. Four keys live in this project's
    // .env and only one of them opens this door, so "Invalid bearer token" is a
    // uselessly vague thing to say when the paste is recognisably a different
    // key. Prefix matching only — nothing is logged or sent anywhere.
    const MISTAKEN: { prefix: string; name: string; role: string }[] = [
      { prefix: "vg_", name: "Fundable API key", role: "the server calls Fundable itself using the value in .env" },
      { prefix: "sk-or-v1-", name: "OpenRouter key", role: "the server calls OpenRouter itself using the value in .env" },
      { prefix: "sb_secret_", name: "Supabase secret key", role: "the server uses it for the cache and request log" },
      { prefix: "sb_publishable_", name: "Supabase publishable key", role: "not used by this demo at all" },
    ];
    const mistake = MISTAKEN.find((m) => candidate.startsWith(m.prefix));
    if (mistake) {
      setGateError(
        `That looks like your ${mistake.name} — ${mistake.role}. This gate wants PERSONALIZE_API_KEY, which is this API's own bearer key (a 64-character hex string). Get it with: grep '^PERSONALIZE_API_KEY=' .env | cut -d= -f2`
      );
      return;
    }

    try {
      const res = await fetch("/api/meta", { headers: { Authorization: `Bearer ${candidate}` } });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setGateError(j?.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      setMeta((await res.json()) as Meta);
      setKey(candidate);
      setKeyDraft("");
    } catch (err) {
      setGateError(err instanceof Error ? err.message : "Could not reach the API.");
    }
  }, [keyDraft]);

  const run = useCallback(async () => {
    if (!key || running) return;
    setRunning(true);
    setEvents([]);
    setResult(null);
    setCopied(null);
    setElapsed(0);
    startedAt.current = Date.now();

    const body = {
      person: {
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(linkedin.trim() ? { linkedin: linkedin.trim() } : {}),
        ...(name.trim() ? { name: name.trim() } : {}),
      },
      trigger,
      channel,
      ...(useTemplate && template.trim() ? { template } : {}),
      sender_context: senderContext,
      max_facts: maxFacts,
    };

    try {
      const res = await fetch("/api/personalize/stream", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        setEvents([
          {
            t: 0,
            stage: "error",
            status: "error",
            detail: j?.error?.message ?? `HTTP ${res.status}`,
          },
        ]);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as StageEvent;
          if (event.response) {
            setResult(event.response);
          } else {
            setEvents((prev) => [...prev, event]);
          }
        }
      }
    } catch (err) {
      setEvents((prev) => [
        ...prev,
        {
          t: Date.now() - startedAt.current,
          stage: "error",
          status: "error",
          detail: err instanceof Error ? err.message : "stream failed",
        },
      ]);
    } finally {
      setRunning(false);
      setElapsed(Date.now() - startedAt.current);
    }
  }, [key, running, email, linkedin, name, trigger, channel, useTemplate, template, senderContext, maxFacts]);

  const copyText = useCallback((label: string, text: string) => {
    const flash = (value: string) => {
      setCopied(value);
      setTimeout(() => setCopied(null), 1500);
    };
    void navigator.clipboard
      .writeText(text)
      .then(() => flash(label))
      .catch(() => {
        // Embedded webviews and older setups deny the async clipboard API.
        // The selection+execCommand path still works there; if even that
        // fails, say so rather than silently doing nothing.
        try {
          const ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand("copy");
          document.body.removeChild(ta);
          flash(ok ? label : `${label}-failed`);
        } catch {
          flash(`${label}-failed`);
        }
      });
  }, []);

  const enterSample = () => {
    setSampleMode(true);
    setMeta(SAMPLE_META);
    setEvents(SAMPLE_EVENTS);
    setResult(SAMPLE_RESPONSE);
  };

  // ------------------------------------------------------------- key gate --
  if (!key && !sampleMode) {
    return (
      <div className="demo-shell">
        <div className="demo-gate demo-panel">
          <h2>Personalization API — demo</h2>
          <p>
            Internal tool. Paste <code>PERSONALIZE_API_KEY</code>{" "}
            — this API&apos;s own bearer key, a 64-character hex string. <strong>Not</strong> your
            Fundable, OpenRouter, or Supabase key: the server calls those itself using the values in{" "}
            <code>.env</code>. Held in memory only, so a refresh forgets it.
          </p>
          <input
            className="demo-input"
            type="password"
            placeholder="bearer key"
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void unlock()}
            autoFocus
          />
          <button className="demo-run" style={{ marginTop: 10 }} onClick={() => void unlock()}>
            Unlock
          </button>
          {gateError && <div className="demo-error">{gateError}</div>}
          <p style={{ marginTop: 14, marginBottom: 0 }}>
            No key handy?{" "}
            <a
              href="#sample"
              onClick={(e) => {
                e.preventDefault();
                enterSample();
              }}
            >
              View the UI with sample data
            </a>{" "}
            — a captured real run, no live API access.
          </p>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------- main --
  return (
    <div className="demo-shell">
      <header className="demo-header">
        <h1>Fundable Personalization API</h1>
        <span className="demo-sub">
          person + trigger in → verified copy + evidence out · copy-only demo
        </span>
      </header>

      {sampleMode && (
        <div className="demo-voicewarn" style={{ borderColor: "var(--accent)" }}>
          <strong>SAMPLE DATA</strong>
          <span>
            This is a captured run (ramp.com, 2026-07-29), not live output. Refresh and enter the
            key to run the real pipeline.
          </span>
        </div>
      )}

      {meta?.voice.warning && (
        <div className="demo-voicewarn">
          <strong>voice: {meta.voice.provenance}</strong>
          <span>{meta.voice.warning}</span>
        </div>
      )}

      <div className="demo-grid">
        {/* ------------------------------------------------ request builder */}
        <section className="demo-panel">
          <h2>Request</h2>

          <div className="demo-presets">
            {PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => {
                  setEmail(p.email);
                  setLinkedin(p.linkedin ?? "");
                  setTrigger("post-raise");
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="demo-field">
            <label>email</label>
            <input className="demo-input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="eric@ramp.com" />
          </div>
          <div className="demo-field">
            <label>linkedin url</label>
            <input className="demo-input" value={linkedin} onChange={(e) => setLinkedin(e.target.value)} placeholder="https://www.linkedin.com/in/…" />
          </div>
          <div className="demo-field">
            <label>name (optional)</label>
            <input className="demo-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Eric Glyman" />
          </div>

          <div className="demo-field">
            <label>trigger</label>
            <div className="demo-seg">
              {TRIGGERS.map((t) => {
                const implemented = meta?.triggers_implemented.includes(t) ?? t === "post-raise";
                return (
                  <button key={t} className={trigger === t ? "demo-on" : ""} onClick={() => setTrigger(t)}>
                    {t}
                    {!implemented && <span className="demo-hint">M3</span>}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="demo-field">
            <label>channel</label>
            <div className="demo-seg">
              {CHANNELS.map((c) => (
                <button key={c} className={channel === c ? "demo-on" : ""} onClick={() => setChannel(c)}>
                  {c}
                </button>
              ))}
            </div>
          </div>

          <label className="demo-check">
            <input type="checkbox" checked={useTemplate} onChange={(e) => setUseTemplate(e.target.checked)} />
            use my template
          </label>
          {useTemplate && (
            <div className="demo-field">
              <textarea className="demo-textarea" value={template} onChange={(e) => setTemplate(e.target.value)} />
            </div>
          )}

          <div className="demo-field">
            <label>sender context</label>
            <select className="demo-select" value={senderContext} onChange={(e) => setSenderContext(e.target.value)}>
              {(meta?.sender_contexts.length ? meta.sender_contexts : ["default"]).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>

          <div className="demo-field">
            <label>max facts</label>
            <div className="demo-seg">
              {[1, 2, 3].map((n) => (
                <button key={n} className={maxFacts === n ? "demo-on" : ""} onClick={() => setMaxFacts(n)}>
                  {n}
                </button>
              ))}
            </div>
          </div>

          <button
            className="demo-run"
            disabled={sampleMode || running || (!email.trim() && !linkedin.trim())}
            onClick={() => void run()}
            title={sampleMode ? "Sample mode has no API access — refresh and enter the key to run live." : undefined}
          >
            {sampleMode ? "Sample mode (no API access)" : running ? "Running…" : "Personalize"}
          </button>
        </section>

        {/* ------------------------------------------------------- pipeline */}
        <section className="demo-panel">
          <h2>Pipeline</h2>
          <div className="demo-log">
            {events.length === 0 && !running && (
              <div className="demo-log-empty">
                Pick a preset and hit Personalize. Each stage streams here as it runs — resolution,
                enrichment, angle selection, the write, and the claim check.
              </div>
            )}
            {events.map((e, i) => {
              const prev = i > 0 ? events[i - 1]!.t : 0;
              return (
                <div key={i} className={`demo-event demo-ev-${e.status}`}>
                  <span className="demo-dot">{DOT[e.status]}</span>
                  <span className="demo-stage">{e.stage}</span>
                  <span className="demo-detail">{e.detail}</span>
                  <span className="demo-chip">+{((e.t - prev) / 1000).toFixed(2)}s</span>
                </div>
              );
            })}
            {running && (
              <div className="demo-event demo-ev-start">
                <span className="demo-dot demo-live">●</span>
                <span className="demo-stage" />
                <span className="demo-detail" style={{ color: "var(--ink-3)" }}>
                  working…
                </span>
                <span className="demo-chip">{(elapsed / 1000).toFixed(1)}s</span>
              </div>
            )}
            {(events.length > 0 || result) && !running && (
              <div className="demo-total">
                <span>total elapsed</span>
                <span>{((result?.usage.ms ?? elapsed) / 1000).toFixed(2)}s</span>
              </div>
            )}
          </div>
        </section>

        {/* --------------------------------------------------------- result */}
        <section className="demo-panel">
          <h2>Result</h2>
          {!result && <div className="demo-result-empty">The finished message, its evidence, and the audit trail land here.</div>}

          {result && (
            <>
              <div className="demo-status">
                <span className={`demo-badge demo-st-${result.status}`}>
                  <span className="demo-badge-dot" />
                  {result.status}
                </span>
                {result.angle && <span className="demo-chip">angle: {result.angle}</span>}
                {result.resolved.company && <span className="demo-chip">{result.resolved.company}</span>}
              </div>

              <ConfidenceMeter value={result.confidence} />

              {result.status === "personalized" ? (
                <>
                  {result.subject !== null && (
                    <div className="demo-copyblock">
                      <div className="demo-copylabel">subject</div>
                      <pre className="demo-subject">{result.subject}</pre>
                      <button className="demo-copybtn" onClick={() => copyText("subject", result.subject ?? "")}>
                        {copied === "subject" ? "copied" : copied === "subject-failed" ? "copy failed" : "copy"}
                      </button>
                    </div>
                  )}
                  <div className="demo-copyblock">
                    <div className="demo-copylabel">body</div>
                    <pre>{result.body}</pre>
                    <button className="demo-copybtn" onClick={() => copyText("body", result.body ?? "")}>
                      {copied === "body" ? "copied" : copied === "body-failed" ? "copy failed" : "copy"}
                    </button>
                  </div>
                </>
              ) : (
                <div className="demo-honest">
                  {result.status === "no_match"
                    ? "Nothing matched in Fundable — no personalization was attempted."
                    : "No verifiable angle found — returning your template untouched."}
                  {result.body ? (
                    <div className="demo-copyblock" style={{ marginTop: 10 }}>
                      <div className="demo-copylabel">your template, untouched</div>
                      <pre>{result.body}</pre>
                      <button className="demo-copybtn" onClick={() => copyText("body", result.body ?? "")}>
                        {copied === "body" ? "copied" : copied === "body-failed" ? "copy failed" : "copy"}
                      </button>
                    </div>
                  ) : (
                    <div style={{ marginTop: 8, fontStyle: "italic" }}>No template was supplied, so there is nothing to send.</div>
                  )}
                </div>
              )}

              {result.evidence.length > 0 && (
                <>
                  <h2 style={{ marginTop: 16 }}>Evidence</h2>
                  <div className="demo-evidence">
                    {result.evidence.map((ev, i) => (
                      <div key={i} className="demo-card">
                        <div className="demo-fact">{ev.fact}</div>
                        <div className="demo-cardmeta">
                          <span className={`demo-source demo-src-${ev.source}`}>{ev.source.replace("_context", "")}</span>
                          {ev.endpoint && <span>{ev.endpoint}</span>}
                          <span>conf {ev.confidence.toFixed(2)}</span>
                          {ev.url && (
                            <a href={ev.url} target="_blank" rel="noreferrer">
                              source ↗
                            </a>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {result.warnings.length > 0 && (
                <>
                  <h2>Warnings</h2>
                  <ul className="demo-warnings">
                    {result.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </>
              )}

              <div className="demo-usage">
                <div className="demo-stat">
                  <div className="demo-stat-v">{result.usage.fundable_credits}</div>
                  <div className="demo-stat-k">fundable credits</div>
                </div>
                <div className="demo-stat">
                  <div className="demo-stat-v">${result.usage.exa_cost_usd.toFixed(3)}</div>
                  <div className="demo-stat-k">exa cost</div>
                </div>
                <div className="demo-stat">
                  <div className="demo-stat-v">{result.usage.llm_tokens.toLocaleString()}</div>
                  <div className="demo-stat-k">llm tokens</div>
                </div>
                <div className="demo-stat">
                  <div className="demo-stat-v">{(result.usage.ms / 1000).toFixed(2)}s</div>
                  <div className="demo-stat-k">latency</div>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Thin single-hue bar with the PRD's behavioural thresholds (0.5 template gate,
 * 0.8 full personalization) as labeled ticks. Value is text, not color.
 */
function ConfidenceMeter({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="demo-meter">
      <div style={{ display: "flex", alignItems: "center", marginBottom: 4 }}>
        <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.07em", color: "var(--ink-3)" }}>
          confidence
        </span>
        <span className="demo-meter-value">{value.toFixed(2)}</span>
      </div>
      <div className="demo-meter-track">
        <div className="demo-meter-fill" style={{ width: `${pct}%` }} />
        <div className="demo-meter-tick" style={{ left: "50%" }} />
        <div className="demo-meter-tick" style={{ left: "80%" }} />
      </div>
      <div className="demo-meter-labels">
        <span style={{ left: "50%" }}>0.5 template gate</span>
        <span style={{ left: "80%" }}>0.8 full</span>
      </div>
    </div>
  );
}
