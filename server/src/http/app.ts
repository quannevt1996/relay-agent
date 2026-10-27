import { existsSync } from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { DEMO_MODEL_ID } from "../agent/demo-model.js";
import { RunError } from "../agent/runner.js";
import type { Services } from "../services.js";
import { SkillError } from "../skills/loader.js";
import { connectionRoutes } from "./connections.js";
import { runRoutes } from "./runs.js";
import { workspaceSession, type AppEnv } from "./session.js";

const RUN_ERROR_STATUS = { invalid: 400, not_found: 404, conflict: 409 } as const;

export function createApp(services: Services): Hono<AppEnv> {
  const { config, runner } = services;
  const app = new Hono<AppEnv>();

  app.use("*", secureHeaders());
  // Mutating requests must come from the app's own origin(s). JSON bodies
  // already force a CORS preflight cross-site; this also covers form posts.
  const trustedOrigins = [config.publicUrl, ...(config.webUrl ? [config.webUrl] : [])].map((url) => new URL(url).origin);
  app.use("/api/*", csrf({ origin: trustedOrigins }));

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.use("/api/*", workspaceSession(services));

  app.get("/api/session", (c) => {
    const workspace = services.workspaces.get(c.get("workspaceId"))!;
    return c.json({
      workspace,
      connectorMode: config.connectorMode,
      model: { id: runner.modelId, scripted: runner.modelId === DEMO_MODEL_ID },
      maxTurns: config.maxTurns,
    });
  });

  app.route("/api", connectionRoutes(services));
  app.route("/api", runRoutes(services));
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof RunError) return c.json({ error: err.message }, RUN_ERROR_STATUS[err.code]);
    if (err instanceof SkillError) return c.json({ error: err.message }, 400);
    console.error("[relay] unhandled error", err);
    return c.json({ error: "Internal server error" }, 500);
  });

  // The built React app, with index.html as the fallback for client-side routes.
  if (existsSync(path.join(config.webDistDir, "index.html"))) {
    app.use("/*", serveStatic({ root: config.webDistDir }));
    app.get("*", serveStatic({ root: config.webDistDir, path: "index.html" }));
  } else {
    app.get("/", (c) => c.text("The web UI is not built yet. Run `npm run build`, or `npm run dev` for the Vite dev server.", 404));
  }

  return app;
}
