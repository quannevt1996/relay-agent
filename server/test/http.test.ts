import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptedDemoModel } from "../src/agent/demo-model.js";
import type { RunEvent } from "../src/agent/events.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db.js";
import { createApp } from "../src/http/app.js";
import { notionOAuth, type OAuthProvider } from "../src/oauth/providers.js";
import { createServices, type ServiceOverrides } from "../src/services.js";

const WEB_URL = "http://localhost:5173";

function createTestApp(env: Record<string, string> = {}, oauthProviders?: ServiceOverrides["oauthProviders"]) {
  const config = loadConfig({
    RELAY_DATA_DIR: mkdtempSync(path.join(tmpdir(), "relay-http-")),
    RELAY_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
    RELAY_WEB_URL: WEB_URL,
    ...env,
  });
  const services = createServices(config, {
    db: openDb(":memory:"),
    model: new ScriptedDemoModel({ thinkMs: 0, wordMs: 0 }),
    oauthProviders,
  });
  return { app: createApp(services), services };
}

interface RequestOptions {
  method?: string;
  json?: unknown;
  headers?: Record<string, string>;
}

/** A browser stand-in: remembers the session cookie between requests. */
function browser(app: ReturnType<typeof createApp>) {
  let cookie = "";
  return {
    get cookie() {
      return cookie;
    },
    set cookie(value: string) {
      cookie = value;
    },
    async request(url: string, init: RequestOptions = {}): Promise<Response> {
      const method = init.method ?? (init.json !== undefined ? "POST" : "GET");
      const headers: Record<string, string> = { ...(cookie ? { cookie } : {}), ...init.headers };
      if (init.json !== undefined) headers["content-type"] = "application/json";
      // Browsers attach Origin to every non-GET request; the CSRF check relies on it.
      if (method !== "GET") headers.origin ??= WEB_URL;
      const res = await app.request(url, {
        method,
        headers,
        body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
      });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0]!;
      return res;
    },
    async json<T = any>(url: string, init?: RequestOptions): Promise<T> {
      return (await this.request(url, init)).json() as Promise<T>;
    },
  };
}

function parseSse(body: string): { id?: string; event: RunEvent }[] {
  return body
    .split("\n\n")
    .filter((chunk) => chunk.includes("data:"))
    .map((chunk) => {
      const id = chunk.match(/^id: ?(.*)$/m)?.[1];
      const data = chunk.match(/^data: ?(.*)$/m)![1]!;
      return { ...(id ? { id } : {}), event: JSON.parse(data) as RunEvent };
    });
}

