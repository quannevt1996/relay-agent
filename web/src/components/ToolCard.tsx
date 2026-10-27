import { useState } from "react";
import { formatMs } from "../format";
import type { ToolItem, ToolStatus } from "../trace";
import { Json } from "./Json";

const STATUS_TEXT: Record<ToolStatus, string> = {
  running: "running",
  awaiting_approval: "waiting for approval",
  approved: "approved, running",
  rejected: "declined",
  succeeded: "ok",
  failed: "error",
  not_run: "not run",
};

interface Props {
  item: ToolItem;
  onApprove: (toolUseId: string) => Promise<void>;
  onReject: (toolUseId: string, reason: string) => Promise<void>;
}

/** A human-readable view of what a write tool is about to do; the raw input is always shown too. */
function WritePreview({ tool, input }: { tool: string; input: Record<string, unknown> }) {
  if (tool === "slack_post_message") {
    return (
      <div className="preview">
        <div className="preview-meta">
          Post to <strong>{String(input.channel)}</strong>
          {input.thread_ts ? <> in thread {String(input.thread_ts)}</> : null}
        </div>
        <div className="preview-body">{String(input.text ?? "")}</div>
      </div>
    );
  }
  if (tool === "notion_create_page" || tool === "notion_append_to_page") {
    const creating = tool === "notion_create_page";
    return (
      <div className="preview">
        <div className="preview-meta">
          {creating ? (
            <>
              Create page <strong>{String(input.title)}</strong> under <code>{String(input.parent_page)}</code>
            </>
          ) : (
            <>
              Append to page <code>{String(input.page)}</code>
            </>
          )}
        </div>
        <div className="preview-body">{String(input.content ?? "")}</div>
      </div>
    );
  }
  return null;
}

export function ToolCard({ item, onApprove, onReject }: Props) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const awaiting = item.status === "awaiting_approval";
  const input = (item.input ?? {}) as Record<string, unknown>;

  const decide = async (approve: boolean) => {
    setBusy(true);
    try {
      await (approve ? onApprove(item.toolUseId) : onReject(item.toolUseId, reason.trim()));
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className={`event tool tool-${item.status} ${awaiting ? "approval" : ""}`}>
      <div className="event-head">
        <span className={`kind kind-${item.sideEffect ?? "unknown"}`}>{item.sideEffect ?? "unknown"}</span>
        <code className="tool-name">{item.tool}</code>
        <span className={`tool-status tool-status-${item.status}`}>{STATUS_TEXT[item.status]}</span>
        {item.durationMs !== undefined && item.status !== "rejected" && <span className="muted small">{formatMs(item.durationMs)}</span>}
      </div>

      {awaiting && (
        <div className="approval-box">
          <p className="approval-title">Approve this action? It runs with exactly this input.</p>
          <WritePreview tool={item.tool} input={input} />
          <Json value={item.input} label="Raw tool input" open={!["slack_post_message", "notion_create_page", "notion_append_to_page"].includes(item.tool)} />
          <div className="approval-actions">
            <input
              type="text"
              className="reason"
              placeholder="Reason for declining (optional, shown to the agent)"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button className="button button-danger" disabled={busy} onClick={() => decide(false)}>
              Decline
            </button>
            <button className="button button-primary" disabled={busy} onClick={() => decide(true)}>
              Approve
            </button>
          </div>
        </div>
      )}

      {!awaiting && <Json value={item.input} label="Input" />}
      {item.status === "rejected" && (
        <p className="muted small">Declined{item.rejectionReason ? `: “${item.rejectionReason}”` : ""}. The agent was told not to retry.</p>
      )}
      {item.status === "failed" && (
        <div className="tool-error">
          <p>{item.error}</p>
          {item.hint && <p className="muted small">Hint passed to the agent: {item.hint}</p>}
        </div>
      )}
      {item.status === "succeeded" && item.output !== undefined && <Json value={item.output} label="Output" />}
    </li>
  );
}
