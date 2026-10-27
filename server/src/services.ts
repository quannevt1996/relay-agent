import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ScriptedDemoModel } from "./agent/demo-model.js";
import { RunEventBus } from "./agent/events.js";
import { AnthropicModel, type ModelClient } from "./agent/model.js";
import { AgentRunner } from "./agent/runner.js";
import type { Config } from "./config.js";
import { ConnectorApis, ToolExecutor, ToolRegistry } from "./connectors/registry.js";
import { openDb, type Db } from "./db.js";
import { SLACK_BOT_SCOPES, type OAuthProvider } from "./oauth/providers.js";
import { OAuthService } from "./oauth/service.js";
import { SessionSigner } from "./security/session.js";
import { Vault } from "./security/vault.js";
import { loadSkills, type Skill } from "./skills/loader.js";
import { ConnectionStore, type ProviderId } from "./store/connections.js";
import { RunStore } from "./store/runs.js";
import { WorkspaceStore, type Workspace } from "./store/workspaces.js";

export interface Services {
  config: Config;
  db: Db;
  workspaces: WorkspaceStore;
  connections: ConnectionStore;
  runs: RunStore;
  oauth: OAuthService;
  registry: ToolRegistry;
  apis: ConnectorApis;
  executor: ToolExecutor;
  skills: Skill[];
  bus: RunEventBus;
  runner: AgentRunner;
  sessions: SessionSigner;
}

export interface ServiceOverrides {
  db?: Db;
  model?: ModelClient;
  oauthProviders?: Record<ProviderId, OAuthProvider>;
}

/** Real Claude when credentials are present, otherwise the scripted stand-in. */
export function createModel(config: Config): ModelClient {
  if (!config.modelConfigured) return new ScriptedDemoModel();
  // The SDK reads ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN itself and retries 429/5xx with backoff.
  return new AnthropicModel(new Anthropic({ maxRetries: 3 }), config.model, config.effort);
}

/** The composition root: every dependency is built here and passed in explicitly. */
export function createServices(config: Config, overrides: ServiceOverrides = {}): Services {
  const db = overrides.db ?? openDb(path.join(config.dataDir, "relay.db"));
  const vault = new Vault(config.encryptionKey);
  const workspaces = new WorkspaceStore(db);
  const connections = new ConnectionStore(db, vault);
  const runs = new RunStore(db);
  const oauth = new OAuthService({ db, connections, config, providers: overrides.oauthProviders });
  const registry = new ToolRegistry();
  const apis = new ConnectorApis(config.connectorMode, oauth, (workspaceId, provider) => connections.has(workspaceId, provider));
  const executor = new ToolExecutor(registry, apis);
  const bus = new RunEventBus();
  const runner = new AgentRunner({
    runs,
    bus,
    registry,
    executor,
    model: overrides.model ?? createModel(config),
    maxTurns: config.maxTurns,
  });

  return {
    config,
    db,
    workspaces,
    connections,
    runs,
    oauth,
    registry,
    apis,
    executor,
    skills: loadSkills(config.skillsDir, registry),
    bus,
    runner,
    sessions: new SessionSigner(config.encryptionKey),
  };
}

/**
 * Demo mode stands in for the OAuth round-trip: the "token" is a placeholder,
 * but it is stored through the same encrypted path as a real one, and the
 * connector checks for it, so connect/disconnect behave like live mode.
 */
export function connectDemo(services: Services, workspaceId: string, provider: ProviderId): void {
  services.connections.save(workspaceId, provider, {
    accessToken: `demo-${provider}-token`,
    scopes: provider === "slack" ? SLACK_BOT_SCOPES : [],
    accountId: `demo-${provider}`,
    accountName: "Northwind Labs (demo)",
  });
}

/** New browsers get their own workspace; in demo mode it starts with both connectors connected. */
export function provisionWorkspace(services: Services): Workspace {
  const workspace = services.workspaces.create();
  if (services.config.connectorMode === "demo") {
    for (const provider of ["slack", "notion"] as const) connectDemo(services, workspace.id, provider);
  }
  return workspace;
}
