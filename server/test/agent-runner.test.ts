import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AgentRunner, RunError } from "../src/agent/runner.js";
import { createTestServices, eventTypes, ScriptedModel, text, toolUse } from "./helpers.js";

const STANDUP = "C02STANDUP";
const MISSING_PAGE = "1f0e8c2a-0000-4000-8000-000000000099";

function setup(turns: ConstructorParameters<typeof ScriptedModel>[0], maxTurns?: number) {
  const model = new ScriptedModel(turns);
  const services = createTestServices({ model, maxTurns });
  const workspace = services.workspaces.create("Test");
  return { ...services, model, ws: workspace.id };
}

describe("AgentRunner", () => {
  it("runs read tools immediately and finishes with the model's answer", async () => {
    const t = setup([
      { content: [text("Reading the channel."), toolUse("tu_1", "slack_read_channel_history", { channel: "#eng-standup" })] },
      { content: [text("Diego is blocked on staging Redis.")] },
    ]);
    const run = t.runner.start(t.ws, { prompt: "Any blockers in #eng-standup?" });
    await t.runner.settled(run.id);

    const done = t.runs.get(t.ws, run.id)!;
    expect(done.status).toBe("completed");
    expect(done.turns).toBe(2);
    expect(done.usage).toMatchObject({ inputTokens: 2000, outputTokens: 200, cacheReadInputTokens: 1000 });

    const [result] = t.model.lastToolResults();
    expect(result).toMatchObject({ tool_use_id: "tu_1" });
    expect(result!.is_error).toBeUndefined();
    expect(JSON.parse(result!.content as string).channel).toEqual({ id: STANDUP, name: "eng-standup" });

    const types = eventTypes(t.runs, t.ws, run.id);
    expect(types).toEqual([
      "run_started",
      "status",
      "turn_started",
      "text",
      "model_turn",
      "tool_call",
      "tool_result",
      "turn_started",
      "text",
      "model_turn",
      "done",
    ]);
    const last = t.runs.events(t.ws, run.id).at(-1)!.event;
    expect(last).toEqual({ type: "done", status: "completed", answer: "Diego is blocked on staging Redis." });
  });

  it("records per-turn latency, usage and an estimated cost", async () => {
    const t = setup([{ content: [text("Hi")] }]);
    const run = t.runner.start(t.ws, { prompt: "hello" });
    await t.runner.settled(run.id);
    const turn = t.runs.events(t.ws, run.id).find((e) => e.event.type === "model_turn")!.event;
    expect(turn).toMatchObject({ type: "model_turn", turn: 1, stopReason: "end_turn", usage: { inputTokens: 1000 } });
    if (turn.type !== "model_turn") throw new Error("unreachable");
    expect(turn.durationMs).toBeGreaterThanOrEqual(0);
    expect(turn.costUsd).toBeCloseTo((1000 * 4 + 100 * 20 + 500 * 0.2) / 1_000_000);
  });

  it("pauses on a write tool and only runs it after approval", async () => {
    const input = { channel: "#eng-standup", text: "Standup digest is in Notion." };
    const t = setup([
      { content: [toolUse("tu_post", "slack_post_message", input)] },
      { content: [text("Posted.")] },
    ]);
    const world = t.apis.demoWorld(t.ws);
    const before = world.slack.messages.get(STANDUP)!.length;

    const run = t.runner.start(t.ws, { prompt: "Tell standup the digest is ready" });
    await t.runner.settled(run.id);

    expect(t.runs.get(t.ws, run.id)!.status).toBe("awaiting_approval");
    expect(world.slack.messages.get(STANDUP)!.length).toBe(before);
    const approval = t.runs.events(t.ws, run.id).find((e) => e.event.type === "approval_required")!.event;
    expect(approval).toEqual({ type: "approval_required", toolUseId: "tu_post", tool: "slack_post_message", input });

    t.runner.decide(t.ws, run.id, "tu_post", true);
    await t.runner.settled(run.id);

    expect(t.runs.get(t.ws, run.id)!.status).toBe("completed");
    expect(world.slack.messages.get(STANDUP)!.at(-1)).toMatchObject({ userId: "U0RELAYBOT", text: input.text });
    const [result] = t.model.lastToolResults();
    expect(result!.is_error).toBeUndefined();
    expect(t.runs.get(t.ws, run.id)!.state.pending).toBeNull();
  });

  it("tells the model when the user declines, and never runs the tool", async () => {
    const t = setup([
      { content: [toolUse("tu_post", "slack_post_message", { channel: "#general", text: "Hello everyone" })] },
      { content: [text("Okay, I won't post it.")] },
    ]);
    const world = t.apis.demoWorld(t.ws);
    const before = world.slack.messages.get("C01GENERAL")!.length;

    const run = t.runner.start(t.ws, { prompt: "Say hi in #general" });
    await t.runner.settled(run.id);
    t.runner.decide(t.ws, run.id, "tu_post", false, "Wrong channel");
    await t.runner.settled(run.id);

    expect(world.slack.messages.get("C01GENERAL")!.length).toBe(before);
    const [result] = t.model.lastToolResults();
    expect(result).toMatchObject({ tool_use_id: "tu_post", is_error: true });
    expect(result!.content).toContain("declined");
    expect(result!.content).toContain("Wrong channel");
    expect(t.runs.get(t.ws, run.id)!.status).toBe("completed");
    const resolved = t.runs.events(t.ws, run.id).find((e) => e.event.type === "approval_resolved")!.event;
    expect(resolved).toEqual({ type: "approval_resolved", toolUseId: "tu_post", approved: false, reason: "Wrong channel" });
  });

  it("returns connector errors to the model as is_error results with a hint", async () => {
    const t = setup([
      { content: [toolUse("tu_read", "notion_read_page", { page: MISSING_PAGE })] },
      { content: [text("That page isn't shared with the integration.")] },
    ]);
    const run = t.runner.start(t.ws, { prompt: "Read that page" });
    await t.runner.settled(run.id);

    expect(t.runs.get(t.ws, run.id)!.status).toBe("completed");
    const [result] = t.model.lastToolResults();
    expect(result!.is_error).toBe(true);
    const body = JSON.parse(result!.content as string);
    expect(body).toMatchObject({ code: "not_found" });
    expect(body.hint).toMatch(/Share the page/);
  });

  it("rejects invalid input before asking anyone to approve it", async () => {
    const t = setup([
      { content: [toolUse("tu_bad", "slack_post_message", { channel: "#general", text: "" })] },
      { content: [text("I need some text to post.")] },
    ]);
    const run = t.runner.start(t.ws, { prompt: "Post nothing" });
    await t.runner.settled(run.id);

    const types = eventTypes(t.runs, t.ws, run.id);
    expect(types).not.toContain("approval_required");
    const [result] = t.model.lastToolResults();
    expect(result).toMatchObject({ is_error: true });
    expect(JSON.parse(result!.content as string).code).toBe("invalid_input");
  });

  it("refuses tools the run does not offer", async () => {
    const t = setup([
      { content: [toolUse("tu_x", "github_create_issue", { title: "x" })] },
      { content: [text("I can't do that here.")] },
    ]);
    const run = t.runner.start(t.ws, { prompt: "File an issue" });
    await t.runner.settled(run.id);
    const [result] = t.model.lastToolResults();
    expect(result!.is_error).toBe(true);
    expect(result!.content).toContain("not available in this run");
  });

  it("runs reads while writes wait, and answers every tool_use of the turn in order", async () => {
    const t = setup([
      {
        content: [
          toolUse("tu_write", "notion_append_to_page", { page: "1f0e8c2a-0000-4000-8000-000000000005", content: "- [ ] Follow up" }),
          toolUse("tu_read", "slack_list_channels", {}),
        ],
      },
      { content: [text("Done.")] },
    ]);
    const run = t.runner.start(t.ws, { prompt: "Do both" });
    await t.runner.settled(run.id);

    const pending = t.runs.get(t.ws, run.id)!.state.pending!;
    expect(pending.awaiting).toEqual(["tu_write"]);
    expect(pending.results.map((r) => r.tool_use_id)).toEqual(["tu_read"]);

    t.runner.decide(t.ws, run.id, "tu_write", true);
    await t.runner.settled(run.id);
    expect(t.model.lastToolResults().map((r) => r.tool_use_id)).toEqual(["tu_write", "tu_read"]);
    expect(t.apis.demoWorld(t.ws).notion.pages.get("1f0e8c2a-0000-4000-8000-000000000005")!.markdown).toContain("- [ ] Follow up");
  });

  it("waits for every write in a turn before resuming", async () => {
    const t = setup([
      {
        content: [
          toolUse("tu_a", "slack_post_message", { channel: "#general", text: "A" }),
          toolUse("tu_b", "slack_post_message", { channel: "#general", text: "B" }),
        ],
      },
      { content: [text("Posted A only.")] },
    ]);
    const run = t.runner.start(t.ws, { prompt: "Post A and B" });
    await t.runner.settled(run.id);

    t.runner.decide(t.ws, run.id, "tu_a", true);
    await t.runner.settled(run.id);
    expect(t.runs.get(t.ws, run.id)!.status).toBe("awaiting_approval");
    expect(t.model.requests).toHaveLength(1);

    t.runner.decide(t.ws, run.id, "tu_b", false);
    await t.runner.settled(run.id);
    expect(t.runs.get(t.ws, run.id)!.status).toBe("completed");
    const results = t.model.lastToolResults();
    expect(results.map((r) => [r.tool_use_id, Boolean(r.is_error)])).toEqual([
      ["tu_a", false],
      ["tu_b", true],
    ]);
  });

  it("stops after the maximum number of model turns", async () => {
    const loop = () => ({ content: [toolUse(`tu_${Math.random()}`, "slack_list_channels", {})] });
    const t = setup([loop, loop, loop, loop], 3);
    const run = t.runner.start(t.ws, { prompt: "Loop forever" });
    await t.runner.settled(run.id);

    const done = t.runs.get(t.ws, run.id)!;
    expect(done.status).toBe("failed");
    expect(done.turns).toBe(3);
    expect(done.error).toMatch(/3 model turns/);
    expect(t.model.requests).toHaveLength(3);
  });

  it("fails without running tools when the model refuses", async () => {
    const t = setup([
      {
        content: [toolUse("tu_1", "slack_post_message", { channel: "#general", text: "x" })],
        stopReason: "refusal",
        stopDetails: {
          type: "refusal",
          category: "cyber",
          explanation: null,
          fallback_credit_token: null,
          fallback_has_prefill_claim: null,
          recommended_model: null,
        },
      },
    ]);
    const run = t.runner.start(t.ws, { prompt: "Something risky" });
    await t.runner.settled(run.id);
    const done = t.runs.get(t.ws, run.id)!;
    expect(done.status).toBe("failed");
    expect(done.error).toContain("cyber");
    expect(eventTypes(t.runs, t.ws, run.id)).not.toContain("tool_call");
  });

  it("never runs the tools of a turn that hit max_tokens", async () => {
    const t = setup([{ content: [toolUse("tu_1", "slack_list_channels", {})], stopReason: "max_tokens" }]);
    const run = t.runner.start(t.ws, { prompt: "Long" });
    await t.runner.settled(run.id);
    expect(t.runs.get(t.ws, run.id)!.status).toBe("failed");
    expect(eventTypes(t.runs, t.ws, run.id)).not.toContain("tool_call");
  });

  it("turns model API errors into a failed run with a readable message", async () => {
    const t = setup([new Anthropic.APIConnectionError({ message: "socket hang up" })]);
    const run = t.runner.start(t.ws, { prompt: "Hi" });
    await t.runner.settled(run.id);
    const done = t.runs.get(t.ws, run.id)!;
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/Could not reach the Anthropic API/);
    expect(t.runs.events(t.ws, run.id).at(-1)!.event).toMatchObject({ type: "done", status: "failed" });
  });

  it("can cancel a run that is waiting for approval", async () => {
    const t = setup([{ content: [toolUse("tu_post", "slack_post_message", { channel: "#general", text: "x" })] }]);
    const run = t.runner.start(t.ws, { prompt: "Post" });
    await t.runner.settled(run.id);
    t.runner.cancel(t.ws, run.id);
    expect(t.runs.get(t.ws, run.id)!.status).toBe("cancelled");
    expect(() => t.runner.decide(t.ws, run.id, "tu_post", true)).toThrow(RunError);
  });

  it("resumes a paused run from the database with a fresh runner (e.g. after a restart)", async () => {
    const t = setup([
      { content: [toolUse("tu_post", "slack_post_message", { channel: "#general", text: "After restart" })] },
      { content: [text("Posted after the restart.")] },
    ]);
    const run = t.runner.start(t.ws, { prompt: "Post" });
    await t.runner.settled(run.id);

    const restarted = new AgentRunner({
      runs: t.runs,
      bus: t.bus,
      registry: t.registry,
      executor: t.executor,
      model: t.model,
      maxTurns: 8,
    });
    restarted.decide(t.ws, run.id, "tu_post", true);
    await restarted.settled(run.id);
    expect(t.runs.get(t.ws, run.id)!.status).toBe("completed");
  });

  it("does not let another workspace see or approve a run", async () => {
    const t = setup([{ content: [toolUse("tu_post", "slack_post_message", { channel: "#general", text: "x" })] }]);
    const other = t.workspaces.create("Other").id;
    const run = t.runner.start(t.ws, { prompt: "Post" });
    await t.runner.settled(run.id);

    expect(() => t.runner.decide(other, run.id, "tu_post", true)).toThrow(/Run not found/);
    expect(t.runs.get(other, run.id)).toBeUndefined();
    expect(t.runs.events(other, run.id)).toEqual([]);
    expect(t.runs.get(t.ws, run.id)!.status).toBe("awaiting_approval");
  });

  it("auto-approves writes only when the run opted in", async () => {
    const t = setup([
      { content: [toolUse("tu_post", "slack_post_message", { channel: "#general", text: "auto" })] },
      { content: [text("Posted.")] },
    ]);
    const run = t.runner.start(t.ws, { prompt: "Post", autoApprove: true });
    await t.runner.settled(run.id);
    expect(t.runs.get(t.ws, run.id)!.status).toBe("completed");
    expect(eventTypes(t.runs, t.ws, run.id)).not.toContain("approval_required");
  });

  it("requires a prompt or a skill", () => {
    const t = setup([]);
    expect(() => t.runner.start(t.ws, { prompt: "   " })).toThrow(/prompt or pick a skill/);
  });
});
