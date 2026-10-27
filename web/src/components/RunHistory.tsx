import type { RunSummary } from "../api";
import { STATUS_LABEL, timeAgo } from "../format";

interface Props {
  runs: RunSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function RunHistory({ runs, selectedId, onSelect }: Props) {
  return (
    <section className="card">
      <h2>Recent runs</h2>
      {runs.length === 0 ? (
        <p className="muted small">Runs you start appear here.</p>
      ) : (
        <ul className="history">
          {runs.map((run) => (
            <li key={run.id}>
              <button className={`history-item ${run.id === selectedId ? "selected" : ""}`} onClick={() => onSelect(run.id)}>
                <span className="history-title">{run.title}</span>
                <span className="history-meta">
                  <span className={`status status-${run.status}`}>{STATUS_LABEL[run.status]}</span>
                  <span className="muted small">{timeAgo(run.createdAt)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
