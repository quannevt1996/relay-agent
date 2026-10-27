import { useState } from "react";
import { api, type Connection } from "../api";
import { timeAgo } from "../format";

interface Props {
  connections: Connection[];
  onDisconnect: (provider: string) => Promise<void>;
}

export function ConnectionsPanel({ connections, onDisconnect }: Props) {
  const [busy, setBusy] = useState<string | null>(null);

  const disconnect = async (provider: string) => {
    setBusy(provider);
    try {
      await onDisconnect(provider);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card">
      <h2>Connections</h2>
      <ul className="connections">
        {connections.map((c) => (
          <li key={c.provider} className="connection">
            <div className="connection-head">
              <span className={`dot ${c.connected ? "dot-on" : "dot-off"}`} aria-hidden />
              <strong>{c.displayName}</strong>
              {c.mode === "demo" && <span className="pill pill-muted">demo</span>}
            </div>
            <p className="muted small">
              {c.connected
                ? `${c.accountName ?? "Connected"}${c.connectedAt ? `, ${timeAgo(c.connectedAt)}` : ""}`
                : c.setupHint ?? "Not connected"}
            </p>
            {c.connected && c.scopes.length > 0 && <p className="scopes">{c.scopes.join(" · ")}</p>}
            <div className="connection-actions">
              {c.connected ? (
                <button className="button button-quiet" disabled={busy === c.provider} onClick={() => disconnect(c.provider)}>
                  Disconnect
                </button>
              ) : (
                <a className={`button ${c.canConnect ? "" : "disabled"}`} href={c.canConnect ? api.connectUrl(c.provider) : undefined}>
                  Connect {c.displayName}
                </a>
              )}
            </div>
          </li>
        ))}
      </ul>
      <p className="muted small">Tokens are encrypted at rest and scoped to this workspace.</p>
    </section>
  );
}
