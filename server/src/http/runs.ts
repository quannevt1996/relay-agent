import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { isTerminal, type RunEventEnvelope } from "../agent/events.js";
import type { Services } from "../services.js";
import { resolveInputs } from "../skills/loader.js";
import type { RunRecord, RunSummary } from "../store/runs.js";
import type { AppEnv } from "./session.js";

const HEARTBEAT_MS = 15_000;

const CreateRunBody = z.strictObject({
  prompt: z.string().max(8_000).optional(),
  skillId: z.string().optional(),
  inputs: z.record(z.string(), z.unknown()).optional(),
  autoApprove: z.boolean().optional(),
});
const ApproveBody = z.strictObject({ toolUseId: z.string().min(1) });
const RejectBody = z.strictObject({ toolUseId: z.string().min(1), reason: z.string().max(1_000).optional() });

async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) throw new HTTPException(400, { message: z.prettifyError(parsed.error) });
  return parsed.data;
}

export interface PendingApprovalView {
  toolUseId: string;
  tool: string;
  input: unknown;
}

export interface RunView extends RunSummary {
  pendingApprovals: PendingApprovalView[];
}

/** Drops the raw model state (history, system prompt) before a run leaves the server. */
export function toRunView({ workspaceId: _ws, state, ...summary }: RunRecord): RunView {
  const pending = state.pending;
  const pendingApprovals = pending
    ? pending.toolUses
        .filter((use) => pending.awaiting.includes(use.id) && !pending.decisions[use.id])
        .map((use) => ({ toolUseId: use.id, tool: use.name, input: use.input }))
    : [];
  return { ...summary, pendingApprovals };
}

export function runRoutes(services: Services): Hono<AppEnv> {
  const { runs, runner, skills, registry, bus } = services;
  const app = new Hono<AppEnv>();

  const findRun = (c: Context<AppEnv>): RunRecord => {
    const run = runs.get(c.get("workspaceId"), c.req.param("id")!);
    if (!run) throw new HTTPException(404, { message: "Run not found" });
    return run;
  };

  app.get("/skills", (c) => c.json({ skills: skills.map(({ instructions: _body, ...meta }) => meta) }));

  app.get("/tools", (c) =>
    c.json({
      tools: registry.list().map((t) => ({ name: t.name, description: t.description, sideEffect: t.sideEffect, connector: t.connector })),
    }),
  );

  app.get("/runs", (c) => c.json({ runs: runs.list(c.get("workspaceId")) }));

  app.post("/runs", async (c) => {
    const body = await readJson(c, CreateRunBody);
    const skill = body.skillId ? skills.find((s) => s.id === body.skillId) : undefined;
    if (body.skillId && !skill) throw new HTTPException(404, { message: `Unknown skill "${body.skillId}"` });
    const run = runner.start(c.get("workspaceId"), {
      prompt: body.prompt,
      skill,
      inputs: skill ? resolveInputs(skill, body.inputs) : undefined,
      autoApprove: body.autoApprove,
    });
    return c.json({ run: toRunView(run) }, 201);
  });

  app.get("/runs/:id", (c) => {
    const run = findRun(c);
    return c.json({ run: toRunView(run), events: runs.events(run.workspaceId, run.id) });
  });

  app.post("/runs/:id/approve", async (c) => {
    const { toolUseId } = await readJson(c, ApproveBody);
    const run = runner.decide(c.get("workspaceId"), c.req.param("id"), toolUseId, true);
    return c.json({ run: toRunView(run) });
  });

  app.post("/runs/:id/reject", async (c) => {
    const { toolUseId, reason } = await readJson(c, RejectBody);
    const run = runner.decide(c.get("workspaceId"), c.req.param("id"), toolUseId, false, reason);
    return c.json({ run: toRunView(run) });
  });

  app.post("/runs/:id/cancel", (c) => c.json({ run: toRunView(runner.cancel(c.get("workspaceId"), c.req.param("id"))) }));

  /**
   * Server-sent events: replays persisted events after `Last-Event-ID` (or
   * ?after=), then streams live ones until the run's `done` event. Subscribing
   * before the replay and de-duplicating by seq means nothing is lost or
   * repeated in between. Text deltas are live-only and carry no id.
   */
  app.get("/runs/:id/events", (c) => {
    const run = findRun(c);
    const after = Number(c.req.header("Last-Event-ID") ?? c.req.query("after") ?? 0) || 0;

    return streamSSE(c, async (stream) => {
      const queue: RunEventEnvelope[] = [];
      let wake: (() => void) | undefined;
      const unsubscribe = bus.subscribe(run.id, (envelope) => {
        queue.push(envelope);
        wake?.();
      });
      let closed = false;
      stream.onAbort(() => {
        closed = true;
        wake?.();
      });

      let lastSeq = after;
      const send = async ({ seq, event }: RunEventEnvelope) => {
        await stream.writeSSE({ data: JSON.stringify(event), ...(seq !== undefined ? { id: String(seq) } : {}) });
        if (seq !== undefined) lastSeq = seq;
        return event.type === "done";
      };

      try {
        for (const stored of runs.events(run.workspaceId, run.id, after)) {
          if (await send(stored)) return;
        }

        while (!closed) {
          const envelope = queue.shift();
          if (envelope) {
            if (envelope.seq !== undefined && envelope.seq <= lastSeq) continue; // already replayed
            if (await send(envelope)) return;
            continue;
          }
          // Queue drained. A finished run normally ends with its `done` event
          // above; this catches one whose events we have not seen yet.
          if (isTerminal(runs.get(run.workspaceId, run.id)!.status)) {
            for (const stored of runs.events(run.workspaceId, run.id, lastSeq)) await send(stored);
            return;
          }
          const woken = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(false), HEARTBEAT_MS);
            wake = () => {
              clearTimeout(timer);
              resolve(true);
            };
          });
          wake = undefined;
          if (!woken && !closed) await stream.write(": keep-alive\n\n");
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
}
