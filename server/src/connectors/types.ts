import type { z } from "zod";
import type { ProviderId } from "../store/connections.js";
import type { DemoWorld } from "./demo/world.js";

export type SideEffect = "read" | "write";

export interface ToolDefinition<Api, Schema extends z.ZodType = z.ZodType> {
  /** Globally unique, prefixed with the connector id (`slack_post_message`). */
  name: string;
  /** Written for the model: what the tool does and when to reach for it. */
  description: string;
  /** Source of truth for the input: converted to JSON Schema for the model and MCP, and re-checked before every call. */
  input: Schema;
  /** Write tools pause the run for human approval unless the run auto-approves. */
  sideEffect: SideEffect;
  run(api: Api, input: z.output<Schema>): Promise<unknown>;
}

/** Identity function that exists for inference: `run` gets the parsed type of `input`. */
export function defineTool<Api, Schema extends z.ZodType>(tool: ToolDefinition<Api, Schema>): ToolDefinition<Api, Schema> {
  return tool;
}

/**
 * A connector bundles the tools for one SaaS product with the two ways of
 * obtaining an API client: a live one backed by OAuth tokens, and an
 * in-memory one used for demo mode and tests. Tools only see the interface.
 */
export interface Connector<Api = any> {
  id: ProviderId;
  displayName: string;
  tools: ToolDefinition<Api>[];
  createLiveApi(getAccessToken: () => Promise<string>): Api;
  createDemoApi(world: DemoWorld): Api;
}
