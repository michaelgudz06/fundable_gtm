"use client";

/**
 * /review — the last thing that happens before an email reaches a person.
 *
 * Jacob's framing was "these will be sent to people." This is the surface that
 * makes that sentence survivable: nothing a sender can fetch has skipped this
 * page, because a sender may only read `approved` drafts.
 *
 * Deliberately plain. A reviewer is deciding yes/no on real copy addressed to a
 * named human, and the two things that help are seeing the whole body and
 * knowing when the classifier was unsure — so the vote split is shown next to
 * the label rather than buried.
 *
 * The key lives in component state ONLY, like /demo: no localStorage, no
 * cookie, so a refresh forgets it.
 */

import { useCallback, useEffect, useState } from "react";

type Draft = {
  id: string;
  created_at: string;
  recipient_email: string;
  recipient_name: string | null;
  company_name: string | null;
  message_type: string;
  icp: string;
  agreement: string | null;
  body_source: string | null;
  use_case_type: string | null;
  send_body: string;
  machine_body: string;
  edited: boolean;
  status: string;
};

type Tab = "pending_review" | "approved" | "rejected" | "sent";

export default function ReviewPage() {
  const [key, setKey] = useState("");
  const [authed, setAuthed] = useState(false);
  const [tab, setTab] = useState<Tab>("pending_review");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState("");

  const load = useCallback(
    async (status: Tab, bearer: string) => {
      setError(null);
      try {
        const res = await fetch(`/api/v1/drafts?status=${status}&limit=100`, {
          headers: { authorization: `Bearer ${bearer}` },
        });
        if (res.status === 401) {
          setAuthed(false);
          setError("That key was rejected.");
          return;
        }
        const json = (await res.json()) as { drafts?: Draft[]; error?: { message?: string } };
        if (!res.ok) {
          setError(json.error?.message ?? `HTTP ${res.status}`);
          return;
        }
        setDrafts(json.drafts ?? []);
        setAuthed(true);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    []
  );

  useEffect(() => {
    if (authed && key) void load(tab, key);
  }, [tab, authed, key, load]);

  async function decide(id: string, decision: "approve" | "reject" | "sent") {
    setBusy(id);
    setError(null);
    try {
      const edited = edits[id];
      const res = await fetch("/api/v1/drafts", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          id,
          decision,
          ...(reviewer ? { reviewed_by: reviewer } : {}),
          ...(edited && edited !== drafts.find((d) => d.id === id)?.send_body ? { edited_body: edited } : {}),
        }),
      });
      const json = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        setError(json.error?.message ?? `HTTP ${res.status}`);
        return;
      }
      setDrafts((prev) => prev.filter((d) => d.id !== id));
    } finally {
      setBusy(null);
    }
  }

  if (!authed) {
    return (
      <main style={S.gate}>
        <h1 style={S.h1}>Review queue</h1>
        <p style={S.muted}>
          Nothing here has been sent. A sender can only fetch drafts you approve.
        </p>
        <input
          style={S.input}
          type="password"
          placeholder="PERSONALIZE_API_KEY"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void load(tab, key)}
        />
        <button style={S.primary} onClick={() => void load(tab, key)}>
          Open queue
        </button>
        {error && <p style={S.error}>{error}</p>}
      </main>
    );
  }

  return (
    <main style={S.page}>
      <header style={S.header}>
        <div>
          <h1 style={S.h1}>Review queue</h1>
          <p style={S.muted}>
            {drafts.length} {tab.replace("_", " ")}
            {tab === "pending_review" && drafts.length > 0 ? " — none of these have been sent" : ""}
          </p>
        </div>
        <input
          style={{ ...S.input, width: 200, margin: 0 }}
          placeholder="your name (optional)"
          value={reviewer}
          onChange={(e) => setReviewer(e.target.value)}
        />
      </header>

      <nav style={S.tabs}>
        {(["pending_review", "approved", "rejected", "sent"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ ...S.tab, ...(t === tab ? S.tabOn : {}) }}
          >
            {t.replace("_", " ")}
          </button>
        ))}
      </nav>

      {error && <p style={S.error}>{error}</p>}
      {drafts.length === 0 && (
        <p style={S.muted}>
          {tab === "pending_review"
            ? "Queue is empty. Anything a sender picks up has been through here."
            : "Nothing here."}
        </p>
      )}

      {drafts.map((d) => {
        const value = edits[d.id] ?? d.send_body;
        const unsure = d.agreement && d.agreement !== "3/3" && d.agreement !== "2/2";
        return (
          <article key={d.id} style={S.card}>
            <div style={S.cardHead}>
              <div>
                <strong>{d.recipient_name ?? d.recipient_email}</strong>{" "}
                <span style={S.muted}>{d.recipient_email}</span>
                {d.company_name && <span style={S.muted}> · {d.company_name}</span>}
              </div>
              <div style={S.tags}>
                <span style={S.tag}>{d.icp}</span>
                <span style={S.tag}>{d.message_type}</span>
                {d.use_case_type && <span style={S.tag}>{d.use_case_type}</span>}
                {d.agreement && (
                  <span style={{ ...S.tag, ...(unsure ? S.tagWarn : {}) }}>
                    votes {d.agreement}
                  </span>
                )}
              </div>
            </div>

            {unsure && (
              <p style={S.warn}>
                The classifier nearly said something else about this person. Worth a closer read.
              </p>
            )}

            <textarea
              style={S.body}
              value={value}
              rows={Math.max(6, value.split("\n").length + 1)}
              onChange={(e) => setEdits((p) => ({ ...p, [d.id]: e.target.value }))}
              readOnly={tab !== "pending_review"}
            />
            {value !== d.machine_body && (
              <p style={S.muted}>Edited. The original stays on record.</p>
            )}

            {tab === "pending_review" && (
              <div style={S.actions}>
                <button
                  style={S.primary}
                  disabled={busy === d.id}
                  onClick={() => void decide(d.id, "approve")}
                >
                  Approve
                </button>
                <button
                  style={S.ghost}
                  disabled={busy === d.id}
                  onClick={() => void decide(d.id, "reject")}
                >
                  Reject
                </button>
              </div>
            )}
            {tab === "approved" && (
              <div style={S.actions}>
                <span style={S.muted}>Cleared to send.</span>
                <button style={S.ghost} disabled={busy === d.id} onClick={() => void decide(d.id, "sent")}>
                  Mark sent
                </button>
              </div>
            )}
          </article>
        );
      })}
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  page: { maxWidth: 820, margin: "0 auto", padding: "32px 20px 80px", fontFamily: "ui-sans-serif, system-ui, sans-serif" },
  gate: { maxWidth: 420, margin: "12vh auto", padding: 20, fontFamily: "ui-sans-serif, system-ui, sans-serif" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, marginBottom: 16 },
  h1: { fontSize: 22, margin: "0 0 4px" },
  muted: { color: "#6b7280", fontSize: 13, margin: "4px 0" },
  error: { color: "#b91c1c", fontSize: 13 },
  warn: { color: "#92400e", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "6px 10px", fontSize: 13, margin: "0 0 10px" },
  input: { display: "block", width: "100%", padding: "9px 11px", margin: "10px 0", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 14 },
  primary: { padding: "9px 16px", background: "#111827", color: "#fff", border: 0, borderRadius: 6, fontSize: 14, cursor: "pointer" },
  ghost: { padding: "9px 16px", background: "#fff", color: "#374151", border: "1px solid #d1d5db", borderRadius: 6, fontSize: 14, cursor: "pointer" },
  tabs: { display: "flex", gap: 6, marginBottom: 18, borderBottom: "1px solid #e5e7eb", paddingBottom: 10 },
  tab: { padding: "6px 12px", background: "transparent", border: 0, borderRadius: 6, fontSize: 13, color: "#6b7280", cursor: "pointer" },
  tabOn: { background: "#111827", color: "#fff" },
  card: { border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, marginBottom: 14 },
  cardHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 10, flexWrap: "wrap" },
  tags: { display: "flex", gap: 6, flexWrap: "wrap" },
  tag: { fontSize: 11, background: "#f3f4f6", color: "#374151", padding: "3px 8px", borderRadius: 999 },
  tagWarn: { background: "#fef3c7", color: "#92400e" },
  body: { width: "100%", padding: 12, border: "1px solid #e5e7eb", borderRadius: 8, fontSize: 14, lineHeight: 1.6, fontFamily: "inherit", resize: "vertical" },
  actions: { display: "flex", gap: 8, alignItems: "center", marginTop: 12 },
};
