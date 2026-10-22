import type { ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";
import { SKILL_MANAGE_TOOL_NAME } from "../../../shared/tools";
import { BUILTIN_SKILLS } from "../skills";
import type { SkillFileStore, SkillLibrary } from "../skill-types";

/**
 * スキルを作成、更新、削除、一覧するツール。
 *
 * スキルは Agent Skills の標準に合わせて、コンテナのホームの中の
 * `.agents/skills/<name>/SKILL.md` に置く。frontmatter の書き方はここで面倒を見る。
 * 作成と更新のあとは、同じターンでも skill ツールから読める。
 */

export type SkillManageOptions = {
  /** 組み込みスキルの判定と、一覧に使う。 */
  library: SkillLibrary;
  /** ファイルの作成、更新、削除、走査に使う。 */
  store: SkillFileStore;
  /** ターンの途中でスキルが変わったことを、次のモデル呼び出しへ知らせる。 */
  onChange: (change: SkillChange) => void;
};

/** ターンの途中で起きたスキルの変更。 */
export type SkillChange = {
  action: "create" | "update" | "delete";
  name: string;
  description?: string;
};

type ActionResult = {
  action: "create" | "update" | "delete" | "list";
  name?: string;
  description?: string;
  content?: string;
};

export function createSkillManageTools({ library, store, onChange }: SkillManageOptions): ToolSet {
  return {
    [SKILL_MANAGE_TOOL_NAME]: tool({
      description: [
        "Create, update, delete or list the skills you wrote yourself.",
        "Skills are directories under /home/agent/.agents/skills/<name> containing SKILL.md in the Agent Skills format.",
        'action="create" needs name, description and content; action="update" needs name and at least one of description/content; action="delete" needs name; action="list" takes nothing.',
        "delete removes the whole skill directory, including scripts, references and assets.",
        "Built-in skills are read-only. A created or changed skill can be loaded with skill right away. A short user message announces the change for the rest of this turn, and the catalog in the system prompt includes it from the next turn.",
      ].join(" "),
      inputSchema: z.object({
        action: z.enum(["create", "update", "delete", "list"]).describe("Operation to perform"),
        name: z
          .string()
          .optional()
          .describe(
            "Skill name: 1-64 characters of lowercase letters, digits and single hyphens; it becomes the directory name.",
          ),
        description: z
          .string()
          .optional()
          .describe("One line for the catalog: 1-1024 characters saying what the skill does and when to use it."),
        content: z
          .string()
          .optional()
          .describe("Markdown body of SKILL.md. Keep it under about 500 lines; put long material in references/."),
      }),
      execute: async (input: ActionResult) => {
        const action = input.action;

        if (action === "list") return listSkills(store);

        const name = requiredText(input.name, "name", action);
        if (library.isBuiltin(name)) {
          throw new Error(`"${name}" is a built-in skill and cannot be changed or deleted.`);
        }

        if (action === "create") {
          const description = requiredText(input.description, "description", action);
          const content = requiredText(input.content, "content", action);

          if (store.get(name) !== null) {
            throw new Error(`A skill named "${name}" already exists. Use action "update" to change it.`);
          }

          const skill = store.create({ name, description, content });
          onChange({ action: "create", name: skill.name, description: skill.description });
          return `Created skill "${skill.name}". Load it with skill("${skill.name}") now; it is in the system prompt from the next turn.`;
        }

        if (action === "update") {
          if (input.description === undefined && input.content === undefined) {
            throw new Error('action "update" needs description or content.');
          }

          const skill = store.update(name, {
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.content === undefined ? {} : { content: input.content }),
          });
          onChange({ action: "update", name: skill.name });
          return `Updated skill "${skill.name}". Load it with skill("${skill.name}") to check the result; it is in the system prompt from the next turn.`;
        }

        if (!store.delete(name)) {
          throw new Error(`No skill named "${name}" was created. Use action "list" to see your skills.`);
        }
        onChange({ action: "delete", name });
        return `Deleted skill "${name}" and its directory.`;
      },
    }),
  };
}

/** 一覧の本文。読み込めなかったディレクトリも、直せるように理由付きで出す。 */
function listSkills(store: SkillFileStore): string {
  const scan = store.scan();

  const lines = [
    "Built-in skills (read-only):",
    ...BUILTIN_SKILLS.map((skill) => `- ${skill.name}: ${skill.description}`),
    "",
    "Your skills:",
  ];

  if (scan.skills.length === 0) {
    lines.push("(none)");
  } else {
    for (const skill of scan.skills) lines.push(`- ${skill.name}: ${skill.description}`);
  }

  if (scan.problems.length > 0) {
    lines.push("", "Skipped skill directories:");
    for (const problem of scan.problems) lines.push(`- ${problem.name}: ${problem.reason}`);
  }

  return lines.join("\n");
}

/** 必須の文字列を取り出す。空だけの値は指定なしとして扱う。 */
function requiredText(value: string | undefined, field: string, action: string): string {
  const text = value?.trim() ?? "";
  if (text.length === 0) throw new Error(`action "${action}" needs ${field}.`);
  return text;
}
