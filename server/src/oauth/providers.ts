import type { OAuthClientCredentials } from "../config.js";
import { ConnectorError, request, type HttpOptions } from "../lib/http.js";
import type { ProviderId, TokenSet } from "../store/connections.js";

export interface AuthorizeParams {
  redirectUri: string;
  state: string;
  codeChallenge?: string;
}

export interface OAuthProvider {
  id: ProviderId;
  displayName: string;
  /** Send an S256 code_challenge; the verifier is kept server-side with the state. */
  pkce: boolean;
  authorizationUrl(client: OAuthClientCredentials, params: AuthorizeParams): string;
  exchangeCode(
    client: OAuthClientCredentials,
    params: { code: string; redirectUri: string; codeVerifier?: string },
    http?: HttpOptions,
  ): Promise<TokenSet>;
  refresh(client: OAuthClientCredentials, refreshToken: string, http?: HttpOptions): Promise<TokenSet>;
}

const expiresAt = (expiresIn: unknown) => (typeof expiresIn === "number" ? Date.now() + expiresIn * 1000 : undefined);

// --- Slack: https://api.slack.com/authentication/oauth-v2 ---------------------------------------

export const SLACK_BOT_SCOPES = ["channels:read", "channels:history", "groups:read", "groups:history", "chat:write", "users:read"];

interface SlackTokenResponse {
  ok: boolean;
  error?: string;
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope: string;
  team?: { id: string; name: string };
}

async function slackTokenRequest(
  client: OAuthClientCredentials,
  params: Record<string, string>,
  http?: HttpOptions,
): Promise<TokenSet> {
  const body = new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...params });
  const res = await request(
    "https://slack.com/api/oauth.v2.access",
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body },
    http,
  );
  const json = (await res.json()) as SlackTokenResponse;
  if (!json.ok) throw new ConnectorError("auth", `Slack token exchange failed: ${json.error ?? res.status}`);
  return {
    accessToken: json.access_token,
    // Present only when the app has token rotation enabled.
    refreshToken: json.refresh_token,
    expiresAt: expiresAt(json.expires_in),
    scopes: json.scope.split(","),
    accountId: json.team?.id,
    accountName: json.team?.name,
  };
}

export const slackOAuth: OAuthProvider = {
  id: "slack",
  displayName: "Slack",
  pkce: false,
  authorizationUrl(client, { redirectUri, state }) {
    const url = new URL("https://slack.com/oauth/v2/authorize");
    url.search = new URLSearchParams({
      client_id: client.clientId,
      scope: SLACK_BOT_SCOPES.join(","),
      redirect_uri: redirectUri,
      state,
    }).toString();
    return url.toString();
  },
  exchangeCode: (client, { code, redirectUri }, http) =>
    slackTokenRequest(client, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, http),
  refresh: (client, refreshToken, http) =>
    slackTokenRequest(client, { grant_type: "refresh_token", refresh_token: refreshToken }, http),
};

// --- Notion: https://developers.notion.com/docs/authorization ------------------------------------

interface NotionTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  bot_id: string;
  workspace_id: string;
  workspace_name?: string;
  error?: string;
  error_description?: string;
}

async function notionTokenRequest(
  client: OAuthClientCredentials,
  body: Record<string, string>,
  http?: HttpOptions,
): Promise<TokenSet> {
  const basic = Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64");
  const res = await request(
    "https://api.notion.com/v1/oauth/token",
    {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    http,
  );
  const json = (await res.json()) as NotionTokenResponse;
  if (!res.ok) {
    throw new ConnectorError("auth", `Notion token exchange failed: ${json.error_description ?? json.error ?? res.status}`);
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: expiresAt(json.expires_in),
    // Notion grants access per shared page rather than per scope.
    scopes: [],
    accountId: json.workspace_id,
    accountName: json.workspace_name,
  };
}

export const notionOAuth: OAuthProvider = {
  id: "notion",
  displayName: "Notion",
  pkce: false,
  authorizationUrl(client, { redirectUri, state }) {
    const url = new URL("https://api.notion.com/v1/oauth/authorize");
    url.search = new URLSearchParams({
      client_id: client.clientId,
      response_type: "code",
      owner: "user",
      redirect_uri: redirectUri,
      state,
    }).toString();
    return url.toString();
  },
  exchangeCode: (client, { code, redirectUri }, http) =>
    notionTokenRequest(client, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, http),
  refresh: (client, refreshToken, http) =>
    notionTokenRequest(client, { grant_type: "refresh_token", refresh_token: refreshToken }, http),
};

export const OAUTH_PROVIDERS: Record<ProviderId, OAuthProvider> = { slack: slackOAuth, notion: notionOAuth };
