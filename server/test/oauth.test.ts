import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.js";
import { ConnectorError } from "../src/lib/http.js";
import { notionOAuth, slackOAuth, SLACK_BOT_SCOPES, type OAuthProvider } from "../src/oauth/providers.js";
import { OAuthError, OAuthService } from "../src/oauth/service.js";
import { Vault } from "../src/security/vault.js";
import { ConnectionStore, type TokenSet } from "../src/store/connections.js";
import { WorkspaceStore } from "../src/store/workspaces.js";

const CLIENT = { clientId: "client-id", clientSecret: "client-secret" };

function fakeProvider(overrides: Partial<OAuthProvider> = {}): OAuthProvider {
  return {
    id: "slack",
    displayName: "Slack",
    pkce: false,
    authorizationUrl: (_client, { state, codeChallenge }) =>
      `https://provider.example/authorize?state=${state}${codeChallenge ? `&code_challenge=${codeChallenge}` : ""}`,
    exchangeCode: vi.fn(async (): Promise<TokenSet> => ({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 3_600_000, scopes: ["a"] })),
    refresh: vi.fn(async (): Promise<TokenSet> => ({ accessToken: "access-2", refreshToken: "refresh-2", expiresAt: Date.now() + 3_600_000, scopes: [] })),
    ...overrides,
  };
}

function setup(slack = fakeProvider()) {
  const db = openDb(":memory:");
  const workspaces = new WorkspaceStore(db);
  const connections = new ConnectionStore(db, new Vault(randomBytes(32)));
  let now = 1_000_000;
  const service = new OAuthService({
    db,
    connections,
    config: { publicUrl: "https://relay.example", oauthClients: { slack: CLIENT, notion: CLIENT } },
    providers: { slack, notion: { ...fakeProvider(), id: "notion", displayName: "Notion" } },
    now: () => now,
  });
  return {
    service,
    connections,
    slack,
    a: workspaces.create("A").id,
    b: workspaces.create("B").id,
    advance: (ms: number) => (now += ms),
  };
}

const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

