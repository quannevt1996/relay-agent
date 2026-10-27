// Response shapes of the Relay API. These mirror server/src (agent/events.ts,
// http/runs.ts, http/connections.ts); the two packages are built separately,
// so the types are duplicated here rather than imported across workspaces.

export type RunStatus = "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";
export type SideEffect = "read" | "write";

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export type RunEvent =
  | { type: "run_started"; prompt: string | null; skillId: string | null; model: string; autoApprove: boolean }
  | { type: "status"; status: RunStatus }
  | { type: "turn_started"; turn: number }
  | { type: "text_delta"; turn: number; delta: string }
  | { type: "text"; turn: number; text: string }
  | { type: "progress"; turn: number; text: string }
  | {
      type: "model_turn";
      turn: number;
      stopReason: string | null;
      durationMs: number;
      usage: Usage;
      costUsd: number | null;
      totalUsage: Usage;
      totalCostUsd: number | null;
    }
  | {
      type: "tool_call";
      turn: number;
      toolUseId: string;
      tool: string;
      input: unknown;
      sideEffect: SideEffect | null;
      needsApproval: boolean;
    }
  | {
      type: "tool_result";
      toolUseId: string;
      tool: string;
      ok: boolean;
      output?: unknown;
      error?: string;
      hint?: string;
      durationMs: number;
    }
  | { type: "approval_required"; toolUseId: string; tool: string; input: unknown }
  | { type: "approval_resolved"; toolUseId: string; approved: boolean; reason?: string }
  | { type: "error"; message: string }
  | { type: "done"; status: RunStatus; answer: string | null };

export interface RunSummary {
  id: string;
  title: string;
  skillId: string | null;
  status: RunStatus;
  model: string;
  autoApprove: boolean;
  usage: Usage;
  turns: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillInput {
  name: string;
  label: string;
  type: "string" | "number" | "boolean";
  description?: string;
  required: boolean;
  default?: string | number | boolean;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  connectors: ("slack" | "notion")[];
  tools: string[];
  inputs: SkillInput[];
}

export interface Connection {
  provider: "slack" | "notion";
  displayName: string;
  connected: boolean;
  accountName: string | null;
  scopes: string[];
  connectedAt: string | null;
  mode: "demo" | "live";
  canConnect: boolean;
  setupHint: string | null;
}

export interface Session {
  workspace: { id: string; name: string; createdAt: string };
  connectorMode: "demo" | "live";
  model: { id: string; scripted: boolean };
  maxTurns: number;
}

export interface CreateRunRequest {
  prompt?: string;
  skillId?: string;
  inputs?: Record<string, string | number | boolean>;
  autoApprove?: boolean;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    // Always JSON, also for body-less mutations, so they never look like a cross-site form post.
    headers: init.method && init.method !== "GET" ? { "content-type": "application/json" } : undefined,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data;
}

export const api = {
  session: () => call<Session>("/api/session"),
  connections: () => call<{ connections: Connection[] }>("/api/connections").then((r) => r.connections),
  disconnect: (provider: string) => call(`/api/connections/${provider}`, { method: "DELETE" }),
  skills: () => call<{ skills: Skill[] }>("/api/skills").then((r) => r.skills),
  runs: () => call<{ runs: RunSummary[] }>("/api/runs").then((r) => r.runs),
  createRun: (body: CreateRunRequest) => call<{ run: RunSummary }>("/api/runs", { method: "POST", body }).then((r) => r.run),
  approve: (runId: string, toolUseId: string) => call(`/api/runs/${runId}/approve`, { method: "POST", body: { toolUseId } }),
  reject: (runId: string, toolUseId: string, reason?: string) =>
    call(`/api/runs/${runId}/reject`, { method: "POST", body: { toolUseId, ...(reason ? { reason } : {}) } }),
  cancel: (runId: string) => call(`/api/runs/${runId}/cancel`, { method: "POST" }),
  /** A full-page navigation, because the provider's consent screen has to load in the browser. */
  connectUrl: (provider: string) => `/api/oauth/${provider}/start`,
  eventsUrl: (runId: string) => `/api/runs/${runId}/events`,
};
