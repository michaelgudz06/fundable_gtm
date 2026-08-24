/**
 * Static index. This page used to be a 333-line live status board that called
 * checkHealth() on every public render — the home page was the DB poller, and
 * it advertised infrastructure state to anyone unauthenticated. Operational
 * status lives behind /api/health (auth'd, ?deep=1 for the DB probe); docs
 * live in the repo. A landing page for an internal API needs neither.
 */
export default function Home() {
  return (
    <main style={{ fontFamily: "ui-monospace, monospace", maxWidth: 640, margin: "4rem auto", padding: "0 1rem", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: "1.2rem" }}>Fundable Personalization API</h1>
      <p>
        Identity in — one ICP, use cases, and a plain-text email body out.
        Internal service; all endpoints require an API key.
      </p>
      <ul>
        <li><code>POST /api/v1/personalize</code> — the product (supports <code>stop_at</code>: linkedin | icp | email)</li>
        <li><code>POST /api/classify</code> — ICP label only, with reasoning</li>
        <li><code>GET /api/health</code> — liveness (<code>?deep=1</code> probes the database)</li>
      </ul>
      <p>Docs: <code>README.md</code> and <code>docs/TESTING.md</code> in the repo.</p>
    </main>
  );
}
