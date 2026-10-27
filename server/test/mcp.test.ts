import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { ConnectorApis, ToolExecutor, ToolRegistry } from "../src/connectors/registry.js";
import { createMcpServer } from "../src/mcp-server.js";

async function connect() {
  const registry = new ToolRegistry();
  const apis = new ConnectorApis("demo", { getAccessToken: async () => "unused" });
  const server = createMcpServer({ registry, executor: new ToolExecutor(registry, apis), workspaceId: "ws_mcp_test" });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, world: apis.demoWorld("ws_mcp_test") };
}

describe("MCP server", () => {
  it("lists every connector tool with read-only and destructive hints", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "notion_append_to_page",
      "notion_create_page",
      "notion_read_page",
      "notion_search",
      "slack_get_user",
      "slack_list_channels",
      "slack_post_message",
      "slack_read_channel_history",
    ]);

    const post = tools.find((t) => t.name === "slack_post_message")!;
    expect(post.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    expect(post.inputSchema.required).toEqual(["channel", "text"]);
    const search = tools.find((t) => t.name === "notion_search")!;
    expect(search.annotations).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(search.title).toBe("Search Notion");
  });

  it("runs tools through the connectors and reports errors as tool errors", async () => {
    const { client, world } = await connect();
    const ok = await client.callTool({ name: "slack_post_message", arguments: { channel: "#general", text: "from MCP" } });
    expect(ok.isError).toBeFalsy();
    expect(world.slack.messages.get("C01GENERAL")!.at(-1)!.text).toBe("from MCP");

    const failed = await client.callTool({ name: "notion_read_page", arguments: { page: "1f0e8c2a-0000-4000-8000-000000000099" } });
    expect(failed.isError).toBe(true);
    const [content] = failed.content as { type: string; text: string }[];
    expect(JSON.parse(content!.text)).toMatchObject({ code: "not_found", hint: expect.stringContaining("Share the page") });
  });
});
