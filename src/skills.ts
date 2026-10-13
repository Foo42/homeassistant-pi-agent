import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { defineTool } from "./define-tool.js";

export interface Skill {
  name: string;
  description: string;
  /** Full SKILL.md body (frontmatter stripped). */
  body: string;
}

/** Minimal frontmatter parser: only handles flat `key: value` lines. */
function parseSkillFile(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
  }
  return { meta, body: match[2].trim() };
}

/** Load every `<dir>/<skill>/SKILL.md`. Missing directory => no skills. */
export async function loadSkills(dir: string): Promise<Skill[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const skills: Skill[] = [];
  for (const entry of entries) {
    try {
      const raw = await readFile(join(dir, entry, "SKILL.md"), "utf8");
      const { meta, body } = parseSkillFile(raw);
      skills.push({ name: meta.name || entry, description: meta.description || "(no description)", body });
    } catch {
      // not a skill directory; ignore
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/** Short index that goes into the system prompt (progressive disclosure). */
export function skillsPromptSection(skills: Skill[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return [
    "You have skills: focused instructions you can load on demand.",
    "When a request matches a skill's description, call read_skill with its name BEFORE answering, then follow it.",
    ...lines,
  ].join("\n");
}

/** Tool that returns the full body of a skill. */
export function createReadSkillTool(skills: Skill[]): AgentTool<any> {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return defineTool({
    name: "read_skill",
    label: "Read skill",
    description: "Load the full instructions of a skill by name.",
    parameters: Type.Object({
      name: Type.String({ description: "Skill name from the skills list" }),
    }),
    execute: async (_toolCallId, params) => {
      const skill = byName.get(params.name);
      if (!skill) {
        throw new Error(`Unknown skill "${params.name}". Available: ${[...byName.keys()].join(", ")}`);
      }
      return { content: [{ type: "text", text: skill.body }], details: { skill: skill.name } };
    },
  });
}
