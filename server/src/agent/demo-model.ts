import { randomBytes } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import type { ModelClient, ModelTurnOptions, ModelTurnRequest } from "./model.js";

export const DEMO_MODEL_ID = "scripted-demo";

/**
 * Stand-in for Claude when no ANTHROPIC_API_KEY is set. It is not a language
 * model: it recognises the bundled skills (and a few phrasings of free-form
 * requests) and plays a fixed plan, one tool call per turn, reading the real
 * tool results that come back. That is enough to drive the real agent loop,
 * connectors, approvals and trace UI end to end without any credentials.
 *
 * It returns the same Message shape as the API. Token counts are a rough
 * characters/4 estimate so the trace has numbers to show; there is no cost.
 */
export class ScriptedDemoModel implements ModelClient {
  readonly model = DEMO_MODEL_ID;

  constructor(private readonly timing: { thinkMs: number; wordMs: number } = { thinkMs: 450, wordMs: 18 }) {}

  async createTurn(request: ModelTurnRequest, { onText, signal }: ModelTurnOptions = {}): Promise<Anthropic.Beta.BetaMessage> {
    const step = nextStep(parseConversation(request.messages));
    const text = step.kind === "answer" ? step.text : step.say;

    await sleep(this.timing.thinkMs, signal);
    for (const word of text.match(/\S+\s*/g) ?? []) {
      onText?.(word);
      await sleep(this.timing.wordMs, signal);
    }

    const content: Anthropic.Beta.BetaContentBlock[] = [{ type: "text", text, citations: null }];
    if (step.kind === "tool") content.push({ type: "tool_use", id: `toolu_demo_${randomId()}`, name: step.name, input: step.input });

    return {
      id: `msg_demo_${randomId()}`,
      type: "message",
      role: "assistant",
      model: this.model,
      content,
      stop_reason: step.kind === "tool" ? "tool_use" : "end_turn",
      stop_sequence: null,
      stop_details: null,
      container: null,
      context_management: null,
      diagnostics: null,
      usage: {
        input_tokens: estimateTokens([request.system, request.tools, request.messages]),
        output_tokens: estimateTokens(content),
        cache_creation: null,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
        fallback_credit: null,
        inference_geo: null,
        iterations: null,
        output_tokens_details: null,
        server_tool_use: null,
        service_tier: null,
        speed: null,
      },
    };
  }
}

// --- reading the conversation -------------------------------------------------------------------

type Json = Record<string, any>;

interface ToolCall {
  name: string;
  input: Json;
  ok: boolean;
  declined: boolean;
  /** Parsed JSON output, or `{ error, hint }` for failed calls. */
  result: Json;
}

interface Conversation {
  prompt: string;
  skillId: string | null;
  inputs: Json;
  calls: ToolCall[];
}

type Step = { kind: "tool"; say: string; name: string; input: Json } | { kind: "answer"; text: string };

export function parseConversation(messages: Anthropic.Beta.BetaMessageParam[]): Conversation {
  const first = messages[0]?.content;
  const prompt = typeof first === "string" ? first : "";
  const skill = prompt.match(/\(id: ([a-z0-9-]+)\) with these inputs:\n([\s\S]*?)(?:\n\nAdditional instructions:|$)/);

  const calls: ToolCall[] = [];
  const byId = new Map<string, ToolCall>();
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "tool_use") {
        const call: ToolCall = { name: block.name, input: block.input as Json, ok: false, declined: false, result: {} };
        calls.push(call);
        byId.set(block.id, call);
      } else if (block.type === "tool_result") {
        const call = byId.get(block.tool_use_id);
        if (!call) continue;
        const text = typeof block.content === "string" ? block.content : "";
        call.ok = !block.is_error;
        call.declined = Boolean(block.is_error) && text.startsWith("The user declined");
        call.result = parseJson(text);
      }
    }
  }

  return {
    prompt: skill ? "" : prompt.replace(/^Current time: .*\n\n/, ""),
    skillId: skill?.[1] ?? null,
    inputs: skill ? parseJson(skill[2]!) : {},
    calls,
  };
}

// --- plans ----------------------------------------------------------------------------------------

function nextStep(c: Conversation): Step {
  switch (c.skillId) {
    case "slack-channel-digest":
      return channelDigest(c.inputs, c.calls);
    case "notion-action-items-to-slack":
      return actionItemsToSlack(c.inputs, c.calls);
    case "incident-timeline-to-postmortem":
      return incidentTimeline(c.inputs, c.calls);
  }
  return freeForm(c.prompt, c.calls);
}

