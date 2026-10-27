import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const dataDir = () => mkdtempSync(path.join(tmpdir(), "relay-config-"));

describe("loadConfig", () => {
  it("defaults to demo connectors and the scripted model when nothing is set", () => {
    const config = loadConfig({ RELAY_DATA_DIR: dataDir() });
    expect(config).toMatchObject({ connectorMode: "demo", modelConfigured: false, model: "claude-opus-5-5", effort: "medium", port: 8787 });
    expect(config.encryptionKey).toHaveLength(32);
  });

  it("treats blank values copied from .env.example as unset", () => {
    const config = loadConfig({
      RELAY_DATA_DIR: dataDir(),
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_MODEL: "",
      CONNECTOR_MODE: "",
      RELAY_EFFORT: "",
      RELAY_ENCRYPTION_KEY: "",
      SLACK_CLIENT_ID: "",
      SLACK_CLIENT_SECRET: "",
    });
    expect(config).toMatchObject({ connectorMode: "demo", modelConfigured: false, model: "claude-opus-5-5", effort: "medium" });
  });

  it("switches to live connectors and the API model when credentials are present", () => {
    const config = loadConfig({
      RELAY_DATA_DIR: dataDir(),
      ANTHROPIC_API_KEY: "sk-test",
      SLACK_CLIENT_ID: "id",
      SLACK_CLIENT_SECRET: "secret",
    });
    expect(config).toMatchObject({ connectorMode: "live", modelConfigured: true, oauthClients: { slack: { clientId: "id" } } });
  });

  it("persists a generated key next to the data, and requires one in production", () => {
    const dir = dataDir();
    const first = loadConfig({ RELAY_DATA_DIR: dir });
    expect(loadConfig({ RELAY_DATA_DIR: dir }).encryptionKey.equals(first.encryptionKey)).toBe(true);
    expect(readFileSync(path.join(dir, "encryption.key"), "utf8").trim()).toBe(first.encryptionKey.toString("base64"));
    expect(() => loadConfig({ RELAY_DATA_DIR: dataDir(), NODE_ENV: "production" })).toThrow(/RELAY_ENCRYPTION_KEY is required/);
    const key = randomBytes(32).toString("base64");
    expect(loadConfig({ RELAY_DATA_DIR: dataDir(), NODE_ENV: "production", RELAY_ENCRYPTION_KEY: key }).encryptionKey.toString("base64")).toBe(key);
  });

  it("rejects invalid settings", () => {
    expect(() => loadConfig({ RELAY_DATA_DIR: dataDir(), CONNECTOR_MODE: "staging" })).toThrow(/CONNECTOR_MODE/);
    expect(() => loadConfig({ RELAY_DATA_DIR: dataDir(), RELAY_EFFORT: "extreme" })).toThrow(/RELAY_EFFORT/);
    expect(() => loadConfig({ RELAY_DATA_DIR: dataDir(), RELAY_MAX_TURNS: "0" })).toThrow(/RELAY_MAX_TURNS/);
    expect(() => loadConfig({ RELAY_DATA_DIR: dataDir(), RELAY_ENCRYPTION_KEY: "c2hvcnQ=" })).toThrow(/32 bytes/);
  });
});
