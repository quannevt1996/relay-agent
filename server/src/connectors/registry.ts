import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ConnectorMode } from "../config.js";
import { ConnectorError } from "../lib/http.js";
import type { OAuthService } from "../oauth/service.js";
import type { ProviderId } from "../store/connections.js";
import { createDemoWorld, type DemoWorld } from "./demo/world.js";
import { notionConnector } from "./notion/connector.js";
import { toToolInputSchema } from "./schema.js";
import { slackConnector } from "./slack/connector.js";
import type { Connector, SideEffect, ToolDefinition } from "./types.js";

export const CONNECTORS: Connector[] = [slackConnector, notionConnector];

export interface RegisteredTool {
  name: string;
  description: string;
  sideEffect: SideEffect;
  connector: ProviderId;
  inputSchema: { type: "object"; [key: string]: unknown };
  definition: ToolDefinition<unknown>;
}

export type ToolOutcome =
  | { ok: true; output: unknown }
  | { ok: false; error: string; hint?: string; code?: string };

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(readonly connectors: Connector[] = CONNECTORS) {
    for (const connector of connectors) {
      for (const tool of connector.tools) {
        if (this.tools.has(tool.name)) throw new Error(`Duplicate tool name: ${tool.name}`);
        this.tools.set(tool.name, {
          name: tool.name,
          description: tool.description,
          sideEffect: tool.sideEffect,
          connector: connector.id,
          inputSchema: toToolInputSchema(tool.input),
          definition: tool,
        });
      }
    }
  }

  /** Sorted by name: tools render first in the prompt, so a stable order keeps the cache warm. */
  list(): RegisteredTool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  toAnthropicTools(names: string[]): Anthropic.Beta.BetaTool[] {
    return [...names].sort().map((name) => {
      const tool = this.tools.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      return {
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
        strict: true,
        // Inputs stream as they are generated; ToolExecutor re-validates every input with zod.
        eager_input_streaming: true,
      };
    });
  }

  validate(name: string, input: unknown): { ok: true; data: unknown } | { ok: false; error: string } {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
    const parsed = tool.definition.input.safeParse(input);
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, error: `Invalid input for ${name}:\n${z.prettifyError(parsed.error)}` };
  }
}

/** Hands out connector API clients: in-memory per workspace in demo mode, OAuth-backed in live mode. */
export class ConnectorApis {
  private readonly worlds = new Map<string, DemoWorld>();
  private readonly clients = new Map<string, unknown>();

  constructor(
    readonly mode: ConnectorMode,
    private readonly oauth: Pick<OAuthService, "getAccessToken">,
  ) {}

  get(workspaceId: string, connector: Connector): unknown {
    const key = `${workspaceId}:${connector.id}`;
    let client = this.clients.get(key);
    if (!client) {
      client =
        this.mode === "demo"
          ? connector.createDemoApi(this.demoWorld(workspaceId))
          : connector.createLiveApi(() => this.oauth.getAccessToken(workspaceId, connector.id));
      this.clients.set(key, client);
    }
    return client;
  }

  demoWorld(workspaceId: string): DemoWorld {
    let world = this.worlds.get(workspaceId);
    if (!world) {
      world = createDemoWorld();
      this.worlds.set(workspaceId, world);
    }
    return world;
  }
}

export class ToolExecutor {
  constructor(
    readonly registry: ToolRegistry,
    private readonly apis: ConnectorApis,
  ) {}

  async execute(workspaceId: string, name: string, input: unknown): Promise<ToolOutcome> {
    const validated = this.registry.validate(name, input);
    if (!validated.ok) return { ok: false, error: validated.error, code: "invalid_input" };
    const tool = this.registry.get(name)!;
    const connector = this.registry.connectors.find((c) => c.id === tool.connector)!;

    try {
      const output = await tool.definition.run(this.apis.get(workspaceId, connector), validated.data);
      return { ok: true, output };
    } catch (err) {
      if (err instanceof ConnectorError) return { ok: false, error: err.message, hint: err.hint, code: err.code };
      console.error(`[relay] tool ${name} crashed`, err);
      return { ok: false, error: `${name} failed unexpectedly: ${(err as Error).message}`, code: "internal" };
    }
  }
}
