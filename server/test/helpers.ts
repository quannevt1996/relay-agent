import { randomBytes } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { RunEventBus } from "../src/agent/events.js";
import type { ModelClient, ModelTurnOptions, ModelTurnRequest } from "../src/agent/model.js";
import { AgentRunner } from "../src/agent/runner.js";
import { ConnectorApis, ToolExecutor, ToolRegistry } from "../src/connectors/registry.js";
import { openDb } from "../src/db.js";
import { Vault } from "../src/security/vault.js";
import { ConnectionStore } from "../src/store/connections.js";
import { RunStore } from "../src/store/runs.js";
import { WorkspaceStore } from "../src/store/workspaces.js";

type Block = Anthropic.Beta.BetaContentBlock;
type Turn = { content: Block[]; stopReason?: Anthropic.Beta.BetaStopReason; stopDetails?: Anthropic.Beta.BetaRefusalStopDetails };

export const text = (t: string): Block => ({ type: "text", text: t, citations: null });
export const toolUse = (id: string, name: string, input: unknown): Block => ({ type: "tool_use", id, name, input });

export function message({ content, stopReason, stopDetails }: Turn): Anthropic.Beta.BetaMessage {
  return {
    id: `msg_${randomBytes(6).toString("hex")}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stopReason ?? (content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"),
    stop_sequence: null,
    stop_details: stopDetails ?? null,
    container: null,
    context_management: null,
    diagnostics: null,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_creation: null,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 500,
      fallback_credit: null,
      inference_geo: null,
      iterations: null,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  };
}

/** Plays back a fixed list of turns and records every request it receives. */
export class ScriptedModel implements ModelClient {
  readonly model = "claude-opus-5-5";
  readonly requests: ModelTurnRequest[] = [];

  constructor(private readonly turns: Array<Turn | Error | ((request: ModelTurnRequest) => Turn)>) {}

  async createTurn(request: ModelTurnRequest, options: ModelTurnOptions = {}): Promise<Anthropic.Beta.BetaMessage> {
    // The runner keeps mutating its history after the call, so keep a snapshot.
    this.requests.push(structuredClone(request));
    const next = this.turns.shift();
    if (!next) throw new Error("ScriptedModel ran out of turns");
    if (next instanceof Error) throw next;
    const turn = typeof next === "function" ? next(request) : next;
    for (const block of turn.content) if (block.type === "text") options.onText?.(block.text);
    return message(turn);
  }

  /** The tool_result blocks of the most recent request's last user message. */
  lastToolResults(): Anthropic.Beta.BetaToolResultBlockParam[] {
    const last = this.requests.at(-1)?.messages.at(-1);
    if (!last || !Array.isArray(last.content)) return [];
    return (last.content as Anthropic.Beta.BetaContentBlockParam[]).filter(
      (b): b is Anthropic.Beta.BetaToolResultBlockParam => b.type === "tool_result",
    );
  }
}

export function createTestServices(options: { model?: ModelClient; maxTurns?: number } = {}) {
  const db = openDb(":memory:");
  const vault = new Vault(randomBytes(32));
  const workspaces = new WorkspaceStore(db);
  const connections = new ConnectionStore(db, vault);
  const runs = new RunStore(db);
  const bus = new RunEventBus();
  const registry = new ToolRegistry();
  const apis = new ConnectorApis("demo", {
    getAccessToken: async () => {
      throw new Error("live tokens are not used in tests");
    },
  });
  const executor = new ToolExecutor(registry, apis);
  const model = options.model ?? new ScriptedModel([]);
  const runner = new AgentRunner({ runs, bus, registry, executor, model, maxTurns: options.maxTurns ?? 8 });
  return { db, vault, workspaces, connections, runs, bus, registry, apis, executor, model, runner };
}

export function eventTypes(runs: RunStore, workspaceId: string, runId: string): string[] {
  return runs.events(workspaceId, runId).map((e) => e.event.type);
}
