import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { SessionSigner } from "../src/security/session.js";
import { Vault } from "../src/security/vault.js";
import { ConnectionStore } from "../src/store/connections.js";
import { WorkspaceStore } from "../src/store/workspaces.js";

describe("Vault", () => {
  const vault = new Vault(randomBytes(32));

  it("round-trips a secret", () => {
    const envelope = vault.encrypt("xoxb-secret", "ws_1:slack");
    expect(envelope).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(envelope).not.toContain("xoxb-secret");
    expect(vault.decrypt(envelope, "ws_1:slack")).toBe("xoxb-secret");
  });

  it("uses a fresh IV every time", () => {
    expect(vault.encrypt("same", "ad")).not.toBe(vault.encrypt("same", "ad"));
  });

  it("detects a tampered ciphertext, IV or tag", () => {
    const envelope = vault.encrypt("xoxb-secret", "ad");
    const [version, iv, tag, ciphertext] = envelope.split(".");
    const flip = (part: string) => {
      const bytes = Buffer.from(part, "base64url");
      bytes[0] = bytes[0]! ^ 0xff;
      return bytes.toString("base64url");
    };
    expect(() => vault.decrypt([version, iv, tag, flip(ciphertext!)].join("."), "ad")).toThrow();
    expect(() => vault.decrypt([version, flip(iv!), tag, ciphertext].join("."), "ad")).toThrow();
    expect(() => vault.decrypt([version, iv, flip(tag!), ciphertext].join("."), "ad")).toThrow();
  });

  it("binds a ciphertext to its associated data (tenant + provider)", () => {
    const envelope = vault.encrypt("xoxb-secret", "ws_a:slack");
    expect(() => vault.decrypt(envelope, "ws_b:slack")).toThrow();
    expect(() => vault.decrypt(envelope, "ws_a:notion")).toThrow();
  });

  it("rejects the wrong key, malformed envelopes and bad key sizes", () => {
    const envelope = vault.encrypt("xoxb-secret", "ad");
    expect(() => new Vault(randomBytes(32)).decrypt(envelope, "ad")).toThrow();
    expect(() => vault.decrypt("not-an-envelope", "ad")).toThrow(/Unrecognized credential envelope/);
    expect(() => vault.decrypt(envelope.replace(/^v1/, "v2"), "ad")).toThrow(/Unrecognized/);
    expect(() => new Vault(randomBytes(16))).toThrow(/32 bytes/);
  });
});

describe("ConnectionStore encryption at rest", () => {
  it("never writes tokens in plaintext and refuses rows copied between tenants", () => {
    const db = openDb(":memory:");
    const workspaces = new WorkspaceStore(db);
    const store = new ConnectionStore(db, new Vault(randomBytes(32)));
    const a = workspaces.create("A").id;
    const b = workspaces.create("B").id;
    store.save(a, "slack", { accessToken: "xoxb-a", refreshToken: "xoxe-a", scopes: ["chat:write"] });
    store.save(b, "slack", { accessToken: "xoxb-b", scopes: ["chat:write"] });

    const dump = JSON.stringify(db.prepare("SELECT * FROM connections").all());
    expect(dump).not.toContain("xoxb-a");
    expect(dump).not.toContain("xoxe-a");
    expect(store.getTokens(a, "slack")).toMatchObject({ accessToken: "xoxb-a", refreshToken: "xoxe-a" });

    // An attacker with write access to the table copies A's ciphertext into B's row.
    db.prepare(
      "UPDATE connections SET access_token_enc = (SELECT access_token_enc FROM connections WHERE workspace_id = ?) WHERE workspace_id = ?",
    ).run(a, b);
    expect(() => store.getTokens(b, "slack")).toThrow();
  });
});

describe("SessionSigner", () => {
  const signer = new SessionSigner(randomBytes(32));

  it("verifies its own signatures", () => {
    expect(signer.verify(signer.sign("ws_abc"))).toBe("ws_abc");
  });

  it("rejects forged, truncated and foreign values", () => {
    const signed = signer.sign("ws_abc");
    expect(signer.verify(signed.replace("ws_abc", "ws_xyz"))).toBeUndefined();
    expect(signer.verify(signed.slice(0, -2))).toBeUndefined();
    expect(signer.verify("ws_abc")).toBeUndefined();
    expect(signer.verify(undefined)).toBeUndefined();
    expect(new SessionSigner(randomBytes(32)).verify(signed)).toBeUndefined();
  });
});
