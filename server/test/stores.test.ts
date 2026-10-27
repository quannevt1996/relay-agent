import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { Vault } from "../src/security/vault.js";
import { ConnectionStore } from "../src/store/connections.js";
import { RunStore, type RunState } from "../src/store/runs.js";
import { WorkspaceStore } from "../src/store/workspaces.js";

const state: RunState = { system: "s", toolNames: [], messages: [{ role: "user", content: "hi" }], pending: null };

function setup() {
  const db = openDb(":memory:");
  const workspaces = new WorkspaceStore(db);
  return {
    db,
    workspaces,
    connections: new ConnectionStore(db, new Vault(randomBytes(32))),
    runs: new RunStore(db),
    a: workspaces.create("A").id,
    b: workspaces.create("B").id,
  };
}

describe("workspace isolation in stores", () => {
  it("keeps connections per workspace", () => {
    const t = setup();
    t.connections.save(t.a, "slack", { accessToken: "xoxb-a", scopes: ["chat:write"], accountName: "A Slack" });

    expect(t.connections.list(t.a).map((c) => c.accountName)).toEqual(["A Slack"]);
    expect(t.connections.list(t.b)).toEqual([]);
    expect(t.connections.getTokens(t.b, "slack")).toBeUndefined();
    expect(t.connections.has(t.b, "slack")).toBe(false);
    expect(t.connections.delete(t.b, "slack")).toBe(false);
    expect(t.connections.has(t.a, "slack")).toBe(true);
  });

  it("only returns, lists and updates runs through the owning workspace", () => {
    const t = setup();
    const run = t.runs.create(t.a, { title: "A's run", skillId: null, model: "m", autoApprove: false, state });
    t.runs.appendEvent(run.id, { type: "status", status: "running" });

    expect(t.runs.get(t.b, run.id)).toBeUndefined();
    expect(t.runs.list(t.b)).toEqual([]);
    expect(t.runs.events(t.b, run.id)).toEqual([]);

    t.runs.update(t.b, run.id, { status: "cancelled", error: "hijacked" });
    expect(t.runs.get(t.a, run.id)).toMatchObject({ status: "running", error: null });
    expect(t.runs.list(t.a).map((r) => r.id)).toEqual([run.id]);
    expect(t.runs.events(t.a, run.id)).toHaveLength(1);
  });

  it("removes a workspace's data with the workspace", () => {
    const t = setup();
    t.connections.save(t.a, "notion", { accessToken: "secret", scopes: [] });
    const run = t.runs.create(t.a, { title: "x", skillId: null, model: "m", autoApprove: false, state });
    t.runs.appendEvent(run.id, { type: "status", status: "running" });
    t.db.prepare("DELETE FROM workspaces WHERE id = ?").run(t.a);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM connections").get()).toEqual({ n: 0 });
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM run_events").get()).toEqual({ n: 0 });
  });
});

describe("RunStore", () => {
  it("numbers events per run and replays them after a sequence number", () => {
    const t = setup();
    const run = t.runs.create(t.a, { title: "x", skillId: null, model: "m", autoApprove: false, state });
    for (const status of ["running", "awaiting_approval", "running"] as const) t.runs.appendEvent(run.id, { type: "status", status });
    expect(t.runs.events(t.a, run.id).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(t.runs.events(t.a, run.id, 2).map((e) => e.seq)).toEqual([3]);
  });

  it("fails runs interrupted mid-turn but leaves paused runs resumable", () => {
    const t = setup();
    const running = t.runs.create(t.a, { title: "r", skillId: null, model: "m", autoApprove: false, state });
    const paused = t.runs.create(t.b, { title: "p", skillId: null, model: "m", autoApprove: false, state });
    t.runs.update(t.b, paused.id, { status: "awaiting_approval" });

    expect(t.runs.failInterrupted()).toEqual([running.id]);
    expect(t.runs.get(t.a, running.id)).toMatchObject({ status: "failed", error: "Interrupted by a server restart" });
    expect(t.runs.events(t.a, running.id).at(-1)!.event).toEqual({ type: "done", status: "failed", answer: null });
    expect(t.runs.get(t.b, paused.id)!.status).toBe("awaiting_approval");
  });

  it("round-trips the resumable state as JSON", () => {
    const t = setup();
    const run = t.runs.create(t.a, { title: "x", skillId: "s", model: "m", autoApprove: true, state });
    const pending = { toolUses: [{ id: "tu", name: "slack_post_message", input: { text: "hi" } }], results: [], awaiting: ["tu"], decisions: {} };
    t.runs.update(t.a, run.id, { state: { ...state, pending }, turns: 2 });
    expect(t.runs.get(t.a, run.id)).toMatchObject({ autoApprove: true, turns: 2, state: { pending } });
  });
});

describe("WorkspaceStore", () => {
  it("creates prefixed ids and getOrCreate is idempotent", () => {
    const { workspaces } = setup();
    const ws = workspaces.create();
    expect(ws.id).toMatch(/^ws_[\w-]{16}$/);
    expect(workspaces.getOrCreate("ws_fixed", "Fixed")).toMatchObject({ id: "ws_fixed", name: "Fixed" });
    expect(workspaces.getOrCreate("ws_fixed", "Other").name).toBe("Fixed");
  });
});
