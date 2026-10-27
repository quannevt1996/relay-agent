import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ConnectorMode = "demo" | "live";

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface Config {
  port: number;
  /** Public origin of the API server; OAuth redirect URIs are built from it. */
  publicUrl: string;
  /**
   * Origin of the web UI when it is not served by this server. Empty (the
   * default) means the same origin, so post-OAuth redirects are relative and
   * also work through the Vite dev proxy.
   */
  webUrl: string;
  dataDir: string;
  skillsDir: string;
  webDistDir: string;
  model: string;
  effort: Effort;
  maxTurns: number;
  /** True when the Anthropic SDK can find credentials in the environment. */
  modelConfigured: boolean;
  connectorMode: ConnectorMode;
  oauthClients: { slack?: OAuthClientCredentials; notion?: OAuthClientCredentials };
  encryptionKey: Buffer;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ and dist/ both sit one level below server/, so this resolves to the repo root either way.
export const repoRoot = path.resolve(here, "../..");

export function loadEnvFile(file = path.join(repoRoot, ".env")): void {
  if (existsSync(file)) process.loadEnvFile(file);
}

function oauthClient(prefix: string, env: NodeJS.ProcessEnv): OAuthClientCredentials | undefined {
  const clientId = env[`${prefix}_CLIENT_ID`];
  const clientSecret = env[`${prefix}_CLIENT_SECRET`];
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max"];

const isConnectorMode = (value: string): value is ConnectorMode => value === "demo" || value === "live";

function resolveEncryptionKey(env: NodeJS.ProcessEnv, dataDir: string): Buffer {
  const fromEnv = env.RELAY_ENCRYPTION_KEY;
  if (fromEnv) {
    const key = Buffer.from(fromEnv, "base64");
    if (key.length !== 32) throw new Error("RELAY_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
    return key;
  }
  if (env.NODE_ENV === "production") {
    throw new Error("RELAY_ENCRYPTION_KEY is required in production");
  }
  // Local-first convenience: generate a key once and keep it next to the database.
  const keyFile = path.join(dataDir, "encryption.key");
  if (existsSync(keyFile)) return Buffer.from(readFileSync(keyFile, "utf8").trim(), "base64");
  const key = randomBytes(32);
  writeFileSync(keyFile, key.toString("base64"), { mode: 0o600 });
  console.warn(`[relay] RELAY_ENCRYPTION_KEY not set; generated a local key at ${keyFile}`);
  return key;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8787);
  const publicUrl = (env.RELAY_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, "");
  const dataDir = path.resolve(env.RELAY_DATA_DIR ?? path.join(repoRoot, "data"));
  mkdirSync(dataDir, { recursive: true });

  const effort = (env.RELAY_EFFORT ?? "medium") as Effort;
  if (!EFFORTS.includes(effort)) throw new Error(`RELAY_EFFORT must be one of ${EFFORTS.join(", ")}`);

  const maxTurns = Number(env.RELAY_MAX_TURNS ?? 12);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error("RELAY_MAX_TURNS must be a positive integer");

  const oauthClients = { slack: oauthClient("SLACK", env), notion: oauthClient("NOTION", env) };
  const requestedMode = env.CONNECTOR_MODE;
  if (requestedMode !== undefined && !isConnectorMode(requestedMode)) {
    throw new Error("CONNECTOR_MODE must be 'demo' or 'live'");
  }
  const connectorMode: ConnectorMode =
    requestedMode ?? (oauthClients.slack || oauthClients.notion ? "live" : "demo");

  return {
    port,
    publicUrl,
    webUrl: (env.RELAY_WEB_URL ?? "").replace(/\/$/, ""),
    dataDir,
    skillsDir: path.resolve(env.RELAY_SKILLS_DIR ?? path.join(repoRoot, "skills")),
    webDistDir: path.join(repoRoot, "web", "dist"),
    model: env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
    effort,
    maxTurns,
    modelConfigured: Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN),
    connectorMode,
    oauthClients,
    encryptionKey: resolveEncryptionKey(env, dataDir),
  };
}
