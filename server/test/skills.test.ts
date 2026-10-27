import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../src/config.js";
import { ToolRegistry } from "../src/connectors/registry.js";
import { loadSkills, parseSkill, resolveInputs, SkillError } from "../src/skills/loader.js";

const registry = new ToolRegistry();

const skillSource = (frontmatter: string, body = "Do the thing.") => `---\n${frontmatter}\n---\n${body}\n`;

const VALID = `id: sample
name: Sample
description: A sample skill.
connectors: [slack]
tools: [slack_list_channels]
inputs:
  - name: channel
    label: Channel
    required: true
  - name: hours
    label: Hours
    type: number
    default: 24
  - name: dry_run
    label: Dry run
    type: boolean
    default: false`;

describe("skills loader", () => {
  it("loads every bundled skill and validates its tools against the registry", () => {
    const skills = loadSkills(path.join(repoRoot, "skills"), registry);
    expect(skills.map((s) => s.id).sort()).toEqual([
      "incident-timeline-to-postmortem",
      "notion-action-items-to-slack",
      "slack-channel-digest",
    ]);
    for (const skill of skills) {
      expect(skill.instructions.length).toBeGreaterThan(50);
      // An unquoted " #" starts a YAML comment and silently truncates the value.
      for (const input of skill.inputs) expect(input.description ?? "").not.toMatch(/for example$/);
      for (const tool of skill.tools) expect(registry.get(tool)).toBeDefined();
    }
  });

  it("parses frontmatter, inputs and instructions", () => {
    const skill = parseSkill(skillSource(VALID, "Step one.\nStep two."), "sample.md", registry);
    expect(skill).toMatchObject({ id: "sample", connectors: ["slack"], instructions: "Step one.\nStep two." });
    expect(skill.inputs.map((i) => [i.name, i.type, i.required])).toEqual([
      ["channel", "string", true],
      ["hours", "number", false],
      ["dry_run", "boolean", false],
    ]);
  });

  it.each([
    ["missing frontmatter", "Just instructions", /missing YAML frontmatter/],
    ["an unknown tool", skillSource(VALID.replace("[slack_list_channels]", "[slack_delete_channel]")), /unknown tool "slack_delete_channel"/],
    ["a tool from an undeclared connector", skillSource(VALID.replace("[slack_list_channels]", "[notion_search]")), /needs the notion connector/],
    ["a default of the wrong type", skillSource(VALID.replace("default: 24", 'default: "24"')), /default for "hours" must be a number/],
    ["an unexpected key", skillSource(`${VALID}\nmodel: opus`), /model/],
    ["empty instructions", skillSource(VALID, ""), /instructions are empty/],
  ])("rejects a skill with %s", (_label, source, error) => {
    expect(() => parseSkill(source, "bad.md", registry)).toThrow(error);
  });

  it("rejects duplicate skill ids across files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "relay-skills-"));
    writeFileSync(path.join(dir, "a.md"), skillSource(VALID));
    writeFileSync(path.join(dir, "b.md"), skillSource(VALID));
    expect(() => loadSkills(dir, registry)).toThrow(/Duplicate skill id "sample"/);
  });

  describe("resolveInputs", () => {
    const skill = parseSkill(skillSource(VALID), "sample.md", registry);

    it("applies defaults and coerces form values", () => {
      expect(resolveInputs(skill, { channel: "#general", hours: "48", dry_run: "true" })).toEqual({
        channel: "#general",
        hours: 48,
        dry_run: true,
      });
      expect(resolveInputs(skill, { channel: "#general" })).toEqual({ channel: "#general", hours: 24, dry_run: false });
    });

    it("names missing, unknown and malformed inputs", () => {
      expect(() => resolveInputs(skill, {})).toThrow(new SkillError("Missing required inputs: Channel"));
      expect(() => resolveInputs(skill, { channel: "#x", colour: "red" })).toThrow(/Unknown inputs: colour/);
      expect(() => resolveInputs(skill, { channel: "#x", hours: "lots" })).toThrow(/"Hours" must be a number/);
    });
  });
});
