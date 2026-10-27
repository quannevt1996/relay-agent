import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ToolRegistry } from "../connectors/registry.js";

const InputSpec = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, "input names are snake_case"),
  label: z.string(),
  type: z.enum(["string", "number", "boolean"]).default("string"),
  description: z.string().optional(),
  required: z.boolean().default(false),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const Frontmatter = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/, "ids are kebab-case"),
  name: z.string(),
  description: z.string(),
  connectors: z.array(z.enum(["slack", "notion"])).min(1),
  tools: z.array(z.string()).min(1),
  inputs: z.array(InputSpec).default([]),
});

export type SkillInput = z.infer<typeof InputSpec>;
export type InputValue = string | number | boolean;

export interface Skill extends z.infer<typeof Frontmatter> {
  /** Markdown body: appended to the system prompt, so it must stay static to be cacheable. */
  instructions: string;
}

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillError";
  }
}

export function parseSkill(source: string, file: string, registry: ToolRegistry): Skill {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new SkillError(`${file}: missing YAML frontmatter`);

  const parsed = Frontmatter.safeParse(parseYaml(match[1]!));
  if (!parsed.success) throw new SkillError(`${file}: ${z.prettifyError(parsed.error)}`);
  const meta = parsed.data;

  for (const name of meta.tools) {
    const tool = registry.get(name);
    if (!tool) throw new SkillError(`${file}: unknown tool "${name}"`);
    if (!meta.connectors.includes(tool.connector)) {
      throw new SkillError(`${file}: tool "${name}" needs the ${tool.connector} connector, which the skill does not declare`);
    }
  }

  const seen = new Set<string>();
  for (const input of meta.inputs) {
    if (seen.has(input.name)) throw new SkillError(`${file}: duplicate input "${input.name}"`);
    seen.add(input.name);
    if (input.default !== undefined && typeof input.default !== input.type) {
      throw new SkillError(`${file}: default for "${input.name}" must be a ${input.type}`);
    }
  }

  const instructions = match[2]!.trim();
  if (!instructions) throw new SkillError(`${file}: instructions are empty`);
  return { ...meta, instructions };
}

export function loadSkills(dir: string, registry: ToolRegistry): Skill[] {
  const skills = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseSkill(readFileSync(path.join(dir, f), "utf8"), f, registry));
  const ids = new Set<string>();
  for (const skill of skills) {
    if (ids.has(skill.id)) throw new SkillError(`Duplicate skill id "${skill.id}"`);
    ids.add(skill.id);
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function coerce(spec: SkillInput, raw: unknown): InputValue | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  switch (spec.type) {
    case "number": {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n)) throw new SkillError(`"${spec.label}" must be a number`);
      return n;
    }
    case "boolean":
      if (typeof raw === "boolean") return raw;
      if (raw === "true" || raw === "false") return raw === "true";
      throw new SkillError(`"${spec.label}" must be true or false`);
    default:
      return String(raw);
  }
}

/** Applies defaults and type coercion; throws a SkillError naming every problem. */
export function resolveInputs(skill: Skill, raw: Record<string, unknown> = {}): Record<string, InputValue> {
  const unknownKeys = Object.keys(raw).filter((k) => !skill.inputs.some((i) => i.name === k));
  if (unknownKeys.length) throw new SkillError(`Unknown inputs: ${unknownKeys.join(", ")}`);

  const values: Record<string, InputValue> = {};
  const missing: string[] = [];
  for (const spec of skill.inputs) {
    const value = coerce(spec, raw[spec.name]) ?? spec.default;
    if (value === undefined) {
      if (spec.required) missing.push(spec.label);
      continue;
    }
    values[spec.name] = value;
  }
  if (missing.length) throw new SkillError(`Missing required inputs: ${missing.join(", ")}`);
  return values;
}
