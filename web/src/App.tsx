import { useCallback, useEffect, useState } from "react";
import { api, type Connection, type RunSummary, type Session, type Skill } from "./api";
import { ConnectionsPanel } from "./components/ConnectionsPanel";
import { NewRun } from "./components/NewRun";
import { RunHistory } from "./components/RunHistory";
import { RunView } from "./components/RunView";

interface Notice {
  kind: "ok" | "error";
  text: string;
}

const PROVIDERS: Record<string, string> = { slack: "Slack", notion: "Notion" };

// The server sends codes, not text; anything unknown gets a generic message,
// so a crafted link cannot make the app display arbitrary words.
const OAUTH_ERRORS: Record<string, string> = {
  access_denied: "access was declined on the consent screen.",
  authorization_failed: "the provider did not complete the authorization.",
  missing_code: "the provider's callback was missing its code or state.",
  invalid_state: "that sign-in link was already used or is unknown. Please try again.",
  expired_state: "the sign-in took longer than ten minutes. Please try again.",
  state_mismatch: "the sign-in was started from a different browser session.",
  not_configured: "OAuth client credentials are not configured on the server.",
  token_exchange_failed: "exchanging the authorization code failed. The server log has details.",
};

/** Reads ?connected= / ?oauth_error= left by the OAuth redirect, then removes them from the URL. */
function takeOAuthNotice(): Notice | null {
  const params = new URLSearchParams(window.location.search);
  const connected = PROVIDERS[params.get("connected") ?? ""];
  const error = params.get("oauth_error");
  if (!connected && !error) return null;
  window.history.replaceState(null, "", window.location.pathname);
  if (!error) return { kind: "ok", text: `Connected ${connected}.` };
  const provider = PROVIDERS[params.get("provider") ?? ""] ?? "the provider";
  return { kind: "error", text: `Could not connect ${provider}: ${OAUTH_ERRORS[error] ?? "the connection failed."}` };
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(takeOAuthNotice);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refreshRuns = useCallback(() => api.runs().then(setRuns).catch(() => {}), []);
  const refreshConnections = useCallback(() => api.connections().then(setConnections).catch(() => {}), []);

  useEffect(() => {
    // The session call comes first: it creates the workspace cookie the other calls rely on.
    api
      .session()
      .then(async (s) => {
        setSession(s);
        const [c, sk, r] = await Promise.all([api.connections(), api.skills(), api.runs()]);
        setConnections(c);
        setSkills(sk);
        setRuns(r);
        if (r[0]) setSelectedRunId((current) => current ?? r[0]!.id);
      })
      .catch((err: Error) => setLoadError(err.message));
  }, []);

  const startRun = async (request: Parameters<typeof api.createRun>[0]) => {
    const run = await api.createRun(request);
    setRuns((prev) => [run, ...prev]);
    setSelectedRunId(run.id);
  };

  const disconnect = async (provider: string) => {
    await api.disconnect(provider);
    await refreshConnections();
    setNotice({ kind: "ok", text: `Disconnected ${provider}.` });
  };

  if (loadError) {
    return (
      <div className="fatal">
        <h1>Relay</h1>
        <p>Could not reach the API: {loadError}</p>
        <p className="muted">Is the server running on port 8787?</p>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden>
            R
          </span>
          <span className="brand-name">Relay</span>
          <span className="tagline">Agent workflows across Slack and Notion</span>
        </div>
        {session && (
          <div className="badges">
            <span className={`badge ${session.connectorMode === "demo" ? "badge-demo" : "badge-live"}`}>
              {session.connectorMode === "demo" ? "Demo connectors" : "Live connectors"}
            </span>
            <span className={`badge ${session.model.scripted ? "badge-demo" : "badge-live"}`} title={session.model.id}>
              {session.model.scripted ? "Scripted demo model" : session.model.id}
            </span>
          </div>
        )}
      </header>

      {notice && (
        <div className={`notice notice-${notice.kind}`} role="status">
          <span>{notice.text}</span>
          <button className="link" onClick={() => setNotice(null)} aria-label="Dismiss">
            Dismiss
          </button>
        </div>
      )}

      {session?.model.scripted && (
        <p className="demo-note">
          No <code>ANTHROPIC_API_KEY</code> is set, so a scripted stand-in plays the model. It drives the real agent loop, tools and
          approvals for the bundled skills and a few phrasings; set a key to have Claude plan any request.
        </p>
      )}

      <div className="layout">
        <aside className="sidebar">
          <ConnectionsPanel connections={connections} onDisconnect={disconnect} />
          <RunHistory runs={runs} selectedId={selectedRunId} onSelect={setSelectedRunId} />
        </aside>

        <main className="main">
          <NewRun skills={skills} connections={connections} onStart={startRun} />
          {selectedRunId ? (
            <RunView
              key={selectedRunId}
              runId={selectedRunId}
              title={runs.find((r) => r.id === selectedRunId)?.title ?? null}
              onStatusChange={refreshRuns}
            />
          ) : (
            <section className="card empty">
              <h2>No runs yet</h2>
              <p className="muted">Pick a skill or ask for something above. Read steps run straight away; anything that posts or edits waits for you.</p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
