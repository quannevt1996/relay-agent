import type { RunEvent, RunStatus, SideEffect, Usage } from "./api";

/**
 * Folds the run's event stream into what the timeline renders. Pure, so the
 * same function handles live events, a replay after reload, and tests.
 */

export interface TurnItem {
  kind: "turn";
  turn: number;
  /** Streamed deltas until the turn's final text arrives, then the final text. */
  text: string;
  textFinal: boolean;
  progress: string[];
  stats: { durationMs: number; usage: Usage; costUsd: number | null; stopReason: string | null } | null;
  /** True for the turn whose text is the run's final answer (shown separately). */
  isAnswer: boolean;
}

export type ToolStatus = "running" | "awaiting_approval" | "approved" | "rejected" | "succeeded" | "failed";

export interface ToolItem {
  kind: "tool";
  turn: number;
  toolUseId: string;
  tool: string;
  input: unknown;
  sideEffect: SideEffect | null;
  needsApproval: boolean;
  status: ToolStatus;
  output?: unknown;
  error?: string;
  hint?: string;
  durationMs?: number;
  rejectionReason?: string;
}

export type TraceItem = TurnItem | ToolItem;

export interface TraceState {
  status: RunStatus | null;
  prompt: string | null;
  skillId: string | null;
  model: string | null;
  autoApprove: boolean;
  items: TraceItem[];
  totalUsage: Usage;
  totalCostUsd: number | null;
  totalModelMs: number;
  answer: string | null;
  error: string | null;
  done: boolean;
}

export const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });

export const initialTrace = (): TraceState => ({
  status: null,
  prompt: null,
  skillId: null,
  model: null,
  autoApprove: false,
  items: [],
  totalUsage: emptyUsage(),
  totalCostUsd: null,
  totalModelMs: 0,
  answer: null,
  error: null,
  done: false,
});

function updateTurn(state: TraceState, turn: number, update: (item: TurnItem) => TurnItem): TraceState {
  const exists = state.items.some((i) => i.kind === "turn" && i.turn === turn);
  const items = exists
    ? state.items
    : [...state.items, { kind: "turn", turn, text: "", textFinal: false, progress: [], stats: null, isAnswer: false } satisfies TurnItem];
  return { ...state, items: items.map((i) => (i.kind === "turn" && i.turn === turn ? update(i) : i)) };
}

function updateTool(state: TraceState, toolUseId: string, update: (item: ToolItem) => ToolItem): TraceState {
  return { ...state, items: state.items.map((i) => (i.kind === "tool" && i.toolUseId === toolUseId ? update(i) : i)) };
}

export function applyEvent(state: TraceState, event: RunEvent): TraceState {
  switch (event.type) {
    case "run_started":
      return { ...state, prompt: event.prompt, skillId: event.skillId, model: event.model, autoApprove: event.autoApprove };
    case "status":
      return { ...state, status: event.status };
    case "turn_started":
      return updateTurn(state, event.turn, (t) => t);
    case "text_delta":
      return updateTurn(state, event.turn, (t) => (t.textFinal ? t : { ...t, text: t.text + event.delta }));
    case "text":
      // The final text replaces the streamed deltas (and survives a reload, which deltas do not).
      return updateTurn(state, event.turn, (t) => ({
        ...t,
        text: t.textFinal ? `${t.text}\n\n${event.text}` : event.text,
        textFinal: true,
      }));
    case "progress":
      return updateTurn(state, event.turn, (t) => ({ ...t, progress: [...t.progress, event.text] }));
    case "model_turn":
      return {
        ...updateTurn(state, event.turn, (t) => ({
          ...t,
          stats: { durationMs: event.durationMs, usage: event.usage, costUsd: event.costUsd, stopReason: event.stopReason },
        })),
        totalUsage: event.totalUsage,
        totalCostUsd: event.totalCostUsd,
        totalModelMs: state.totalModelMs + event.durationMs,
      };
    case "tool_call":
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "tool",
            turn: event.turn,
            toolUseId: event.toolUseId,
            tool: event.tool,
            input: event.input,
            sideEffect: event.sideEffect,
            needsApproval: event.needsApproval,
            status: "running",
          },
        ],
      };
    case "approval_required":
      return updateTool(state, event.toolUseId, (t) => ({ ...t, status: "awaiting_approval" }));
    case "approval_resolved":
      return updateTool(state, event.toolUseId, (t) => ({
        ...t,
        status: event.approved ? "approved" : "rejected",
        rejectionReason: event.reason,
      }));
    case "tool_result":
      return updateTool(state, event.toolUseId, (t) => ({
        ...t,
        // A declined call keeps its "rejected" status; its result only says so.
        status: t.status === "rejected" ? "rejected" : event.ok ? "succeeded" : "failed",
        output: event.output,
        error: event.error,
        hint: event.hint,
        durationMs: event.durationMs,
      }));
    case "error":
      return { ...state, error: event.message };
    case "done": {
      const lastTurn = [...state.items].reverse().find((i): i is TurnItem => i.kind === "turn");
      const next = { ...state, status: event.status, answer: event.answer, done: true };
      return event.answer && lastTurn ? updateTurn(next, lastTurn.turn, (t) => ({ ...t, isAnswer: true })) : next;
    }
  }
}

export const pendingApprovals = (state: TraceState): ToolItem[] =>
  state.items.filter((i): i is ToolItem => i.kind === "tool" && i.status === "awaiting_approval");
