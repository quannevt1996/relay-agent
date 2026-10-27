import { describe, expect, it, vi } from "vitest";
import { createDemoWorld } from "../src/connectors/demo/world.js";
import { NotionRestApi } from "../src/connectors/notion/api.js";
import { FakeNotionApi } from "../src/connectors/notion/fake.js";
import { blocksToMarkdown, markdownToBlocks, normalizePageId } from "../src/connectors/notion/markdown.js";
import { ConnectorApis, ToolExecutor, ToolRegistry } from "../src/connectors/registry.js";
import { SlackWebApi } from "../src/connectors/slack/api.js";
import { FakeSlackApi } from "../src/connectors/slack/fake.js";
import { ConnectorError, request } from "../src/lib/http.js";

const POSTMORTEM = "1f0e8c2a-0000-4000-8000-000000000005";
const noLiveTokens = { getAccessToken: async () => "unused" };

describe("ToolRegistry", () => {
  const registry = new ToolRegistry();

  it("exposes every connector tool once, sorted, with a side-effect flag", () => {
    expect(registry.list().map((t) => [t.name, t.sideEffect])).toEqual([
      ["notion_append_to_page", "write"],
      ["notion_create_page", "write"],
      ["notion_read_page", "read"],
      ["notion_search", "read"],
      ["slack_get_user", "read"],
      ["slack_list_channels", "read"],
      ["slack_post_message", "write"],
      ["slack_read_channel_history", "read"],
    ]);
  });

  it("emits strict-compatible JSON schemas and keeps the dropped limits in zod", () => {
    for (const tool of registry.list()) {
      const json = JSON.stringify(tool.inputSchema);
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(json).not.toMatch(/"(minLength|maxLength|minimum|maximum|\$schema)"/);
    }
    const [post] = registry.toAnthropicTools(["slack_post_message"]);
    expect(post).toMatchObject({ name: "slack_post_message", strict: true, eager_input_streaming: true });
    const tooLong = registry.validate("slack_post_message", { channel: "#general", text: "x".repeat(4001) });
    expect(tooLong).toMatchObject({ ok: false, error: expect.stringContaining("Invalid input for slack_post_message") });
    expect(registry.validate("nope", {})).toEqual({ ok: false, error: "Unknown tool: nope" });
  });
});

describe("ToolExecutor with demo connectors", () => {
  const setup = () => {
    const apis = new ConnectorApis("demo", noLiveTokens);
    return { apis, executor: new ToolExecutor(new ToolRegistry(), apis) };
  };

  it("reads a channel window oldest-first and resolves channel names case-insensitively", async () => {
    const { executor } = setup();
    const result = await executor.execute("ws", "slack_read_channel_history", { channel: "#Eng-Standup", hours_back: 12 });
    if (!result.ok) throw new Error(result.error);
    const output = result.output as { channel: { id: string }; messages: { postedAt: string; text: string }[] };
    expect(output.channel.id).toBe("C02STANDUP");
    expect(output.messages.map((m) => m.text.slice(0, 7))).toEqual(["Update:", "Nice wo"]);
    expect(output.messages[0]!.postedAt < output.messages[1]!.postedAt).toBe(true);
  });

  it("returns typed errors with hints instead of throwing", async () => {
    const { executor } = setup();
    expect(await executor.execute("ws", "slack_read_channel_history", { channel: "#nope" })).toMatchObject({
      ok: false,
      code: "not_found",
      hint: expect.stringContaining("#eng-standup"),
    });
    expect(await executor.execute("ws", "notion_read_page", { page: "not a page" })).toMatchObject({
      ok: false,
      code: "invalid_request",
      hint: expect.stringContaining("notion_search"),
    });
    expect(await executor.execute("ws", "slack_post_message", { channel: "#general" })).toMatchObject({
      ok: false,
      code: "invalid_input",
    });
  });

  it("keeps each workspace's demo world separate", async () => {
    const { apis, executor } = setup();
    await executor.execute("ws_a", "slack_post_message", { channel: "#general", text: "only in A" });
    const lastInA = apis.demoWorld("ws_a").slack.messages.get("C01GENERAL")!.at(-1)!.text;
    const lastInB = apis.demoWorld("ws_b").slack.messages.get("C01GENERAL")!.at(-1)!.text;
    expect(lastInA).toBe("only in A");
    expect(lastInB).not.toBe("only in A");
  });

  it("reports not_connected in demo mode once a workspace disconnects", async () => {
    const apis = new ConnectorApis("demo", noLiveTokens, (_ws, provider) => provider !== "notion");
    const executor = new ToolExecutor(new ToolRegistry(), apis);
    expect(await executor.execute("ws", "notion_search", { query: "" })).toMatchObject({ ok: false, code: "not_connected" });
    expect((await executor.execute("ws", "slack_list_channels", {})).ok).toBe(true);
  });
});

