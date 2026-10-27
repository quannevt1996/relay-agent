import type Anthropic from "@anthropic-ai/sdk";
import type { ToolExecutor, ToolOutcome, ToolRegistry } from "../connectors/registry.js";
import type { InputValue, Skill } from "../skills/loader.js";
import type { PendingToolUse, RunRecord, RunState, RunStore } from "../store/runs.js";
import { emptyUsage, EPHEMERAL_EVENTS, isTerminal, type RunEvent, type RunEventBus, type RunStatus } from "./events.js";
import { describeModelError, type ModelClient } from "./model.js";
import { addUsage, estimateCostUsd } from "./pricing.js";
import { firstUserMessage, systemPromptFor } from "./prompts.js";

type ToolResult = Anthropic.Beta.BetaToolResultBlockParam;
type ToolUseBlock = Anthropic.Beta.BetaToolUseBlock;

export interface AgentRunnerDeps {
  runs: RunStore;
  bus: RunEventBus;
  registry: ToolRegistry;
  executor: ToolExecutor;
  model: ModelClient;
  /** Upper bound on model turns per run, so a confused model cannot loop forever. */
  maxTurns: number;
  now?: () => Date;
}

export interface StartRunOptions {
  prompt?: string;
  skill?: Skill;
  inputs?: Record<string, InputValue>;
  /** Run write tools without asking. Off by default; the UI exposes it as an explicit opt-in. */
  autoApprove?: boolean;
}

export class RunError extends Error {
  constructor(
    readonly code: "invalid" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "RunError";
  }
}

const DECLINED = "The user declined this action, so it was not performed. Do not retry it.";

/**
 * Drives the Messages API tool-use loop for a run.
 *
 * The loop is resumable: everything it needs (system prompt, tool list,
 * message history, pending approvals) lives in the run's `state` column. When
 * a turn contains write tools, the loop saves the turn and stops; a later
 * approve/reject call (possibly after a server restart) picks it up again.
 * History is append-only: assistant turns are stored exactly as returned,
 * including thinking blocks, and are never edited.
 */
export class AgentRunner {
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly now: () => Date;

