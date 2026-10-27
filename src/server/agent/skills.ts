/**
 * 組み込みスキルと、スキルの一覧。
 *
 * スキルは「ひとまとまりの仕事の手順書」で、モデルのツール一覧とは別に置く。
 * 組み込みスキルと、エージェントが作ったスキルの一覧は、どちらも system プロンプトに載せる。
 * 本文はモデルが skill ツールで読んだときにだけ渡す。
 * ターンの途中でスキルが変わったときは、そのターンの system プロンプトを組み直さず、
 * 次のモデル呼び出しの前に user メッセージで知らせる（engine/sdk.ts の notifySkillsChanged）。
 *
 * 本文は ./skills/<name>.md に置く。名前・説明は下の表が持ち、本文はバンドル時に文字列として読む。
 * 本文を別ファイルにすると、差分のレビューも、Markdown としての読み直しもできる。
 *
 * 本文はツールの説明と同じく英語で書く。返事の言語は会話の末尾の指示で切り替わる。
 */
import computerUse from "./skills/computer-use.md" with { type: "text" };
import composio from "./skills/composio.md" with { type: "text" };
import connectors from "./skills/connectors.md" with { type: "text" };
import discord from "./skills/discord.md" with { type: "text" };
import mcp from "./skills/mcp.md" with { type: "text" };
import piCoding from "./skills/pi-coding.md" with { type: "text" };
import routine from "./skills/routine.md" with { type: "text" };
import skillCreate from "./skills/skill-create.md" with { type: "text" };
import teraCreate from "./skills/tera-create.md" with { type: "text" };
import type { Skill, SkillFileStore, SkillLibrary } from "./skill-types";

export type { LoadedSkill, Skill, SkillFileStore, SkillLibrary } from "./skill-types";

/** 組み込みスキルの本文。表の file から引く。 */
const CONTENTS: Record<string, string> = {
  "computer-use": computerUse,
  composio,
  connectors,
  discord,
  mcp,
  "pi-coding": piCoding,
  routine,
  "skill-create": skillCreate,
  "tera-create": teraCreate,
};

/** 組み込みスキルの名前と説明。並び順が、system プロンプトの一覧の順になる。 */
const BUILTIN: readonly { name: string; file: string; description: string }[] = [
  {
    name: "computer-use",
    file: "computer-use",
    description: "Driving the desktop container's screen, mouse and keyboard: screenshots, clicks, typing, keys, windows and applications. The computer_ tools are not preloaded — find them with tool_search and run them with tool_call.",
  },
  {
    name: "connectors",
    file: "connectors",
    description: "Connecting an app before you use it (its API, or a program inside the computer): how to find that connector's connect tool with tool_search, and how the user fills in the card.",
  },
  {
    name: "skill-create",
    file: "skill-create",
    description: "Creating and maintaining skills: the Agent Skills format, where SKILL.md lives under /home/agent/.agents/skills, the name and description rules, supporting files, and how to update or delete a skill.",
  },
  {
    name: "discord",
    file: "discord",
    description: "Posting messages to one Discord channel per Tera through a webhook: when to send, the 2000-character and embed limits, rate limits, and how to connect a webhook.",
  },
  {
    name: "tera-create",
    file: "tera-create",
    description: "Creating another Tera: when a task needs a separate assistant with its own role and history, asking the user for its name, role and behavior policy in a form, then creating it with the tera_create tool.",
  },
  {
    name: "routine",
    file: "routine",
    description: "Scheduled work (routines) that runs at a set local time or interval: when to create one, what the user needs to decide first, the schedule forms, and how to list, change, delete or run it.",
  },
  {
    name: "mcp",
    file: "mcp",
    description: "MCP servers: using their tools through tool_search and tool_call, adding a server from the chat, and removing one.",
  },
  {
    name: "pi-coding",
    file: "pi-coding",
    description: "Writing or changing code with pi-coding-agent (pi) inside the computer through tmux: how to call it, wait for it, and check the result. Load it before you edit code yourself.",
  },
  {
    name: "composio",
    file: "composio",
    description: "Reaching apps through Composio (Gmail, Slack, Notion, Linear and over 1,600 others): searching the catalog with app_composio_search and running a tool with app_composio_execute.",
  },
];

/** 表からスキルを 1 つ組む。 */
function skillOf(entry: { name: string; file: string; description: string }): Skill {
  return { name: entry.name, description: entry.description, content: CONTENTS[entry.file] ?? "" };
}

/**
 * このアプリに組み込まれているスキル（常に一覧に載る）。
 * pi-coding と composio は接続している間だけ載せるので、ここには入れない。
 */
export const BUILTIN_SKILLS: readonly Skill[] = BUILTIN.filter(
  (entry) => entry.name !== "pi-coding" && entry.name !== "composio",
).map(skillOf);

/** 名前でスキルを引く（組み込みと、接続で切り替わるものを含む）。無ければ undefined。 */
function builtinOf(name: string): Skill | undefined {
  const entry = BUILTIN.find((candidate) => candidate.name === name);
  return entry === undefined ? undefined : skillOf(entry);
}

/**
 * system プロンプトに載せる一覧。1 スキル 1 行にして、本文を読む前の判断材料だけを与える。
 * 組み込みと自作の両方を渡す。スキルの一覧が変わったときだけ文字列が変わる。
 */
export function skillCatalogText(skills: readonly Skill[]): string {
  return skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
}

/**
 * 組み込みスキルと、置き場のスキルをまとめる。
 * 一覧と本文は呼び出しのたびに引き直すので、作成や更新はすぐに見える。
 * extra は接続状態などで変わるスキル（pi-coding、composio）を、呼ぶたびに評価して足す。
 */
export function createSkillLibrary(store: SkillFileStore, extra: () => readonly Skill[] = () => []): SkillLibrary {
  function available(): readonly Skill[] {
    return [...BUILTIN_SKILLS, ...extra()];
  }

  return {
    all() {
      return [...available(), ...store.scan().skills];
    },
    get(name) {
      const builtin = available().find((skill) => skill.name === name);
      if (builtin !== undefined) {
        return { ...builtin, dir: null, resources: [], resourcesTruncated: false };
      }
      return store.get(name) ?? undefined;
    },
    isBuiltin(name) {
      return available().some((skill) => skill.name === name);
    },
  };
}

/**
 * 接続している間だけ一覧に載せるスキル。
 * app.ts が、コネクタの接続状態に応じて extraSkills として渡す。
 */
export const PI_CODING_SKILL: Skill = builtinOf("pi-coding") ?? { name: "pi-coding", description: "", content: "" };
export const COMPOSIO_SKILL: Skill = builtinOf("composio") ?? { name: "composio", description: "", content: "" };

/** 名前で組み込みスキルを引く（extra に頼らず参照したいとき用）。 */
export { builtinOf };
