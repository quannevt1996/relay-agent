import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Relay has no user accounts: the browser's workspace is carried in an
 * HMAC-signed cookie. The signing key is derived from the encryption key so
 * there is one secret to manage.
 */
export class SessionSigner {
  private readonly key: Buffer;

  constructor(masterKey: Buffer) {
    this.key = Buffer.from(hkdfSync("sha256", masterKey, Buffer.alloc(0), "relay-session-v1", 32));
  }

  sign(workspaceId: string): string {
    return `${workspaceId}.${this.mac(workspaceId)}`;
  }

  /** Returns the workspace id, or undefined when the value was not signed by us. */
  verify(value: string | undefined): string | undefined {
    if (!value) return undefined;
    const dot = value.lastIndexOf(".");
    if (dot <= 0) return undefined;
    const id = value.slice(0, dot);
    const given = Buffer.from(value.slice(dot + 1));
    const expected = Buffer.from(this.mac(id));
    return given.length === expected.length && timingSafeEqual(given, expected) ? id : undefined;
  }

  private mac(id: string): string {
    return createHmac("sha256", this.key).update(id).digest("base64url");
  }
}
