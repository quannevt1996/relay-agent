import { describe, expect, it } from "vitest";
import type { RunEvent, Usage } from "./api";
import { applyEvent, initialTrace, pendingApprovals, type ToolItem, type TurnItem } from "./trace";

const usage = (input: number, output: number): Usage => ({ inputTokens: input, outputTokens: output, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
const fold = (events: RunEvent[]) => events.reduce(applyEvent, initialTrace());

const approvalRun: RunEvent[] = [
  { type: "run_started", prompt: "Post the action items", skillId: null, model: "claude-opus-5-5", autoApprove: false },
  { type: "status", status: "running" },
  { type: "turn_started", turn: 1 },
  { type: "text_delta", turn: 1, delta: "Posting " },
  { type: "text_delta", turn: 1, delta: "now." },
  { type: "text", turn: 1, text: "Posting now." },
  { type: "model_turn", turn: 1, stopReason: "tool_use", durationMs: 900, usage: usage(1000, 50), costUsd: 0.005, totalUsage: usage(1000, 50), totalCostUsd: 0.005 },
  { type: "tool_call", turn: 1, toolUseId: "tu_1", tool: "slack_post_message", input: { channel: "#incidents", text: "hi" }, sideEffect: "write", needsApproval: true },
  { type: "approval_required", toolUseId: "tu_1", tool: "slack_post_message", input: { channel: "#incidents", text: "hi" } },
  { type: "status", status: "awaiting_approval" },
];

describe("applyEvent", () => {
  it("streams deltas into the current turn, then replaces them with the final text", () => {
    const streaming = fold(approvalRun.slice(0, 5));
    expect((streaming.items[0] as TurnItem).text).toBe("Posting now.");
    const final = fold(approvalRun.slice(0, 6));
    expect(final.items[0]).toMatchObject({ text: "Posting now.", textFinal: true });
  });

  it("tracks a write tool waiting for approval with the exact input", () => {
    const state = fold(approvalRun);
    expect(state.status).toBe("awaiting_approval");
    expect(pendingApprovals(state)).toEqual([
      expect.objectContaining({ toolUseId: "tu_1", input: { channel: "#incidents", text: "hi" }, sideEffect: "write" }),
    ]);
    expect(state.totalUsage.inputTokens).toBe(1000);
    expect(state.totalModelMs).toBe(900);
  });

  it("keeps a declined call marked as rejected after its result arrives", () => {
    const state = fold([
      ...approvalRun,
      { type: "approval_resolved", toolUseId: "tu_1", approved: false, reason: "Wrong channel" },
      { type: "tool_result", toolUseId: "tu_1", tool: "slack_post_message", ok: false, error: "Declined by the user", durationMs: 0 },
    ]);
    const tool = state.items[1] as ToolItem;
    expect(tool).toMatchObject({ status: "rejected", rejectionReason: "Wrong channel" });
    expect(pendingApprovals(state)).toEqual([]);
  });

  it("marks the last turn as the answer when the run completes", () => {
    const state = fold([
      ...approvalRun,
      { type: "approval_resolved", toolUseId: "tu_1", approved: true },
      { type: "tool_result", toolUseId: "tu_1", tool: "slack_post_message", ok: true, output: { ts: "1.2" }, durationMs: 120 },
      { type: "turn_started", turn: 2 },
      { type: "text", turn: 2, text: "Posted." },
      { type: "done", status: "completed", answer: "Posted." },
    ]);
    expect(state).toMatchObject({ done: true, status: "completed", answer: "Posted." });
    expect(state.items.map((i) => (i.kind === "turn" ? `turn ${i.turn}${i.isAnswer ? " (answer)" : ""}` : `${i.tool}: ${i.status}`))).toEqual([
      "turn 1",
      "slack_post_message: succeeded",
      "turn 2 (answer)",
    ]);
  });

  it("records tool errors with their hint, and run errors", () => {
    const state = fold([
      { type: "turn_started", turn: 1 },
      { type: "tool_call", turn: 1, toolUseId: "tu_9", tool: "notion_search", input: {}, sideEffect: "read", needsApproval: false },
      { type: "tool_result", toolUseId: "tu_9", tool: "notion_search", ok: false, error: "Notion is not connected", hint: "Connect it", durationMs: 2 },
      { type: "error", message: "Stopped after 12 model turns" },
      { type: "done", status: "failed", answer: null },
    ]);
    expect(state.items[1]).toMatchObject({ status: "failed", error: "Notion is not connected", hint: "Connect it" });
    expect(state).toMatchObject({ status: "failed", error: "Stopped after 12 model turns", answer: null });
  });
});
