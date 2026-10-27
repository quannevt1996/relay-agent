import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "../db.js";
import { newId, nowIso } from "../lib/ids.js";
import { emptyUsage, type RunEvent, type RunStatus, type UsageTotals } from "../agent/events.js";

export interface PendingToolUse {
  id: string;
  name: string;
  input: unknown;
}

/** A model turn whose write tools are waiting on a human decision. */
export interface PendingApproval {
  /** Every tool_use block of the turn, in the order the model emitted them. */
  toolUses: PendingToolUse[];
  /** Results already produced for this turn (reads, validation errors). */
  results: Anthropic.Beta.BetaToolResultBlockParam[];
  awaiting: string[];
  decisions: Record<string, boolean>;
}

/** Everything needed to resume the agent loop, including after a restart. */
export interface RunState {
  system: string;
  toolNames: string[];
  messages: Anthropic.Beta.BetaMessageParam[];
  pending: PendingApproval | null;
}

export interface RunSummary {
  id: string;
  title: string;
  skillId: string | null;
  status: RunStatus;
  model: string;
  autoApprove: boolean;
  usage: UsageTotals;
  turns: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord extends RunSummary {
  workspaceId: string;
  state: RunState;
}

export interface StoredEvent {
  seq: number;
  event: RunEvent;
  createdAt: string;
}

interface Row {
  id: string;
  workspace_id: string;
  title: string;
  skill_id: string | null;
  status: RunStatus;
  model: string;
  auto_approve: number;
  state_json: string;
  usage_json: string;
  turns: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface NewRun {
  title: string;
  skillId: string | null;
  model: string;
  autoApprove: boolean;
  state: RunState;
}

export type RunPatch = Partial<Pick<RunRecord, "status" | "state" | "usage" | "turns" | "error">>;

export class RunStore {
  constructor(private readonly db: Db) {}

  create(workspaceId: string, run: NewRun): RunRecord {
    const id = newId("run");
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO runs (id, workspace_id, title, skill_id, status, model, auto_approve, state_json, usage_json, turns, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        workspaceId,
        run.title,
        run.skillId,
        run.model,
        run.autoApprove ? 1 : 0,
        JSON.stringify(run.state),
        JSON.stringify(emptyUsage()),
        now,
        now,
      );
    return this.get(workspaceId, id)!;
  }

  get(workspaceId: string, runId: string): RunRecord | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE workspace_id = ? AND id = ?").get(workspaceId, runId) as
      | Row
      | undefined;
    return row && toRecord(row);
  }

  list(workspaceId: string, limit = 50): RunSummary[] {
    const rows = this.db
      .prepare("SELECT * FROM runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(workspaceId, limit) as unknown as Row[];
    return rows.map((row) => {
      const { workspaceId: _ws, state: _state, ...summary } = toRecord(row);
      return summary;
    });
  }

  update(workspaceId: string, runId: string, patch: RunPatch): void {
    const columns: Record<string, string | number | null> = { updated_at: nowIso() };
    if (patch.status !== undefined) columns.status = patch.status;
    if (patch.state !== undefined) columns.state_json = JSON.stringify(patch.state);
    if (patch.usage !== undefined) columns.usage_json = JSON.stringify(patch.usage);
    if (patch.turns !== undefined) columns.turns = patch.turns;
    if (patch.error !== undefined) columns.error = patch.error;
    const names = Object.keys(columns);
    this.db
      .prepare(`UPDATE runs SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE workspace_id = ? AND id = ?`)
      .run(...Object.values(columns), workspaceId, runId);
  }

  appendEvent(runId: string, event: RunEvent): StoredEvent {
    const createdAt = nowIso();
    const { next } = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM run_events WHERE run_id = ?")
      .get(runId) as { next: number };
    this.db
      .prepare("INSERT INTO run_events (run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, next, event.type, JSON.stringify(event), createdAt);
    return { seq: next, event, createdAt };
  }

  /** Events are only reachable through a run the caller's workspace owns. */
  events(workspaceId: string, runId: string, afterSeq = 0): StoredEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.seq, e.payload_json, e.created_at FROM run_events e
         JOIN runs r ON r.id = e.run_id
         WHERE r.workspace_id = ? AND e.run_id = ? AND e.seq > ?
         ORDER BY e.seq`,
      )
      .all(workspaceId, runId, afterSeq) as { seq: number; payload_json: string; created_at: string }[];
    return rows.map((r) => ({ seq: r.seq, event: JSON.parse(r.payload_json) as RunEvent, createdAt: r.created_at }));
  }

  /** Runs that were mid-turn when the process died cannot be resumed safely. */
  failInterrupted(): number {
    const result = this.db
      .prepare("UPDATE runs SET status = 'failed', error = ?, updated_at = ? WHERE status = 'running'")
      .run("Interrupted by a server restart", nowIso());
    return Number(result.changes);
  }
}

function toRecord(row: Row): RunRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    skillId: row.skill_id,
    status: row.status,
    model: row.model,
    autoApprove: row.auto_approve === 1,
    state: JSON.parse(row.state_json) as RunState,
    usage: JSON.parse(row.usage_json) as UsageTotals,
    turns: row.turns,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