/** Maps a few phrasings onto the same plans; anything else gets an honest "I'm a script" answer. */
function freeForm(prompt: string, calls: ToolCall[]): Step {
  const channel = prompt.match(/#[a-z0-9_-]+/i)?.[0];
  const quoted = prompt.match(/["“]([^"”]+)["”]/)?.[1];

  if (/action items?/i.test(prompt)) {
    return actionItemsToSlack({ page: quoted ?? "Postmortem", channel: channel ?? "#incidents" }, calls);
  }
  if (/incident|postmortem/i.test(prompt) && /notion|postmortem/i.test(prompt)) {
    return incidentTimeline({ channel: channel ?? "#incidents", hours: 72, postmortem: quoted ?? "Postmortem" }, calls);
  }
  if (/summar|digest|recap/i.test(prompt) && /notion/i.test(prompt)) {
    return channelDigest({ channel: channel ?? "#eng-standup", hours: 24, parent_page: quoted ?? "Standup Notes" }, calls);
  }
  if (channel) return channelCatchUp(channel, calls);
  return overview(calls);
}

function channelDigest(inputs: Json, calls: ToolCall[]): Step {
  const channel = String(inputs.channel ?? "#eng-standup");
  const hours = Number(inputs.hours ?? 24);
  const parentTitle = String(inputs.parent_page ?? "Standup Notes");
  const [history, search, create] = calls;

  if (!history) {
    return tool(`I'll read the last ${hours} hours of ${channel} first.`, "slack_read_channel_history", { channel, hours_back: hours });
  }
  if (!history.ok) return answer(failure(`I couldn't read ${channel}`, history));
  const messages: Json[] = history.result.messages ?? [];
  if (messages.length === 0) return answer(`There were no messages in ${channel} in the last ${hours} hours, so there is nothing to file.`);

  if (!search) {
    return tool(`Read ${messages.length} messages. Now I'll find the "${parentTitle}" page in Notion.`, "notion_search", { query: parentTitle });
  }
  if (!search.ok) return answer(failure("I couldn't search Notion", search));
  const parent = bestMatch(search.result, parentTitle);
  if (!parent) return answer(`I couldn't find a Notion page called "${parentTitle}". Share it with the integration or pick another parent page.`);

  const channelName = `#${history.result.channel?.name ?? channel.replace(/^#/, "")}`;
  const title = `${channelName} digest: ${new Date().toISOString().slice(0, 10)}`;
  if (!create) {
    return tool(`Drafting the digest as a new page under "${parent.title}". It needs your approval before it is created.`, "notion_create_page", {
      parent_page: parent.id,
      title,
      content: digestMarkdown(channelName, hours, messages),
    });
  }
  if (create.declined) {
    return answer(`Understood, I did not create the page. The draft covered ${messages.length} messages from ${channelName}; tell me what to change and I can try again.`);
  }
  if (!create.ok) return answer(failure("Creating the Notion page failed", create));
  const people = new Set(messages.map((m) => m.userName)).size;
  return answer(
    `Done. I filed "${title}" under "${parent.title}" (page id ${create.result.id}). It summarises ${messages.length} messages from ${people} people and lists open blockers.`,
  );
}

function actionItemsToSlack(inputs: Json, calls: ToolCall[]): Step {
  const query = String(inputs.page ?? "Postmortem");
  const channel = String(inputs.channel ?? "#incidents");
  const [search, read, post] = calls;

  if (!search) return tool(`I'll look up "${query}" in Notion.`, "notion_search", { query });
  if (!search.ok) return answer(failure("I couldn't search Notion", search));
  const page = bestMatch(search.result, query);
  if (!page) return answer(`No Notion page matched "${query}".`);

  if (!read) return tool(`Found "${page.title}". Reading it to pull out the action items.`, "notion_read_page", { page: page.id });
  if (!read.ok) return answer(failure(`I couldn't read "${page.title}"`, read));
  const items = String(read.result.markdown ?? "")
    .split("\n")
    .map((line) => line.match(/^\s*[-*]\s+\[ \]\s+(.*)$/)?.[1])
    .filter((item): item is string => Boolean(item));
  if (items.length === 0) return answer(`"${page.title}" has no open action items (unchecked to-dos), so I didn't post anything.`);

  if (!post) {
    const text = [`*Open action items from ${page.title}*`, ...items.map((item) => `• ${item}`)].join("\n");
    return tool(`It has ${items.length} open action items. Here is the message I'd post to ${channel}; it needs your approval.`, "slack_post_message", {
      channel,
      text,
    });
  }
  if (post.declined) return answer(`Okay, nothing was posted to ${channel}. Let me know if you want different wording or another channel.`);
  if (!post.ok) return answer(failure(`Posting to ${channel} failed`, post));
  return answer(`Posted ${items.length} action items from "${page.title}" to ${channel} (message ts ${post.result.ts}).`);
}

function incidentTimeline(inputs: Json, calls: ToolCall[]): Step {
  const channel = String(inputs.channel ?? "#incidents");
  const hours = Number(inputs.hours ?? 72);
  const query = String(inputs.postmortem ?? "Postmortem");
  const [history, search, read, append] = calls;

  if (!history) return tool(`Reading the last ${hours} hours of ${channel}.`, "slack_read_channel_history", { channel, hours_back: hours });
  if (!history.ok) return answer(failure(`I couldn't read ${channel}`, history));
  const messages: Json[] = history.result.messages ?? [];
  if (messages.length === 0) return answer(`No messages in ${channel} in the last ${hours} hours.`);

  if (!search) return tool(`Got ${messages.length} updates. Finding the postmortem doc.`, "notion_search", { query });
  if (!search.ok) return answer(failure("I couldn't search Notion", search));
  const page = bestMatch(search.result, query);
  if (!page) return answer(`I couldn't find a postmortem page matching "${query}".`);

  if (!read) return tool(`Found "${page.title}". Checking what it already contains.`, "notion_read_page", { page: page.id });
  if (!read.ok) return answer(failure(`I couldn't read "${page.title}"`, read));
  if (String(read.result.markdown ?? "").includes(`## Timeline from ${channel}`)) {
    return answer(`"${page.title}" already has a timeline from ${channel}, so I left it unchanged.`);
  }

  if (!append) {
    const lines = messages.map((m) => `- ${formatTime(m.postedAt)}, ${m.userName}: ${firstLine(m.text)}`);
    return tool(`Appending a timeline to "${page.title}". This edits the page, so it needs your approval.`, "notion_append_to_page", {
      page: page.id,
      content: [`## Timeline from ${channel} (last ${hours}h)`, ...lines].join("\n"),
    });
  }
  if (append.declined) return answer(`Okay, I left "${page.title}" unchanged.`);
  if (!append.ok) return answer(failure(`Updating "${page.title}" failed`, append));
  return answer(`Appended a ${messages.length}-entry timeline from ${channel} to "${page.title}".`);
}

function channelCatchUp(channel: string, calls: ToolCall[]): Step {
  const [history] = calls;
  if (!history) return tool(`Reading the last 24 hours of ${channel}.`, "slack_read_channel_history", { channel, hours_back: 24 });
  if (!history.ok) return answer(failure(`I couldn't read ${channel}`, history));
  const messages: Json[] = history.result.messages ?? [];
  if (messages.length === 0) return answer(`${channel} has been quiet for the last 24 hours.`);
  const latest = messages.slice(-8).map((m) => `- ${m.userName}: ${firstLine(m.text)}`);
  return answer([`${messages.length} messages in ${channel} over the last 24 hours. The most recent:`, ...latest].join("\n"));
}

function overview(calls: ToolCall[]): Step {
  const [channels, pages] = calls;
  if (!channels) return tool("Let me see what I can reach. First, the Slack channels.", "slack_list_channels", {});
  if (!pages) return tool("And the most recently edited Notion pages.", "notion_search", { query: "", limit: 5 });
  const channelList = channels.ok ? (channels.result as unknown as Json[]).map((ch) => `#${ch.name}`).join(", ") : "unavailable";
  const pageList = pages.ok ? (pages.result as unknown as Json[]).map((p) => `"${p.title}"`).join(", ") : "unavailable";
  return answer(
    [
      `I can see these Slack channels: ${channelList}. Recent Notion pages: ${pageList}.`,
      "",
      "This server is running the scripted demo model, which only follows the bundled skills and a few phrasings, for example:",
      '- "Summarise #eng-standup into Notion"',
      '- "Post the action items from the postmortem to #incidents"',
      '- "What happened in #incidents?"',
      "Set ANTHROPIC_API_KEY to let Claude plan free-form requests.",
    ].join("\n"),
  );
}

// --- helpers --------------------------------------------------------------------------------------

const tool = (say: string, name: string, input: Json): Step => ({ kind: "tool", say, name, input });
const answer = (text: string): Step => ({ kind: "answer", text });

function failure(what: string, call: ToolCall): string {
  const { error, hint } = call.result;
  return `${what}: ${error ?? "unknown error"}.${hint ? ` ${hint}` : ""}`;
}

function bestMatch(results: Json, query: string): { id: string; title: string } | undefined {
  const pages = (Array.isArray(results) ? results : []) as { id: string; title: string }[];
  const q = query.toLowerCase();
  return pages.find((p) => p.title.toLowerCase() === q) ?? pages.find((p) => p.title.toLowerCase().includes(q)) ?? pages[0];
}

function digestMarkdown(channel: string, hours: number, messages: Json[]): string {
  const byPerson = new Map<string, string[]>();
  const blockers: string[] = [];
  for (const m of messages) {
    const lines = String(m.text)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    byPerson.set(m.userName, [...(byPerson.get(m.userName) ?? []), ...lines.slice(0, 4)]);
    for (const line of lines) {
      const blocker = line.match(/^B:\s*(.+)$/)?.[1];
      if (blocker && !/^none\.?$/i.test(blocker)) blockers.push(`${m.userName}: ${blocker}`);
    }
  }

  const out = ["## Summary", `${messages.length} messages from ${byPerson.size} people in ${channel} over the last ${hours} hours.`, "## Updates"];
  for (const [person, lines] of byPerson) out.push(`### ${person}`, ...lines.map((l) => `- ${l}`));
  out.push("## Open blockers", ...(blockers.length ? blockers.map((b) => `- ${b}`) : ["- None reported"]));
  return out.join("\n");
}

const firstLine = (text: string, max = 160) => {
  const line = String(text).split("\n")[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const formatTime = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

function parseJson(text: string): Json {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" ? value : { value };
  } catch {
    return { error: text };
  }
}

const estimateTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);
const randomId = () => randomBytes(9).toString("base64url");

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return signal?.aborted ? Promise.reject(signal.reason) : Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