  constructor(private readonly deps: AgentRunnerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  get modelId(): string {
    return this.deps.model.model;
  }

  start(workspaceId: string, options: StartRunOptions): RunRecord {
    const { skill, inputs } = options;
    const prompt = options.prompt?.trim() || undefined;
    if (!skill && !prompt) throw new RunError("invalid", "Provide a prompt or pick a skill");

    const state: RunState = {
      system: systemPromptFor(skill),
      toolNames: skill ? skill.tools : this.deps.registry.list().map((t) => t.name),
      messages: [{ role: "user", content: firstUserMessage({ now: this.now(), prompt, skill, inputs }) }],
      pending: null,
    };
    const run = this.deps.runs.create(workspaceId, {
      title: skill ? skill.name : truncate(prompt!, 80),
      skillId: skill?.id ?? null,
      model: this.deps.model.model,
      autoApprove: options.autoApprove ?? false,
      state,
    });

    this.emit(run.id, {
      type: "run_started",
      prompt: prompt ?? null,
      skillId: run.skillId,
      model: run.model,
      autoApprove: run.autoApprove,
    });
    this.emit(run.id, { type: "status", status: "running" });
    this.launch(workspaceId, run.id);
    return run;
  }

  /** Records a human decision on one pending write tool; resumes the run once every call in the turn is decided. */
  decide(workspaceId: string, runId: string, toolUseId: string, approved: boolean, reason?: string): RunRecord {
    const run = this.load(workspaceId, runId);
    const pending = run.state.pending;
    if (run.status !== "awaiting_approval" || !pending) {
      throw new RunError("conflict", `Run is ${run.status}, not waiting for approval`);
    }
    if (!pending.awaiting.includes(toolUseId)) throw new RunError("not_found", "No pending approval for that tool call");
    if (pending.decisions[toolUseId]) throw new RunError("conflict", "That tool call has already been decided");

    const note = reason?.trim() || undefined;
    pending.decisions[toolUseId] = { approved, ...(note ? { reason: note } : {}) };
    this.emit(runId, { type: "approval_resolved", toolUseId, approved, ...(note ? { reason: note } : {}) });

    const undecided = pending.awaiting.filter((id) => !pending.decisions[id]);
    if (undecided.length > 0) {
      this.deps.runs.update(workspaceId, runId, { state: run.state });
    } else {
      this.deps.runs.update(workspaceId, runId, { state: run.state, status: "running" });
      this.emit(runId, { type: "status", status: "running" });
      this.launch(workspaceId, runId);
    }
    return this.load(workspaceId, runId);
  }

  cancel(workspaceId: string, runId: string): RunRecord {
    const run = this.load(workspaceId, runId);
    if (isTerminal(run.status)) throw new RunError("conflict", `Run is already ${run.status}`);
    this.active.get(runId)?.controller.abort();
    this.finish(workspaceId, runId, "cancelled", { answer: null });
    return this.load(workspaceId, runId);
  }

  /** Resolves once the run's background loop has stopped (finished or paused for approval). */
  async settled(runId: string): Promise<void> {
    await this.active.get(runId)?.done;
  }

  // --- the loop -------------------------------------------------------------------------------

  private launch(workspaceId: string, runId: string): void {
    const controller = new AbortController();
    const done = this.drive(workspaceId, runId, controller.signal)
      // drive() records its own failures; this only catches a failure to record one (e.g. the database is gone).
      .catch((err) => console.error(`[relay] run ${runId} loop crashed`, err))
      .finally(() => {
        if (this.active.get(runId)?.controller === controller) this.active.delete(runId);
      });
    this.active.set(runId, { controller, done });
  }

  private async drive(workspaceId: string, runId: string, signal: AbortSignal): Promise<void> {
    try {
      if (this.load(workspaceId, runId).state.pending) await this.completePendingTurn(workspaceId, runId, signal);

      while (!signal.aborted) {
        const run = this.load(workspaceId, runId);
        if (run.turns >= this.deps.maxTurns) {
          this.finish(workspaceId, runId, "failed", {
            error: `Stopped after ${this.deps.maxTurns} model turns without a final answer (RELAY_MAX_TURNS).`,
          });
          return;
        }

        const message = await this.modelTurn(run, signal);
        if (signal.aborted) return;
        const toolUses = message.content.filter((b): b is ToolUseBlock => b.type === "tool_use");

        switch (message.stop_reason) {
          case "refusal": {
            const category = message.stop_details?.category;
            this.finish(workspaceId, runId, "failed", {
              error: `The model declined this request${category ? ` (${category})` : ""}.`,
            });
            return;
          }
          case "max_tokens":
          case "model_context_window_exceeded":
            // A tool input cut off mid-generation can still parse as a valid
            // partial object, so never run the tools of a truncated turn.
            this.finish(workspaceId, runId, "failed", { error: `The model's output was cut off (${message.stop_reason}).` });
            return;
          case "pause_turn":
            continue;
        }

        if (toolUses.length === 0) {
          this.finish(workspaceId, runId, "completed", { answer: textOf(message.content) });
          return;
        }
        const paused = await this.handleToolUses(workspaceId, runId, toolUses);
        if (paused) return;
      }
    } catch (err) {
      if (signal.aborted) return; // cancel() already recorded the outcome
      console.error(`[relay] run ${runId} failed`, err);
      this.finish(workspaceId, runId, "failed", { error: describeModelError(err) });
    }
  }

  private async modelTurn(run: RunRecord, signal: AbortSignal): Promise<Anthropic.Beta.BetaMessage> {
    const turn = run.turns + 1;
    this.emit(run.id, { type: "turn_started", turn });

    const started = performance.now();
    const message = await this.deps.model.createTurn(
      {
        system: run.state.system,
        tools: this.deps.registry.toAnthropicTools(run.state.toolNames),
        messages: run.state.messages,
      },
      { signal, onText: (delta) => this.emit(run.id, { type: "text_delta", turn, delta }) },
    );
    const durationMs = Math.round(performance.now() - started);
    if (signal.aborted) return message;

    // Append the turn exactly as returned (thinking blocks included) before anything else can fail.
    run.state.messages.push({ role: "assistant", content: message.content });
    const turnUsage = addUsage(emptyUsage(), message.usage);
    const totalUsage = addUsage(run.usage, message.usage);
    this.deps.runs.update(run.workspaceId, run.id, { state: run.state, turns: turn, usage: totalUsage });

    for (const block of message.content) {
      if (block.type === "thinking" && block.thinking.trim()) this.emit(run.id, { type: "progress", turn, text: block.thinking });
      if (block.type === "text" && block.text.trim()) this.emit(run.id, { type: "text", turn, text: block.text });
    }
    this.emit(run.id, {
      type: "model_turn",
      turn,
      stopReason: message.stop_reason,
      durationMs,
      usage: turnUsage,
      costUsd: estimateCostUsd(run.model, turnUsage),
      totalUsage,
      totalCostUsd: estimateCostUsd(run.model, totalUsage),
    });
    return message;
  }

  /**
   * Validates every tool call of a turn, runs the reads, and either answers the
   * turn straight away or parks it until a human decides on the writes.
   * Returns true when the run paused for approval.
   */
  private async handleToolUses(workspaceId: string, runId: string, toolUses: ToolUseBlock[]): Promise<boolean> {
    const run = this.load(workspaceId, runId);
    const turn = run.turns;
    const results = new Map<string, ToolResult>();
    const reads: PendingToolUse[] = [];
    const autoApprovedWrites: PendingToolUse[] = [];
    const awaiting: string[] = [];

    for (const use of toolUses) {
      const tool = run.state.toolNames.includes(use.name) ? this.deps.registry.get(use.name) : undefined;
      const needsApproval = tool?.sideEffect === "write" && !run.autoApprove;
      this.emit(runId, {
        type: "tool_call",
        turn,
        toolUseId: use.id,
        tool: use.name,
        input: use.input,
        sideEffect: tool?.sideEffect ?? null,
        needsApproval,
      });

      // Reject bad calls before a human is asked to approve them.
      const problem = !tool
        ? `Tool "${use.name}" is not available in this run. Use one of: ${run.state.toolNames.join(", ")}.`
        : invalidInput(this.deps.registry.validate(use.name, use.input));
      if (problem) {
        results.set(use.id, errorResult(use.id, { ok: false, error: problem, code: "invalid_input" }));
        this.emit(runId, { type: "tool_result", toolUseId: use.id, tool: use.name, ok: false, error: problem, durationMs: 0 });
        continue;
      }

      if (needsApproval) {
        awaiting.push(use.id);
        this.emit(runId, { type: "approval_required", toolUseId: use.id, tool: use.name, input: use.input });
      } else {
        (tool!.sideEffect === "write" ? autoApprovedWrites : reads).push({ id: use.id, name: use.name, input: use.input });
      }
    }

    // Reads are independent of each other, so run them concurrently. Writes may
    // depend on each other (create a page, then append to it), so they run one
    // at a time in the order the model asked for them.
    await Promise.all(reads.map(async (use) => results.set(use.id, await this.runTool(workspaceId, runId, use))));
    for (const use of autoApprovedWrites) {
      if (isTerminal(this.load(workspaceId, runId).status)) return true;
      results.set(use.id, await this.runTool(workspaceId, runId, use));
    }

    const current = this.load(workspaceId, runId);
    if (isTerminal(current.status)) return true; // cancelled while tools were running

    if (awaiting.length > 0) {
      current.state.pending = {
        toolUses: toolUses.map((u) => ({ id: u.id, name: u.name, input: u.input })),
        results: [...results.values()],
        awaiting,
        decisions: {},
      };
      this.deps.runs.update(workspaceId, runId, { state: current.state, status: "awaiting_approval" });
      this.emit(runId, { type: "status", status: "awaiting_approval" });
      return true;
    }

    // All tool results for a turn go back in one user message, in the model's order.
    current.state.messages.push({ role: "user", content: toolUses.map((u) => results.get(u.id)!) });
    this.deps.runs.update(workspaceId, runId, { state: current.state });
    return false;
  }

  /** Runs approved writes (in the order the model asked for them) and answers the paused turn. */
  private async completePendingTurn(workspaceId: string, runId: string, signal: AbortSignal): Promise<void> {
    const run = this.load(workspaceId, runId);
    const pending = run.state.pending!;
    const results = new Map(pending.results.map((r) => [r.tool_use_id, r]));

    for (const id of pending.awaiting) {
      // A cancel cannot stop a write that is already running, but it stops the ones queued after it.
      if (signal.aborted) return;
      const use = pending.toolUses.find((u) => u.id === id)!;
      const decision = pending.decisions[id]!;
      if (decision.approved) {
        results.set(id, await this.runTool(workspaceId, runId, use));
      } else {
        const note = decision.reason ? `${DECLINED} Their note: ${decision.reason}` : DECLINED;
        results.set(id, { type: "tool_result", tool_use_id: id, is_error: true, content: note });
        this.emit(runId, { type: "tool_result", toolUseId: id, tool: use.name, ok: false, error: "Declined by the user", durationMs: 0 });
      }
    }

    if (signal.aborted) return;
    const current = this.load(workspaceId, runId);
    current.state.messages.push({ role: "user", content: pending.toolUses.map((u) => results.get(u.id)!) });
    current.state.pending = null;
    this.deps.runs.update(workspaceId, runId, { state: current.state });
  }

  private async runTool(workspaceId: string, runId: string, use: PendingToolUse): Promise<ToolResult> {
    const started = performance.now();
    const outcome = await this.deps.executor.execute(workspaceId, use.name, use.input);
    const durationMs = Math.round(performance.now() - started);
    this.emit(runId, {
      type: "tool_result",
      toolUseId: use.id,
      tool: use.name,
      durationMs,
      ...(outcome.ok ? { ok: true, output: outcome.output } : { ok: false, error: outcome.error, hint: outcome.hint }),
    });
    return outcome.ok
      ? { type: "tool_result", tool_use_id: use.id, content: JSON.stringify(outcome.output) }
      : errorResult(use.id, outcome);
  }

  // --- helpers --------------------------------------------------------------------------------

  private finish(
    workspaceId: string,
    runId: string,
    status: Extract<RunStatus, "completed" | "failed" | "cancelled">,
    { answer = null, error }: { answer?: string | null; error?: string },
  ): void {
    const run = this.deps.runs.get(workspaceId, runId);
    if (!run || isTerminal(run.status)) return; // first terminal outcome wins
    this.deps.runs.update(workspaceId, runId, { status, ...(error ? { error } : {}) });
    if (error) this.emit(runId, { type: "error", message: error });
    this.emit(runId, { type: "done", status, answer });
  }

  private load(workspaceId: string, runId: string): RunRecord {
    const run = this.deps.runs.get(workspaceId, runId);
    if (!run) throw new RunError("not_found", "Run not found");
    return run;
  }

  private emit(runId: string, event: RunEvent): void {
    if (EPHEMERAL_EVENTS.has(event.type)) {
      this.deps.bus.publish(runId, { event });
      return;
    }
    const stored = this.deps.runs.appendEvent(runId, event);
    this.deps.bus.publish(runId, { seq: stored.seq, event });
  }
}

/** Tool errors go back to the model as `is_error` results so it can adapt instead of the run crashing. */
function errorResult(toolUseId: string, outcome: Extract<ToolOutcome, { ok: false }>): ToolResult {
  const body = { error: outcome.error, ...(outcome.hint ? { hint: outcome.hint } : {}), ...(outcome.code ? { code: outcome.code } : {}) };
  return { type: "tool_result", tool_use_id: toolUseId, is_error: true, content: JSON.stringify(body) };
}

function invalidInput(result: ReturnType<ToolRegistry["validate"]>): string | undefined {
  return result.ok ? undefined : result.error;
}

function textOf(content: Anthropic.Beta.BetaContentBlock[]): string | null {
  const text = content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text || null;
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
