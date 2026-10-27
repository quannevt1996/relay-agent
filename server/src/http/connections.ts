import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { CONNECTORS } from "../connectors/registry.js";
import { ConnectorError } from "../lib/http.js";
import { OAuthError } from "../oauth/service.js";
import { connectDemo, type Services } from "../services.js";
import type { ProviderId } from "../store/connections.js";
import type { AppEnv } from "./session.js";

export interface ConnectionView {
  provider: ProviderId;
  displayName: string;
  connected: boolean;
  accountName: string | null;
  scopes: string[];
  connectedAt: string | null;
  mode: "demo" | "live";
  /** False when live mode has no OAuth client for this provider. */
  canConnect: boolean;
  setupHint: string | null;
}

/** Codes the UI knows how to explain (see web/src/App.tsx). */
type OAuthFailure = OAuthError["code"] | "access_denied" | "authorization_failed" | "missing_code" | "token_exchange_failed";

function parseProvider(value: string): ProviderId {
  if (value === "slack" || value === "notion") return value;
  throw new HTTPException(404, { message: `Unknown provider "${value}"` });
}

export function connectionRoutes(services: Services): Hono<AppEnv> {
  const { config, connections, oauth } = services;
  const app = new Hono<AppEnv>();
  const backToApp = (params: Record<string, string>) => `${config.webUrl}/?${new URLSearchParams(params)}`;

  app.get("/connections", (c) => {
    const saved = new Map(connections.list(c.get("workspaceId")).map((info) => [info.provider, info]));
    const views: ConnectionView[] = CONNECTORS.map((connector) => {
      const info = saved.get(connector.id);
      const canConnect = config.connectorMode === "demo" || oauth.isConfigured(connector.id);
      const prefix = connector.id.toUpperCase();
      return {
        provider: connector.id,
        displayName: connector.displayName,
        connected: Boolean(info),
        accountName: info?.accountName ?? null,
        scopes: info?.scopes ?? [],
        connectedAt: info?.connectedAt ?? null,
        mode: config.connectorMode,
        canConnect,
        setupHint: canConnect ? null : `Set ${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET to enable OAuth.`,
      };
    });
    return c.json({ connections: views });
  });

  app.delete("/connections/:provider", (c) => {
    const removed = connections.delete(c.get("workspaceId"), parseProvider(c.req.param("provider")));
    return c.json({ ok: true, removed });
  });

  // Errors go back to the UI as a fixed code that it maps to a message, never
  // as free text, so a crafted link cannot make the app display arbitrary words.
  const failed = (provider: ProviderId, code: OAuthFailure) => backToApp({ oauth_error: code, provider });

  // Step 1 of the authorization-code flow: a browser navigation, so errors redirect back to the UI.
  app.get("/oauth/:provider/start", (c) => {
    const provider = parseProvider(c.req.param("provider"));
    const workspaceId = c.get("workspaceId");
    if (config.connectorMode === "demo") {
      connectDemo(services, workspaceId, provider);
      return c.redirect(backToApp({ connected: provider }));
    }
    try {
      return c.redirect(oauth.begin(workspaceId, provider));
    } catch (err) {
      if (err instanceof OAuthError) return c.redirect(failed(provider, err.code));
      throw err;
    }
  });

  // Step 2: the provider redirects back with ?code&state (or ?error when the user said no).
  app.get("/oauth/:provider/callback", async (c) => {
    const provider = parseProvider(c.req.param("provider"));
    const { code, state, error } = c.req.query();
    if (error) return c.redirect(failed(provider, error === "access_denied" ? "access_denied" : "authorization_failed"));
    if (!code || !state) return c.redirect(failed(provider, "missing_code"));
    try {
      await oauth.complete(c.get("workspaceId"), provider, { code, state });
      return c.redirect(backToApp({ connected: provider }));
    } catch (err) {
      if (err instanceof OAuthError) return c.redirect(failed(provider, err.code));
      if (err instanceof ConnectorError) {
        console.warn(`[relay] ${provider} token exchange failed: ${err.message}`);
        return c.redirect(failed(provider, "token_exchange_failed"));
      }
      throw err;
    }
  });

  return app;
}
