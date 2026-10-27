import { serve } from "@hono/node-server";
import { loadConfig, loadEnvFile } from "./config.js";
import { createApp } from "./http/app.js";
import { createServices } from "./services.js";

loadEnvFile();
const config = loadConfig();
const services = createServices(config);

const interrupted = services.runs.failInterrupted();
if (interrupted.length) console.warn(`[relay] marked ${interrupted.length} interrupted run(s) as failed`);

const app = createApp(services);
const server = serve({ fetch: app.fetch, port: config.port }, () => {
  const model = services.runner.modelId;
  console.log(`[relay] listening on ${config.publicUrl}`);
  console.log(`[relay] connectors: ${config.connectorMode}, model: ${model}, skills: ${services.skills.map((s) => s.id).join(", ")}`);
  if (!config.modelConfigured) console.log("[relay] ANTHROPIC_API_KEY not set: using the scripted demo model");
});

function shutdown(signal: string) {
  console.log(`[relay] ${signal}, shutting down`);
  server.close(() => {
    services.db.close();
    process.exit(0);
  });
  // SSE streams keep connections open; don't wait on them forever.
  setTimeout(() => process.exit(0), 3_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
