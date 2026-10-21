import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { SKILL_TOOL } from "../../../shared/tools";
import type { Skill } from "../skills";

/**
 * スキルを読み込むツール。
 *
 * 一覧（名前と 1 文の説明）は system プロンプトに載せ、本文はここで読んだときだけ渡す。
 * 使わないスキルの本文で毎回の文脈を埋めないための分け方。
 */

/** モデルへ渡すツール。キーはツール名（"skill"）。 */
export type SkillToolset = ToolSet;

export function createSkillTools(skills: readonly Skill[]): SkillToolset {
  const byName = new Map<string, Skill>(skills.map((skill) => [skill.name, skill]));

  return {
    [SKILL_TOOL]: tool({
      description: [
        "Load the full instructions of one skill from the skill catalog in your instructions.",
        "Pass the exact name from the catalog.",
        "Load a skill before starting work that matches it; the content is long, so load it when you are about to do the job, not speculatively.",
      ].join(" "),
      inputSchema: z.object({
        name: z.string().min(1).describe("Exact skill name from the skill catalog"),
      }),
      execute: async ({ name }: { name: string }) => {
        const skill = byName.get(name);
        if (skill === undefined) {
          const known = skills.length === 0 ? "(none)" : skills.map((entry) => entry.name).join(", ");
          throw new Error(`Unknown skill "${name}". Available skills: ${known}`);
        }
        return skill.content;
      },
    }),
  };
}