describe("OAuthService state handling", () => {
  it("issues an unguessable state and completes the flow once", async () => {
    const t = setup();
    const url = t.service.begin(t.a, "slack");
    const state = stateOf(url);
    expect(Buffer.from(state, "base64url")).toHaveLength(32);

    await t.service.complete(t.a, "slack", { code: "c", state });
    expect(t.slack.exchangeCode).toHaveBeenCalledWith(
      CLIENT,
      { code: "c", redirectUri: "https://relay.example/api/oauth/slack/callback", codeVerifier: undefined },
      undefined,
    );
    expect(t.connections.getTokens(t.a, "slack")?.accessToken).toBe("access-1");

    await expect(t.service.complete(t.a, "slack", { code: "c", state })).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("rejects unknown and expired states", async () => {
    const t = setup();
    await expect(t.service.complete(t.a, "slack", { code: "c", state: "made-up" })).rejects.toBeInstanceOf(OAuthError);
    const state = stateOf(t.service.begin(t.a, "slack"));
    t.advance(10 * 60_000 + 1);
    await expect(t.service.complete(t.a, "slack", { code: "c", state })).rejects.toMatchObject({ code: "expired_state" });
    expect(t.slack.exchangeCode).not.toHaveBeenCalled();
  });

  it("binds the state to the workspace and provider that started the flow", async () => {
    const t = setup();
    const forOtherWorkspace = stateOf(t.service.begin(t.a, "slack"));
    await expect(t.service.complete(t.b, "slack", { code: "c", state: forOtherWorkspace })).rejects.toMatchObject({
      code: "state_mismatch",
    });
    const forOtherProvider = stateOf(t.service.begin(t.a, "slack"));
    await expect(t.service.complete(t.a, "notion", { code: "c", state: forOtherProvider })).rejects.toMatchObject({
      code: "state_mismatch",
    });
    expect(t.connections.list(t.a)).toEqual([]);
    expect(t.connections.list(t.b)).toEqual([]);
  });

  it("sends a PKCE S256 challenge and the matching verifier for providers that use it", async () => {
    const t = setup(fakeProvider({ pkce: true }));
    const url = new URL(t.service.begin(t.a, "slack"));
    await t.service.complete(t.a, "slack", { code: "c", state: url.searchParams.get("state")! });
    const verifier = vi.mocked(t.slack.exchangeCode).mock.calls[0]![1].codeVerifier!;
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
  });

  it("refuses to start when the provider has no client credentials", () => {
    const db = openDb(":memory:");
    const service = new OAuthService({
      db,
      connections: new ConnectionStore(db, new Vault(randomBytes(32))),
      config: { publicUrl: "http://x", oauthClients: {} },
    });
    expect(() => service.begin("ws", "notion")).toThrow(/NOTION_CLIENT_ID/);
  });
});

describe("OAuthService access tokens", () => {
  it("explains when a provider is not connected", async () => {
    const t = setup();
    const err = await t.service.getAccessToken(t.a, "slack").catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorError);
    expect(err).toMatchObject({ code: "not_connected", hint: expect.stringContaining("Connections") });
  });

  it("refreshes an expiring token once, even for concurrent callers, and keeps the new refresh token", async () => {
    const t = setup();
    t.connections.save(t.a, "slack", { accessToken: "old", refreshToken: "refresh-0", expiresAt: 1_000_000 + 30_000, scopes: ["a"] });

    const [first, second] = await Promise.all([t.service.getAccessToken(t.a, "slack"), t.service.getAccessToken(t.a, "slack")]);
    expect([first, second]).toEqual(["access-2", "access-2"]);
    expect(t.slack.refresh).toHaveBeenCalledTimes(1);
    expect(t.slack.refresh).toHaveBeenCalledWith(CLIENT, "refresh-0", undefined);
    expect(t.connections.getTokens(t.a, "slack")).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2", scopes: ["a"] });
  });

  it("returns a still-valid token without refreshing, and asks to reconnect when it cannot refresh", async () => {
    const t = setup();
    t.connections.save(t.a, "slack", { accessToken: "valid", expiresAt: 1_000_000 + 3_600_000, scopes: [] });
    expect(await t.service.getAccessToken(t.a, "slack")).toBe("valid");
    t.connections.save(t.a, "slack", { accessToken: "stale", expiresAt: 1_000_000, scopes: [] });
    await expect(t.service.getAccessToken(t.a, "slack")).rejects.toMatchObject({ code: "auth" });
    expect(t.slack.refresh).not.toHaveBeenCalled();
  });
});

describe("provider definitions", () => {
  it("builds the Slack and Notion authorization URLs", () => {
    const slack = new URL(slackOAuth.authorizationUrl(CLIENT, { redirectUri: "https://r/cb", state: "s" }));
    expect(slack.origin + slack.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(slack.searchParams.get("scope")).toBe(SLACK_BOT_SCOPES.join(","));
    expect(slack.searchParams.get("state")).toBe("s");

    const notion = new URL(notionOAuth.authorizationUrl(CLIENT, { redirectUri: "https://r/cb", state: "s" }));
    expect(Object.fromEntries(notion.searchParams)).toMatchObject({ response_type: "code", owner: "user", redirect_uri: "https://r/cb" });
  });

  it("exchanges a Slack code and surfaces Slack's error field", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ ok: true, access_token: "xoxb-1", scope: "chat:write,channels:read", team: { id: "T1", name: "Acme" } }),
    );
    const tokens = await slackOAuth.exchangeCode(CLIENT, { code: "c", redirectUri: "https://r/cb" }, { fetch });
    expect(tokens).toMatchObject({ accessToken: "xoxb-1", scopes: ["chat:write", "channels:read"], accountName: "Acme" });
    const body = new URLSearchParams(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(Object.fromEntries(body)).toMatchObject({ client_id: "client-id", code: "c", grant_type: "authorization_code" });

    const failing = vi.fn(async () => Response.json({ ok: false, error: "invalid_code" }));
    await expect(slackOAuth.exchangeCode(CLIENT, { code: "c", redirectUri: "x" }, { fetch: failing })).rejects.toThrow(/invalid_code/);
  });

  it("exchanges a Notion code with HTTP Basic client authentication", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ access_token: "secret_1", bot_id: "b", workspace_id: "w1", workspace_name: "Acme Notion" }),
    );
    const tokens = await notionOAuth.exchangeCode(CLIENT, { code: "c", redirectUri: "https://r/cb" }, { fetch });
    expect(tokens).toMatchObject({ accessToken: "secret_1", accountId: "w1", accountName: "Acme Notion" });
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("client-id:client-secret").toString("base64")}`);
  });
});
