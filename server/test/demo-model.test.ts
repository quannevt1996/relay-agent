import path from "node:path";
import { describe, expect, it } from "vitest";
import { ScriptedDemoModel } from "../src/agent/demo-model.js";
import { repoRoot } from "../src/config.js";
import { ToolRegistry } from "../src/connectors/registry.js";
import { loadSkills, resolveInputs } from "../src/skills/loader.js";
import { createTestServices } from "./helpers.js";

const skills = loadSkills(path.join(repoRoot, "skills"), new ToolRegistry());
const skill = (id: string) => skills.find((s) => s.id === id)!;
const STANDUP_NOTES = "1f0e8c2a-0000-4000-8000-000000000002";
const POSTMORTEM = "1f0e8c2a-0000-4000-8000-000000000005";

function setup() {
  const t = createTestServices({ model: new ScriptedDemoModel({ thinkMs: 0, wordMs: 0 }) });
  const ws = t.workspaces.create("Demo").id;
  return { ...t, ws, world: t.apis.demoWorld(ws) };
}

function toolCalls(t: ReturnType<typeof setup>, runId: string) {
  return t.runs
    .events(t.ws, runId)
    .flatMap((e) => (e.event.type === "tool_call" ? [{ tool: e.event.tool, input: e.event.input as Record<string, unknown> }] : []));
}

function pendingId(t: ReturnType<typeof setup>, runId: string): string {
  return t.runs.get(t.ws, runId)!.state.pending!.awaiting[0]!;
}

describe("scripted demo model, end to end through the runner", () => {
  it("summarises a channel into a new Notion page after approval", async () => {
    const t = setup();
    const digest = skill("slack-channel-digest");
    const run = t.runner.start(t.ws, { skill: digest, inputs: resolveInputs(digest, {}) });
    await t.runner.settled(run.id);

    expect(t.runs.get(t.ws, run.id)!.status).toBe("awaiting_approval");
    expect(toolCalls(t, run.id).map((c) => c.tool)).toEqual(["slack_read_channel_history", "notion_search", "notion_create_page"]);
    const create = toolCalls(t, run.id)[2]!;
    expect(create.input.parent_page).toBe(STANDUP_NOTES);
    expect(create.input.content).toContain("Open blockers");

    t.runner.decide(t.ws, run.id, pendingId(t, run.id), true);
    await t.runner.settled(run.id);

    const done = t.runs.get(t.ws, run.id)!;
    expect(done.status).toBe("completed");
    const created = [...t.world.notion.pages.values()].find((p) => p.parentId === STANDUP_NOTES);
    expect(created?.title).toMatch(/^#eng-standup digest: \d{4}-\d{2}-\d{2}$/);
    expect(created?.markdown).toContain("staging Redis OOMs");
    expect(t.runs.events(t.ws, run.id).at(-1)!.event).toMatchObject({ type: "done", answer: expect.stringContaining("Done.") });
  });

  it("acknowledges a declined write and leaves Notion untouched", async () => {
    const t = setup();
    const digest = skill("slack-channel-digest");
    const pagesBefore = t.world.notion.pages.size;
    const run = t.runner.start(t.ws, { skill: digest, inputs: resolveInputs(digest, {}) });
    await t.runner.settled(run.id);
    t.runner.decide(t.ws, run.id, pendingId(t, run.id), false);
    await t.runner.settled(run.id);

    expect(t.world.notion.pages.size).toBe(pagesBefore);
    expect(t.runs.events(t.ws, run.id).at(-1)!.event).toMatchObject({
      type: "done",
      status: "completed",
      answer: expect.stringContaining("did not create the page"),
    });
  });

  it("posts a postmortem's open action items to Slack", async () => {
    const t = setup();
    const s = skill("notion-action-items-to-slack");
    const run = t.runner.start(t.ws, { skill: s, inputs: resolveInputs(s, {}) });
    await t.runner.settled(run.id);
    t.runner.decide(t.ws, run.id, pendingId(t, run.id), true);
    await t.runner.settled(run.id);

    expect(t.runs.get(t.ws, run.id)!.status).toBe("completed");
    const posted = t.world.slack.messages.get("C03INCIDNT")!.at(-1)!;
    expect(posted.userId).toBe("U0RELAYBOT");
    expect(posted.text).toContain("• Pool saturation alert (Sam)");
    expect(posted.text.split("\n")).toHaveLength(4);
  });

  it("appends an incident timeline to the postmortem", async () => {
    const t = setup();
    const s = skill("incident-timeline-to-postmortem");
    const run = t.runner.start(t.ws, { skill: s, inputs: resolveInputs(s, {}) });
    await t.runner.settled(run.id);
    expect(toolCalls(t, run.id).map((c) => c.tool)).toEqual([
      "slack_read_channel_history",
      "notion_search",
      "notion_read_page",
      "notion_append_to_page",
    ]);
    t.runner.decide(t.ws, run.id, pendingId(t, run.id), true);
    await t.runner.settled(run.id);
    expect(t.world.notion.pages.get(POSTMORTEM)!.markdown).toContain("## Timeline from #incidents (last 72h)");
  });

  it("answers read-only questions without asking for approval", async () => {
    const t = setup();
    const run = t.runner.start(t.ws, { prompt: "What happened in #incidents today?" });
    await t.runner.settled(run.id);
    expect(t.runs.get(t.ws, run.id)!.status).toBe("completed");
    expect(toolCalls(t, run.id).map((c) => c.tool)).toEqual(["slack_read_channel_history"]);
  });

  it("explains a connector error it got back from a tool", async () => {
    const t = setup();
    const digest = skill("slack-channel-digest");
    const run = t.runner.start(t.ws, { skill: digest, inputs: resolveInputs(digest, { channel: "#does-not-exist" }) });
    await t.runner.settled(run.id);
    expect(t.runs.events(t.ws, run.id).at(-1)!.event).toMatchObject({
      type: "done",
      status: "completed",
      answer: expect.stringMatching(/No channel named #does-not-exist.*Known channels/),
    });
  });

  it("says plainly that it is a script when it does not recognise a request", async () => {
    const t = setup();
    const run = t.runner.start(t.ws, { prompt: "Write me a poem" });
    await t.runner.settled(run.id);
    const done = t.runs.events(t.ws, run.id).at(-1)!.event;
    expect(done).toMatchObject({ type: "done", status: "completed" });
    expect(done.type === "done" && done.answer).toContain("ANTHROPIC_API_KEY");
  });
});
