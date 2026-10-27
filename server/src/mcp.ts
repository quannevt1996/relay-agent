import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, loadEnvFile } from "./config.js";
import { createMcpServer } from "./mcp-server.js";
import { connectDemo, createServices } from "./services.js";

// stdio MCP server. stdout carries the protocol, so all logging goes to stderr.

const DEMO_WORKSPACE_ID = "ws_mcp_demo";

loadEnvFile();
const config = loadConfig();
const services = createServices(config);

let workspaceId = process.env.RELAY_WORKSPACE_ID;
if (config.connectorMode === "demo") {
  workspaceId ??= DEMO_WORKSPACE_ID;
  services.workspaces.getOrCreate(workspaceId, "MCP demo");
  for (const provider of ["slack", "notion"] as const) {
    if (!services.connections.has(workspaceId, provider)) connectDemo(services, workspaceId, provider);
  }
} else if (!workspaceId || !services.workspaces.get(workspaceId)) {
  // Live tokens belong to a workspace; connect Slack/Notion in the web UI first, then pass its id.
  console.error("[relay-mcp] set RELAY_WORKSPACE_ID to a workspace that has connections (GET /api/session shows yours)");
  process.exit(1);
}

const server = createMcpServer({ registry: services.registry, executor: services.executor, workspaceId });
await server.connect(new StdioServerTransport());
console.error(`[relay-mcp] serving ${services.registry.list().length} tools for ${workspaceId} (${config.connectorMode} connectors)`);
