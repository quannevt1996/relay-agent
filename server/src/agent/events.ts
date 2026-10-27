import { EventEmitter } from "node:events";
import type { SideEffect } from "../connectors/types.js";

export type RunStatus = "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";

export const TERMINAL_STATUSES: readonly RunStatus[] = ["completed", "failed", "cancelled"];

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

export type RunEvent =
  | { type: "run_started"; prompt: string; skillId: string | null; model: string }
  | { type: "status"; status: RunStatus }
  | { type: "text_delta"; turn: number; delta: string }
  | { type: "text"; turn: number; text: string }
  | {
      type: "tool_call";
      turn: number;
      toolUseId: string;
      tool: string;
      input: unknown;
      sideEffect: SideEffect;
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
  | { type: "approval_resolved"; toolUseId: string; approved: boolean }
  | { type: "usage"; turn: number; usage: UsageTotals; costUsd: number | null }
  | { type: "error"; message: string }
  | { type: "done"; status: RunStatus };

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