describe("HTTP API", () => {
  it("gives each browser its own workspace through a signed cookie", async () => {
    const { app } = createTestApp();
    const alice = browser(app);
    const first = await alice.json("/api/session");
    const again = await alice.json("/api/session");
    expect(again.workspace.id).toBe(first.workspace.id);
    expect(first).toMatchObject({ connectorMode: "demo", model: { id: "scripted-demo", scripted: true } });

    const mallory = browser(app);
    mallory.cookie = `relay_session=${first.workspace.id}.forged-signature`;
    const forged = await mallory.json("/api/session");
    expect(forged.workspace.id).not.toBe(first.workspace.id);
  });

  it("does not create a workspace for health checks", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/health");
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("lists skills without their prompt bodies", async () => {
    const { app } = createTestApp();
    const { skills } = await browser(app).json("/api/skills");
    expect(skills).toHaveLength(3);
    expect(skills[0]).not.toHaveProperty("instructions");
    expect(skills[0].inputs.length).toBeGreaterThan(0);
  });

  it("runs a skill, pauses for approval, and resumes to a final answer", async () => {
    const { app, services } = createTestApp();
    const alice = browser(app);
    const created = await alice.request("/api/runs", { json: { skillId: "notion-action-items-to-slack" } });
    expect(created.status).toBe(201);
    const { run } = (await created.json()) as { run: { id: string } };
    await services.runner.settled(run.id);

    const paused = await alice.json(`/api/runs/${run.id}`);
    expect(paused.run.status).toBe("awaiting_approval");
    expect(paused.run).not.toHaveProperty("state");
    const [approval] = paused.run.pendingApprovals;
    expect(approval).toMatchObject({ tool: "slack_post_message", input: { channel: "#incidents" } });

    const approved = await alice.request(`/api/runs/${run.id}/approve`, { json: { toolUseId: approval.toolUseId } });
    expect(approved.status).toBe(200);
    await services.runner.settled(run.id);

    const finished = await alice.json(`/api/runs/${run.id}`);
    expect(finished.run.status).toBe("completed");
    expect(finished.events.at(-1).event).toMatchObject({ type: "done", answer: expect.stringContaining("Posted 3 action items") });

    const again = await alice.request(`/api/runs/${run.id}/approve`, { json: { toolUseId: approval.toolUseId } });
    expect(again.status).toBe(409);
  });

  it("passes a rejection reason through to the trace", async () => {
    const { app, services } = createTestApp();
    const alice = browser(app);
    const { run } = await alice.json("/api/runs", { json: { prompt: "Post the action items from the postmortem to #general" } });
    await services.runner.settled(run.id);
    const { run: paused } = await alice.json(`/api/runs/${run.id}`);
    const toolUseId = paused.pendingApprovals[0].toolUseId;

    await alice.request(`/api/runs/${run.id}/reject`, { json: { toolUseId, reason: "Not in #general" } });
    await services.runner.settled(run.id);
    const { events } = await alice.json(`/api/runs/${run.id}`);
    expect(events.map((e: { event: RunEvent }) => e.event)).toContainEqual({
      type: "approval_resolved",
      toolUseId,
      approved: false,
      reason: "Not in #general",
    });
  });

  it("scopes runs to the workspace that created them", async () => {
    const { app, services } = createTestApp();
    const alice = browser(app);
    const bob = browser(app);
    const { run } = await alice.json("/api/runs", { json: { skillId: "slack-channel-digest" } });
    await services.runner.settled(run.id);
    const { run: paused } = await alice.json(`/api/runs/${run.id}`);
    const toolUseId = paused.pendingApprovals[0].toolUseId;

    await bob.request("/api/session");
    expect((await bob.request(`/api/runs/${run.id}`)).status).toBe(404);
    expect((await bob.request(`/api/runs/${run.id}/events`)).status).toBe(404);
    expect((await bob.request(`/api/runs/${run.id}/approve`, { json: { toolUseId } })).status).toBe(404);
    expect((await bob.request(`/api/runs/${run.id}/cancel`, { method: "POST" })).status).toBe(404);
    expect((await bob.json("/api/runs")).runs).toEqual([]);
    expect((await alice.json("/api/runs")).runs).toHaveLength(1);
  });

  it("validates run requests", async () => {
    const { app } = createTestApp();
    const alice = browser(app);
    expect((await alice.request("/api/runs", { json: {} })).status).toBe(400);
    expect((await alice.request("/api/runs", { json: { prompt: "hi", sudo: true } })).status).toBe(400);
    expect((await alice.request("/api/runs", { json: { skillId: "nope" } })).status).toBe(404);
    const badInput = await alice.request("/api/runs", { json: { skillId: "slack-channel-digest", inputs: { colour: "red" } } });
    expect(badInput.status).toBe(400);
    expect(((await badInput.json()) as { error: string }).error).toMatch(/Unknown inputs: colour/);
    expect((await alice.request("/api/nope")).status).toBe(404);
  });

  it("streams the trace as server-sent events and resumes from Last-Event-ID", async () => {
    const { app, services } = createTestApp();
    const alice = browser(app);
    const { run } = await alice.json("/api/runs", { json: { prompt: "What happened in #incidents?" } });
    await services.runner.settled(run.id);

    const res = await alice.request(`/api/runs/${run.id}/events`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await res.text());
    expect(events[0]!.event.type).toBe("run_started");
    expect(events.at(-1)!.event).toMatchObject({ type: "done", status: "completed" });
    expect(events.map((e) => Number(e.id))).toEqual(events.map((_, i) => i + 1));

    const resumed = parseSse(await (await alice.request(`/api/runs/${run.id}/events`, { headers: { "Last-Event-ID": "5" } })).text());
    expect(resumed[0]!.id).toBe("6");
    expect(resumed).toHaveLength(events.length - 5);
  });

  it("keeps an SSE stream open across an approval and closes it when the run is done", async () => {
    const { app, services } = createTestApp();
    const alice = browser(app);
    const { run } = await alice.json("/api/runs", { json: { skillId: "incident-timeline-to-postmortem" } });
    await services.runner.settled(run.id);

    const stream = await alice.request(`/api/runs/${run.id}/events`);
    const body = stream.text();
    const { run: paused } = await alice.json(`/api/runs/${run.id}`);
    await alice.request(`/api/runs/${run.id}/approve`, { json: { toolUseId: paused.pendingApprovals[0].toolUseId } });

    const types = parseSse(await body).map((e) => e.event.type);
    expect(types).toContain("approval_required");
    expect(types).toContain("approval_resolved");
    expect(types).toContain("text_delta");
    expect(types.at(-1)).toBe("done");
  });

  it("rejects cross-site form posts", async () => {
    const { app } = createTestApp();
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" },
      body: "prompt=hi",
    });
    expect(res.status).toBe(403);
  });

  describe("connections in demo mode", () => {
    it("starts connected, can disconnect, and the agent sees the disconnect", async () => {
      const { app, services } = createTestApp();
      const alice = browser(app);
      const { connections } = await alice.json("/api/connections");
      expect(connections.map((c: any) => [c.provider, c.connected, c.mode])).toEqual([
        ["slack", true, "demo"],
        ["notion", true, "demo"],
      ]);

      await alice.request("/api/connections/notion", { method: "DELETE" });
      const after = await alice.json("/api/connections");
      expect(after.connections.find((c: any) => c.provider === "notion").connected).toBe(false);

      const { run } = await alice.json("/api/runs", { json: { skillId: "notion-action-items-to-slack" } });
      await services.runner.settled(run.id);
      const { events } = await alice.json(`/api/runs/${run.id}`);
      const failed = events.find((e: any) => e.event.type === "tool_result").event;
      expect(failed).toMatchObject({ ok: false, error: "Notion is not connected for this workspace" });
      expect(events.at(-1).event.answer).toMatch(/not connected/);

      const reconnect = await alice.request("/api/oauth/notion/start");
      expect(reconnect.status).toBe(302);
      expect(reconnect.headers.get("location")).toBe(`${WEB_URL}/?connected=notion`);
      expect((await alice.json("/api/connections")).connections.every((c: any) => c.connected)).toBe(true);
    });
  });

  describe("OAuth in live mode", () => {
    const fakeSlack: OAuthProvider = {
      id: "slack",
      displayName: "Slack",
      pkce: false,
      authorizationUrl: (client, { redirectUri, state }) =>
        `https://slack.example/authorize?${new URLSearchParams({ client_id: client.clientId, redirect_uri: redirectUri, state })}`,
      exchangeCode: async (_client, { code }) => ({ accessToken: `xoxb-${code}`, scopes: ["chat:write"], accountId: "T1", accountName: "Acme" }),
      refresh: async () => {
        throw new Error("not used");
      },
    };
    const liveApp = () =>
      createTestApp(
        { SLACK_CLIENT_ID: "client-id", SLACK_CLIENT_SECRET: "client-secret", RELAY_PUBLIC_URL: "http://localhost:8787" },
        { slack: fakeSlack, notion: notionOAuth },
      );
    const stateFrom = (location: string) => new URL(location).searchParams.get("state")!;
    const oauthError = (res: Response) => new URL(res.headers.get("location")!).searchParams.get("oauth_error");

    it("connects through the authorization-code flow and stores the token encrypted", async () => {
      const { app, services } = liveApp();
      const alice = browser(app);
      const before = await alice.json("/api/connections");
      expect(before.connections.map((c: any) => [c.provider, c.connected, c.canConnect])).toEqual([
        ["slack", false, true],
        ["notion", false, false],
      ]);
      expect(before.connections[1].setupHint).toMatch(/NOTION_CLIENT_ID/);

      const start = await alice.request("/api/oauth/slack/start");
      const location = start.headers.get("location")!;
      expect(location).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A8787%2Fapi%2Foauth%2Fslack%2Fcallback");

      const callback = await alice.request(`/api/oauth/slack/callback?code=abc&state=${stateFrom(location)}`);
      expect(callback.headers.get("location")).toBe(`${WEB_URL}/?connected=slack`);
      const slack = (await alice.json("/api/connections")).connections[0];
      expect(slack).toMatchObject({ connected: true, accountName: "Acme", mode: "live" });

      const raw = services.db.prepare("SELECT access_token_enc FROM connections").get() as { access_token_enc: string };
      expect(raw.access_token_enc).not.toContain("xoxb-abc");
    });

    it("refuses a state that was issued to another workspace, and burns it", async () => {
      const { app } = liveApp();
      const alice = browser(app);
      const mallory = browser(app);
      const state = stateFrom((await alice.request("/api/oauth/slack/start")).headers.get("location")!);

      const stolen = await mallory.request(`/api/oauth/slack/callback?code=abc&state=${state}`);
      expect(oauthError(stolen)).toContain("does not belong to this workspace");
      const replay = await alice.request(`/api/oauth/slack/callback?code=abc&state=${state}`);
      expect(oauthError(replay)).toContain("already used");
      expect((await mallory.json("/api/connections")).connections[0].connected).toBe(false);
    });

    it("reports a denied consent screen and an unconfigured provider back to the UI", async () => {
      const { app } = liveApp();
      const alice = browser(app);
      const denied = await alice.request("/api/oauth/slack/callback?error=access_denied&state=x");
      expect(oauthError(denied)).toBe("slack: access_denied");
      const notion = await alice.request("/api/oauth/notion/start");
      expect(oauthError(notion)).toMatch(/NOTION_CLIENT_ID/);
      expect((await alice.request("/api/oauth/github/start")).status).toBe(404);
    });
  });
});