describe("fake Slack and Notion APIs", () => {
  it("mirrors Slack's channel and thread errors", async () => {
    const slack = new FakeSlackApi(createDemoWorld().slack);
    await expect(slack.postMessage("C999", "x")).rejects.toMatchObject({ code: "not_found" });
    await expect(slack.postMessage("C01GENERAL", "x", "123.456")).rejects.toMatchObject({ code: "upstream" });
    await expect(slack.getUser("U404")).rejects.toMatchObject({ code: "not_found" });
  });

  it("searches, reads with child pages, creates and appends", async () => {
    const notion = new FakeNotionApi(createDemoWorld().notion);
    // Matches titles and content, most recently edited first.
    expect((await notion.search("roadmap", 10)).map((p) => p.title)).toEqual(["Q4 Roadmap", "Engineering Wiki"]);
    expect((await notion.search("", 3)).length).toBe(3);

    const wiki = await notion.readPage("1f0e8c2a-0000-4000-8000-000000000001");
    expect(wiki.markdown).toContain("📄 Standup Notes (page id: 1f0e8c2a-0000-4000-8000-000000000002)");

    await expect(notion.createPage("1f0e8c2a-0000-4000-8000-000000000099", "x", "y")).rejects.toMatchObject({
      code: "not_found",
      hint: expect.stringContaining("Share the page"),
    });
    const created = await notion.createPage(POSTMORTEM, "Child", "- [ ] a");
    expect((await notion.readPage(POSTMORTEM)).markdown).toContain(`Child (page id: ${created.id})`);
    expect(await notion.appendToPage(POSTMORTEM, "## New\n- b")).toEqual({ pageId: POSTMORTEM, appendedBlocks: 2 });
  });
});

describe("Notion markdown conversion", () => {
  it("converts the supported Markdown subset to blocks and back", () => {
    const markdown = ["# Title", "## Section", "- bullet", "1. first", "- [ ] todo", "- [x] done", "> quote", "---", "```ts", "const x = 1;", "```", "Plain text"].join(
      "\n",
    );
    const blocks = markdownToBlocks(markdown);
    expect(blocks.map((b) => b.type)).toEqual([
      "heading_1",
      "heading_2",
      "bulleted_list_item",
      "numbered_list_item",
      "to_do",
      "to_do",
      "quote",
      "divider",
      "code",
      "paragraph",
    ]);
    expect(blocksToMarkdown(blocks)).toBe(markdown);
  });

  it("splits text over Notion's 2000-character rich-text limit", () => {
    const [block] = markdownToBlocks("x".repeat(4500));
    expect((block!.paragraph as { rich_text: unknown[] }).rich_text).toHaveLength(3);
  });

  it("normalises page ids and URLs", () => {
    const id = "1f0e8c2a-0000-4000-8000-000000000005";
    expect(normalizePageId(id.replace(/-/g, ""))).toBe(id);
    expect(normalizePageId(`https://www.notion.so/acme/Postmortem-${id.replace(/-/g, "")}?pvs=4`)).toBe(id);
    expect(normalizePageId("Postmortem")).toBeUndefined();
  });
});

describe("HTTP helper", () => {
  it("retries 429s using Retry-After, then returns the response", async () => {
    const sleep = vi.fn(async () => {});
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(new Response("ok"));
    const res = await request("https://api.example/x", {}, { fetch, sleep });
    expect(await res.text()).toBe("ok");
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it("gives up after maxAttempts and does not wait longer than the cap", async () => {
    const sleep = vi.fn(async () => {});
    const limited = () => new Response("", { status: 429, headers: { "retry-after": "1" } });
    const res = await request("https://api.example/x", {}, { fetch: vi.fn(async () => limited()), sleep, maxAttempts: 2 });
    expect(res.status).toBe(429);
    expect(sleep).toHaveBeenCalledTimes(1);

    const tooLong = () => new Response("", { status: 429, headers: { "retry-after": "120" } });
    const noWait = await request("https://api.example/x", {}, { fetch: vi.fn(async () => tooLong()), sleep: vi.fn() });
    expect(noWait.status).toBe(429);
  });

  it("maps timeouts and network failures to ConnectorErrors", async () => {
    const hang = (_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    await expect(request("https://api.example/x", {}, { fetch: hang, timeoutMs: 10 })).rejects.toMatchObject({ code: "timeout" });
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(request("https://api.example/x", {}, { fetch: offline })).rejects.toBeInstanceOf(ConnectorError);
  });
});

describe("live API clients against a stubbed fetch", () => {
  it("sends the Slack bot token and maps Slack error codes", async () => {
    const fetch = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("conversations.history")) return Response.json({ ok: false, error: "not_in_channel" });
      return Response.json({ ok: true, channels: [{ id: "C1", name: "general", is_private: false, num_members: 3, topic: { value: "t" } }] });
    });
    const slack = new SlackWebApi(async () => "xoxb-token", { fetch });
    expect(await slack.listChannels(10)).toEqual([{ id: "C1", name: "general", topic: "t", memberCount: 3, isPrivate: false }]);
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer xoxb-token");
    await expect(slack.channelHistory("C1", { limit: 10 })).rejects.toMatchObject({ code: "permission", hint: expect.stringContaining("/invite") });
  });

  it("calls Notion with its version header and maps sharing errors", async () => {
    const fetch = vi.fn(async () => Response.json({ object: "error", code: "object_not_found", message: "Could not find page" }, { status: 404 }));
    const notion = new NotionRestApi(async () => "secret_token", { fetch });
    await expect(notion.readPage(POSTMORTEM)).rejects.toMatchObject({ code: "not_found", hint: expect.stringContaining("Connections") });
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["Notion-Version"]).toBe("2022-06-28");
  });

  it("creates long Notion pages in 100-block chunks", async () => {
    const calls: { method: string; url: string; blocks: number }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ method: init!.method!, url: String(url), blocks: (body.children ?? []).length });
      return Response.json({ id: "page-1", url: "https://notion.so/page-1", last_edited_time: "2026-01-01T00:00:00.000Z", properties: {} });
    });
    const notion = new NotionRestApi(async () => "secret_token", { fetch });
    const markdown = Array.from({ length: 250 }, (_, i) => `- item ${i}`).join("\n");
    await notion.createPage(POSTMORTEM, "Long", markdown);
    expect(calls.map((c) => [c.method, c.blocks])).toEqual([
      ["POST", 100],
      ["PATCH", 100],
      ["PATCH", 50],
    ]);
  });
});
