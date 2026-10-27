import { randomBytes } from "node:crypto";

/** Short, URL-safe, prefixed ids (`run_x8Kq...`) that are easy to spot in logs. */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
