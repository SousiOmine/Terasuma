import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { SKILL_TOOL } from "../../../shared/tools";
import type { LoadedSkill, SkillLibrary } from "../skill-types";

/**
 * スキルを読み込むツール。
 *
 * 組み込みスキルと、エージェントが作ったスキルの一覧は、モデルの指示に載せる。
 * 本文はここで読んだときだけ渡す。使わないスキルの本文で毎回の文脈を埋めないための分け方。
 *
 * 一覧と本文は呼び出しのたびにファイルから引き直すので、同じターンで作ったスキルも読める。
 */

export function createSkillTools(library: SkillLibrary): ToolSet {
  return {
    [SKILL_TOOL]: tool({
      description: [
        "Load the full instructions of one skill from the skill catalog in your instructions.",
        "Pass the exact name from the catalog. Built-in skills and skills you created are both here.",
        "For a skill you created, the result also gives its directory and the files bundled with it, so you can read scripts and references with read or bash.",
        "Load a skill before starting work that matches it; the content is long, so load it when you are about to do the job, not speculatively.",
      ].join(" "),
      inputSchema: z.object({
        name: z.string().min(1).describe("Exact skill name from the skill catalog"),
      }),
      execute: async ({ name }: { name: string }) => {
        const skill = library.get(name);
        if (skill === undefined) {
          const available = library.all().map((entry) => entry.name);
          const known = available.length === 0 ? "(none)" : available.join(", ");
          throw new Error(
            `Unknown skill "${name}". Available skills: ${known}. ` +
              'Use skill_manage(action: "list") to see them, including directories that could not be read.',
          );
        }
        return formatSkill(skill);
      },
    }),
  };
}

/** 本文に、スキルのディレクトリと同梱ファイルを添える。組み込みは本文だけ。 */
function formatSkill(skill: LoadedSkill): string {
  if (skill.dir === null) return skill.content;

  const lines: string[] = [];
  if (skill.content.trim().length > 0) lines.push(skill.content.trimEnd());

  lines.push("", `Skill directory: ${skill.dir}`, "Relative paths in this skill are relative to the skill directory.");

  if (skill.resources.length > 0) {
    lines.push("", "Bundled files:", ...skill.resources.map((file) => `- ${file}`));
    if (skill.resourcesTruncated) {
      lines.push("(The list is truncated. Use bash to list the rest of the skill directory.)");
    }
  }

  return lines.join("\n");
}
