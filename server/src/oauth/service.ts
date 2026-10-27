import { createHash, randomBytes } from "node:crypto";
import type { Config, OAuthClientCredentials } from "../config.js";
import type { Db } from "../db.js";
import { ConnectorError, type HttpOptions } from "../lib/http.js";
import type { ConnectionStore, ProviderId, TokenSet } from "../store/connections.js";
import { OAUTH_PROVIDERS, type OAuthProvider } from "./providers.js";

const STATE_TTL_MS = 10 * 60_000;
const REFRESH_SKEW_MS = 60_000;

export class OAuthError extends Error {
  constructor(
    readonly code: "not_configured" | "invalid_state" | "expired_state" | "state_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

interface StateRow {
  workspace_id: string;
  provider: ProviderId;
  code_verifier: string | null;
  expires_at: number;
}

export interface OAuthServiceDeps {
  db: Db;
  connections: ConnectionStore;
  config: Pick<Config, "publicUrl" | "oauthClients">;
  providers?: Record<ProviderId, OAuthProvider>;
  http?: HttpOptions;
  now?: () => number;
}

/**
 * Authorization-code flow with server-side state: each `state` is random,
 * single-use, expires after ten minutes, and is bound to the workspace that
 * started the flow (so a callback can't attach tokens to someone else's
 * workspace). Access tokens are refreshed transparently when the provider
 * issued a refresh token.
 */
export class OAuthService {
  private readonly providers: Record<ProviderId, OAuthProvider>;
  private readonly now: () => number;
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(private readonly deps: OAuthServiceDeps) {
    this.providers = deps.providers ?? OAUTH_PROVIDERS;
    this.now = deps.now ?? Date.now;
  }

  isConfigured(provider: ProviderId): boolean {
    return Boolean(this.deps.config.oauthClients[provider]);
  }

  redirectUri(provider: ProviderId): string {
    return `${this.deps.config.publicUrl}/api/oauth/${provider}/callback`;
  }

  begin(workspaceId: string, providerId: ProviderId): string {
    const client = this.client(providerId);
    const provider = this.providers[providerId];
    const state = randomBytes(32).toString("base64url");
    const verifier = provider.pkce ? randomBytes(32).toString("base64url") : null;
    const challenge = verifier ? createHash("sha256").update(verifier).digest("base64url") : undefined;

    const { db } = this.deps;
    db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").run(this.now());
    db.prepare("INSERT INTO oauth_states (state, workspace_id, provider, code_verifier, expires_at) VALUES (?, ?, ?, ?, ?)").run(
      state,
      workspaceId,
      providerId,
      verifier,
      this.now() + STATE_TTL_MS,
    );
    return provider.authorizationUrl(client, { redirectUri: this.redirectUri(providerId), state, codeChallenge: challenge });
  }

  async complete(workspaceId: string, providerId: ProviderId, params: { code: string; state: string }): Promise<TokenSet> {
    const client = this.client(providerId);
    const row = this.consumeState(params.state);
    if (!row) throw new OAuthError("invalid_state", "Unknown or already used OAuth state");
    if (row.expires_at < this.now()) throw new OAuthError("expired_state", "The OAuth flow took too long; please try again");
    if (row.provider !== providerId || row.workspace_id !== workspaceId) {
      throw new OAuthError("state_mismatch", "OAuth state does not belong to this workspace");
    }

    const tokens = await this.providers[providerId].exchangeCode(
      client,
      { code: params.code, redirectUri: this.redirectUri(providerId), codeVerifier: row.code_verifier ?? undefined },
      this.deps.http,
    );
    this.deps.connections.save(workspaceId, providerId, tokens);
    return tokens;
  }

  /** Returns a usable access token, refreshing it first if it is about to expire. */
  async getAccessToken(workspaceId: string, providerId: ProviderId): Promise<string> {
    const provider = this.providers[providerId];
    const tokens = this.deps.connections.getTokens(workspaceId, providerId);
    if (!tokens) {
      throw new ConnectorError(
        "not_connected",
        `${provider.displayName} is not connected for this workspace`,
        `Ask the user to connect ${provider.displayName} on the Connections page.`,
      );
    }
    if (!tokens.expiresAt || tokens.expiresAt - REFRESH_SKEW_MS > this.now()) return tokens.accessToken;
    if (!tokens.refreshToken) {
      throw new ConnectorError("auth", `${provider.displayName} token expired`, `Reconnect ${provider.displayName}.`);
    }

    // Collapse concurrent refreshes: providers that rotate refresh tokens
    // invalidate the old one on first use.
    const key = `${workspaceId}:${providerId}`;
    let pending = this.refreshing.get(key);
    if (!pending) {
      pending = this.refresh(workspaceId, providerId, tokens).finally(() => this.refreshing.delete(key));
      this.refreshing.set(key, pending);
    }
    return pending;
  }

  private async refresh(workspaceId: string, providerId: ProviderId, current: TokenSet): Promise<string> {
    const refreshed = await this.providers[providerId].refresh(this.client(providerId), current.refreshToken!, this.deps.http);
    this.deps.connections.save(workspaceId, providerId, {
      ...current,
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? current.refreshToken,
      scopes: refreshed.scopes.length ? refreshed.scopes : current.scopes,
      accountId: refreshed.accountId ?? current.accountId,
      accountName: refreshed.accountName ?? current.accountName,
    });
    return refreshed.accessToken;
  }

  private consumeState(state: string): StateRow | undefined {
    const row = this.deps.db
      .prepare("DELETE FROM oauth_states WHERE state = ? RETURNING workspace_id, provider, code_verifier, expires_at")
      .get(state) as StateRow | undefined;
    return row;
  }

  private client(providerId: ProviderId): OAuthClientCredentials {
    const client = this.deps.config.oauthClients[providerId];
    if (!client) {
      throw new OAuthError("not_configured", `${providerId.toUpperCase()}_CLIENT_ID / _CLIENT_SECRET are not set`);
    }
    return client;
  }
}
