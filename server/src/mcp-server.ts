import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolExecutor, ToolRegistry } from "./connectors/registry.js";

const TITLES: Record<string, string> = {
  slack_list_channels: "List Slack channels",
  slack_read_channel_history: "Read Slack channel history",
  slack_post_message: "Post a Slack message",
  slack_get_user: "Look up a Slack user",
  notion_search: "Search Notion",
  notion_read_page: "Read a Notion page",
  notion_create_page: "Create a Notion page",
  notion_append_to_page: "Append to a Notion page",
};

/**
 * Exposes the same connector tools the agent uses over the Model Context
 * Protocol, so another MCP client (an IDE or a desktop app) can drive
 * Slack and Notion through Relay's connectors and stored credentials.
 *
 * Approval works differently here: the MCP client owns the conversation, so
 * it is responsible for confirming calls. The annotations tell it which tools
 * only read. None of the write tools delete or overwrite anything (they post,
 * create or append), so all of them are marked non-destructive.
 */
export function createMcpServer(deps: { registry: ToolRegistry; executor: ToolExecutor; workspaceId: string }): McpServer {
  const server = new McpServer({ name: "relay", version: "0.1.0" });

  for (const tool of deps.registry.list()) {
    const readOnly = tool.sideEffect === "read";
    server.registerTool(
      tool.name,
      {
        title: TITLES[tool.name] ?? tool.name,
        description: tool.description,
        inputSchema: tool.definition.input,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: false,
          idempotentHint: readOnly,
          openWorldHint: true,
        },
      },
      async (args: unknown) => {
        const outcome = await deps.executor.execute(deps.workspaceId, tool.name, args);
        if (outcome.ok) return { content: [{ type: "text" as const, text: JSON.stringify(outcome.output, null, 2) }] };
        const error = { error: outcome.error, ...(outcome.hint ? { hint: outcome.hint } : {}), ...(outcome.code ? { code: outcome.code } : {}) };
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(error, null, 2) }] };
      },
    );
  }
  return server;
}
