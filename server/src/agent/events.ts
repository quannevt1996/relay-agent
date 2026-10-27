import { EventEmitter } from "node:events";
import type { SideEffect } from "../connectors/types.js";

export type RunStatus = "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";

export const TERMINAL_STATUSES: readonly RunStatus[] = ["completed", "failed", "cancelled"];

export const isTerminal = (status: RunStatus): boolean => TERMINAL_STATUSES.includes(status);

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export const emptyUsage = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
});

/**
 * The trace of a run. Everything the UI shows is rebuilt from these events,
 * so a page reload (or a second tab) replays the same timeline.
 */
export type RunEvent =
  | { type: "run_started"; prompt: string | null; skillId: string | null; model: string; autoApprove: boolean }
  | { type: "status"; status: RunStatus }
  | { type: "turn_started"; turn: number }
  | { type: "text_delta"; turn: number; delta: string }
  | { type: "text"; turn: number; text: string }
  /** A short progress note the model wrote between tool calls (returned as a thinking block). */
  | { type: "progress"; turn: number; text: string }
  | {
      type: "model_turn";
      turn: number;
      stopReason: string | null;
      durationMs: number;
      /** Tokens for this turn only. */
      usage: UsageTotals;
      costUsd: number | null;
      /** Running totals for the whole run. */
      totalUsage: UsageTotals;
      totalCostUsd: number | null;
    }
  | {
      type: "tool_call";
      turn: number;
      toolUseId: string;
      tool: string;
      input: unknown;
      /** Null when the model named a tool this run does not offer. */
      sideEffect: SideEffect | null;
      needsApproval: boolean;
    }
  | {
      type: "tool_result";
      toolUseId: string;
      tool: string;
      ok: boolean;
      output?: unknown;
      error?: string;
      hint?: string;
      durationMs: number;
    }
  | { type: "approval_required"; toolUseId: string; tool: string; input: unknown }
  | { type: "approval_resolved"; toolUseId: string; approved: boolean; reason?: string }
  | { type: "error"; message: string }
  | { type: "done"; status: RunStatus; answer: string | null };

/** Events that are only streamed live and never written to the database. */
export const EPHEMERAL_EVENTS: ReadonlySet<RunEvent["type"]> = new Set(["text_delta"]);

export interface RunEventEnvelope {
  /** Present for persisted events; used as the SSE id for resumable streams. */
  seq?: number;
  event: RunEvent;
}

/** In-process fan-out of run events to live SSE subscribers. */
export class RunEventBus {
  private readonly emitter = new EventEmitter().setMaxListeners(0);

  publish(runId: string, envelope: RunEventEnvelope): void {
    this.emitter.emit(runId, envelope);
  }

  subscribe(runId: string, listener: (envelope: RunEventEnvelope) => void): () => void {
    this.emitter.on(runId, listener);
    return () => this.emitter.off(runId, listener);
  }
}
