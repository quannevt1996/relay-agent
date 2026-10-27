import { z } from "zod";

type JsonSchema = Record<string, unknown>;

// Strict tool schemas reject these keywords. They stay enforced client-side,
// because every tool input is re-validated with its zod schema before running.
const UNSUPPORTED_KEYWORDS = [
  "$schema",
  "default",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
];

function sanitize(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sanitize);
  if (node === null || typeof node !== "object") return node;

  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    if (UNSUPPORTED_KEYWORDS.includes(key)) continue;
    out[key] = key === "properties" ? mapValues(value as JsonSchema, sanitize) : sanitize(value);
  }
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

function mapValues(obj: JsonSchema, fn: (v: unknown) => unknown): JsonSchema {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, fn(v)]));
}

/** Converts a zod object schema into a JSON Schema accepted by `strict: true` tools. */
export function toToolInputSchema(schema: z.ZodType): { type: "object"; [key: string]: unknown } {
  const json = sanitize(z.toJSONSchema(schema, { io: "input" })) as JsonSchema;
  if (json.type !== "object") throw new Error("Tool input schemas must be objects");
  return json as { type: "object" };
}
