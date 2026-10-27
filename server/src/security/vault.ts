import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;

/**
 * AES-256-GCM envelope for credentials at rest.
 *
 * Format: `v1.<iv>.<tag>.<ciphertext>` (base64url parts). The caller passes
 * associated data (workspace + provider) that is authenticated but not stored,
 * so a ciphertext copied into another tenant's row fails to decrypt.
 */
export class Vault {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("Vault key must be 32 bytes");
  }

  encrypt(plaintext: string, associatedData: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(associatedData, "utf8"));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv, tag, ciphertext].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
  }

  decrypt(envelope: string, associatedData: string): string {
    const [version, iv, tag, ciphertext] = envelope.split(".");
    if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
      throw new Error("Unrecognized credential envelope");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(associatedData, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
  }
}
