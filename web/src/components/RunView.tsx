import { useEffect, useRef, useState } from "react";
import { api, type RunEvent } from "../api";
import { formatCost, formatMs, formatTokens, STATUS_LABEL } from "../format";
import { applyEvent, initialTrace, pendingApprovals, type TraceState, type TurnItem } from "../trace";
import { ToolCard } from "./ToolCard";

interface Props {
  runId: string;
  title: string | null;
  /** Called whenever the run's status changes, so the history list stays current. */
  onStatusChange: () => void;
}

function TurnCard({ item }: { item: TurnItem }) {
  return (
    <li className="event turn">
      <div className="event-head">
        <span className="kind kind-model">model</span>
        <span>Turn {item.turn}</span>
        {!item.stats && <span className="spinner" aria-label="thinking" />}
      </div>
      {item.progress.map((note, i) => (
        <p key={i} className="progress">
          {note}
        </p>
      ))}
      {item.text && !item.isAnswer && <p className="turn-text">{item.text}</p>}
      {item.isAnswer && <p className="muted small">Final answer below.</p>}
      {item.stats && (
        <div className="stats-line">
          <span>{formatMs(item.stats.durationMs)}</span>
          <span>
            {formatTokens(item.stats.usage.inputTokens)} in / {formatTokens(item.stats.usage.outputTokens)} out
          </span>
          {item.stats.usage.cacheReadInputTokens > 0 && <span>{formatTokens(item.stats.usage.cacheReadInputTokens)} cached</span>}
          <span>{formatCost(item.stats.costUsd)}</span>
          {item.stats.stopReason && <span className="muted">{item.stats.stopReason}</span>}
        </div>
      )}
    </li>
  );
}

export function RunView({ runId, title, onStatusChange }: Props) {
  const [trace, setTrace] = useState<TraceState>(initialTrace);
  const [connectionLost, setConnectionLost] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const statusRef = useRef(trace.status);

  useEffect(() => {
    setTrace(initialTrace());
    // EventSource reconnects on its own and sends Last-Event-ID, so the server
    // resumes the replay where it left off.
    const source = new EventSource(api.eventsUrl(runId));
    source.onopen = () => setConnectionLost(false);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as RunEvent;
      setTrace((state) => applyEvent(state, event));
      if (event.type === "done") source.close();
    };
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED) setConnectionLost(true);
    };
    return () => source.close();
  }, [runId]);

  useEffect(() => {
    if (trace.status && trace.status !== statusRef.current) onStatusChange();
    statusRef.current = trace.status;
  }, [trace.status, onStatusChange]);

  const act = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const waiting = pendingApprovals(trace);
  const { totalUsage } = trace;

  return (
    <section className="card run">
      <div className="run-head">
        <div>
          <h2>{title ?? trace.prompt ?? "Run"}</h2>
          {trace.prompt && trace.skillId && <p className="small">Extra instructions: {trace.prompt}</p>}
          <p className="muted small">
            {trace.model ?? "…"}
            {trace.autoApprove && " · writes auto-approved"}
          </p>
        </div>
        <div className="run-actions">
          {trace.status && <span className={`status status-${trace.status}`}>{STATUS_LABEL[trace.status]}</span>}
          {trace.status && !trace.done && (
            <button className="button button-quiet" onClick={() => act(() => api.cancel(runId))}>
              Cancel
            </button>
          )}
        </div>
      </div>

      <div className="totals">
        <div>
          <span className="total-value">{trace.items.filter((i) => i.kind === "turn").length}</span>
          <span className="total-label">model turns</span>
        </div>
        <div>
          <span className="total-value">{trace.items.filter((i) => i.kind === "tool").length}</span>
          <span className="total-label">tool calls</span>
        </div>
        <div>
          <span className="total-value">
            {formatTokens(totalUsage.inputTokens + totalUsage.cacheReadInputTokens + totalUsage.cacheCreationInputTokens)}
          </span>
          <span className="total-label">input tokens{totalUsage.cacheReadInputTokens > 0 ? ` (${formatTokens(totalUsage.cacheReadInputTokens)} cached)` : ""}</span>
        </div>
        <div>
          <span className="total-value">{formatTokens(totalUsage.outputTokens)}</span>
          <span className="total-label">output tokens</span>
        </div>
        <div>
          <span className="total-value">{formatMs(trace.totalModelMs)}</span>
          <span className="total-label">model time</span>
        </div>
        <div>
          <span className="total-value">{formatCost(trace.totalCostUsd)}</span>
          <span className="total-label">est. cost</span>
        </div>
      </div>

      {waiting.length > 0 && (
        <p className="approval-banner">
          {waiting.length === 1 ? "1 action is" : `${waiting.length} actions are`} waiting for your approval. The run is paused until you decide.
        </p>
      )}
      {connectionLost && <p className="warning small">Lost the event stream; reconnecting…</p>}
      {actionError && <p className="error small">{actionError}</p>}

      <ol className="timeline">
        {trace.items.map((item) =>
          item.kind === "turn" ? (
            <TurnCard key={`turn-${item.turn}`} item={item} />
          ) : (
            <ToolCard
              key={item.toolUseId}
              item={item}
              onApprove={(id) => act(() => api.approve(runId, id))}
              onReject={(id, reason) => act(() => api.reject(runId, id, reason || undefined))}
            />
          ),
        )}
      </ol>

      {trace.answer && (
        <div className="answer">
          <h3>Answer</h3>
          <p>{trace.answer}</p>
        </div>
      )}
      {trace.error && (
        <div className="run-error">
          <h3>Run {trace.status === "cancelled" ? "cancelled" : "failed"}</h3>
          <p>{trace.error}</p>
        </div>
      )}
      {trace.status === "cancelled" && !trace.error && <p className="muted">This run was cancelled.</p>}
    </section>
  );
}
