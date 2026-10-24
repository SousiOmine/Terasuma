import { describe, expect, test } from "bun:test";
import { asSchema } from "ai";
import type { ToolSet } from "ai";
import { createHandover } from "../src/server/computer/handover";
import {
  BUILTIN_SKILLS,
  COMPUTER_USE_SKILL,
  CONNECTORS_SKILL,
  DISCORD_SKILL,
  PI_CODING_SKILL,
  ROUTINE_SKILL,
  SKILL_CREATE_SKILL,
  TERA_CREATE_SKILL,
  createSkillLibrary,
  skillCatalogText,
} from "../src/server/agent/skills";
import { createComputerTools } from "../src/server/agent/tools/computer";
import { createConnectorTools } from "../src/server/connectors/tools";
import { createSkillTools } from "../src/server/agent/tools/skill";
import { createSkillManageTools, type SkillChange } from "../src/server/agent/tools/skill-manage";
import type { SkillFileStore, SkillLibrary } from "../src/server/agent/skill-types";
import {
  createConnectorsStub,
  createContainerStub,
  createEnvRequestsStub,
  createImageStub,
  createSkillFileStoreStub,
} from "./support";

/**
 * スキル。
 * 一覧と本文がずれると、エージェントは存在しないスキルを探しに行く。
 * ここで名前を突き合わせて、片方だけを直したときに気づけるようにする。
 */

/** スキルの本文が名指ししている computer_ ツール。 */
function mentionedTools(content: string): string[] {
  return [...new Set(content.match(/computer_[a-z_]+/g) ?? [])].sort();
}

/** 実際にモデルへ渡せる computer_ ツール。 */
function availableTools(): string[] {
  const computer = createComputerTools({
    container: createContainerStub(),
    images: createImageStub(),
    handover: createHandover(),
    env: createEnvRequestsStub(),
    teraId: "t1",
  });
  // コネクタの接続ツール（app_connect_<id>）は computer_ の名前空間には入らない。
  const connectors = createConnectorTools({ connectors: createConnectorsStub() });

  return [...Object.keys(computer), ...Object.keys(connectors)].filter((name) => name.startsWith("computer_")).sort();
}

/** ツールの実行関数を取り出す。 */
function definitionOf(tools: ToolSet, name: string): { execute: (value: never, options: never) => Promise<unknown> } {
  const definition = tools[name] as { execute?: (value: never, options: never) => unknown } | undefined;
  if (definition?.execute === undefined) throw new Error(`${name} ツールが無い`);
  const execute = definition.execute;
  return { execute: async (value, options) => execute(value, options) };
}

/** スキル管理ツール一式と、変更の記録。 */
function skillManageTools(initial: readonly { name: string; description: string; content: string }[] = []) {
  const store = createSkillFileStoreStub(initial);
  const library = createSkillLibrary(store);
  const changes: SkillChange[] = [];
  const tools = createSkillManageTools({ library, store, onChange: (change) => changes.push(change) });
  return { store, library, changes, tools };
}

describe("スキルのカタログ", () => {
  test("computer-use と connectors と skill-create と discord と tera-create と routine が説明つきで載る", () => {
    const catalog = skillCatalogText(BUILTIN_SKILLS);

    expect(catalog).toContain("- computer-use: ");
    expect(catalog).toContain(COMPUTER_USE_SKILL.description);
    expect(catalog).toContain("- connectors: ");
    expect(catalog).toContain(CONNECTORS_SKILL.description);
    expect(catalog).toContain("- skill-create: ");
    expect(catalog).toContain(SKILL_CREATE_SKILL.description);
    expect(catalog).toContain("- discord: ");
    expect(catalog).toContain(DISCORD_SKILL.description);
    expect(catalog).toContain("- tera-create: ");
    expect(catalog).toContain(TERA_CREATE_SKILL.description);
    expect(catalog).toContain("- routine: ");
    expect(catalog).toContain(ROUTINE_SKILL.description);
    expect(BUILTIN_SKILLS.map((skill) => skill.name)).toEqual([
      "computer-use",
      "connectors",
      "skill-create",
      "discord",
      "tera-create",
      "routine",
    ]);
  });
});

describe("pi-coding スキル", () => {
  test("組み込みには入らず、接続しているときだけ一覧に載る", () => {
    expect(BUILTIN_SKILLS.map((skill) => skill.name)).not.toContain("pi-coding");

    const store = createSkillFileStoreStub();
    const connected = createSkillLibrary(store, () => [PI_CODING_SKILL]);
    const disconnected = createSkillLibrary(store, () => []);

    expect(connected.all().map((skill) => skill.name)).toContain("pi-coding");
    expect(connected.get("pi-coding")?.content).toContain("pi-work");
    expect(disconnected.all().map((skill) => skill.name)).not.toContain("pi-coding");
  });

  test("呼び出しのたびに、追加スキルを評価し直す", () => {
    const store = createSkillFileStoreStub();
    let enabled = false;
    const library = createSkillLibrary(store, () => (enabled ? [PI_CODING_SKILL] : []));

    expect(library.all().map((skill) => skill.name)).not.toContain("pi-coding");

    enabled = true;
    expect(library.all().map((skill) => skill.name)).toContain("pi-coding");
  });

  test("pi-coding の作業ファイルとセッションは、仕事ごとの枠に分かれる", () => {
    const pwd = "${PWD##*/}";

    expect(PI_CODING_SKILL.content).toContain(`$HOME/.pi-work/${pwd}/$slot`);
    expect(PI_CODING_SKILL.content).toContain(`pi-work-${pwd}-$slot`);
    expect(PI_CODING_SKILL.content).toContain('-t "=$session"');
    expect(PI_CODING_SKILL.content).toContain("## While a job runs");
    expect(PI_CODING_SKILL.content).toContain("Running jobs side by side");
    expect(PI_CODING_SKILL.content).not.toContain("/tmp/pi-prompt.txt");
    expect(PI_CODING_SKILL.content).not.toContain("/tmp/pi-work.log");
    expect(PI_CODING_SKILL.content).not.toContain("Do not run two pi jobs at once");
  });

  test("pi-coding は、同じリポジトリを並列で触るときに git worktree を分けるよう案内する", () => {
    const content = PI_CODING_SKILL.content;
    const section = content.slice(content.indexOf("## Running jobs side by side"));

    expect(content).toContain("## Running jobs side by side");
    expect(section).toContain("git worktree add -b");
    expect(content).toContain('git worktree remove "$work/tree"');
  });
});

describe("skill ツール", () => {
  test("組み込みスキルは本文を返す", async () => {
    const tools = createSkillTools(createSkillLibrary(createSkillFileStoreStub()));
    const definition = definitionOf(tools, "skill");

    const output = await definition.execute(
      { name: "computer-use" } as never,
      { toolCallId: "call-1", messages: [] } as never,
    );

    expect(output).toBe(COMPUTER_USE_SKILL.content);
  });

  test("自作スキルは本文とディレクトリと同梱ファイルを返す", async () => {
    const library: SkillLibrary = {
      all: () => [],
      get: (name) =>
        name === "deploy-notes"
          ? {
              name,
              description: "Deploy notes",
              content: "# Deploy\n\nRun make deploy.",
              dir: "/home/agent/.agents/skills/deploy-notes",
              resources: ["references/REFERENCE.md", "scripts/run.sh"],
              resourcesTruncated: false,
            }
          : undefined,
      isBuiltin: () => false,
    };
    const definition = definitionOf(createSkillTools(library), "skill");

    const output = await definition.execute(
      { name: "deploy-notes" } as never,
      { toolCallId: "call-1", messages: [] } as never,
    );

    expect(output).toContain("Run make deploy.");
    expect(output).toContain("Skill directory: /home/agent/.agents/skills/deploy-notes");
    expect(output).toContain("- scripts/run.sh");
    expect(output).toContain("- references/REFERENCE.md");
  });

  test("知らない名前は、存在するスキルを添えて失敗する", async () => {
    const tools = createSkillTools(createSkillLibrary(createSkillFileStoreStub()));
    const definition = definitionOf(tools, "skill");

    await expect(
      definition.execute({ name: "nope" } as never, { toolCallId: "call-1", messages: [] } as never),
    ).rejects.toThrow(
      'Unknown skill "nope". Available skills: computer-use, connectors, skill-create, discord, tera-create, routine',
    );
  });

  test("名前は空を許さない", async () => {
    const tools = createSkillTools(createSkillLibrary(createSkillFileStoreStub()));
    const schema = asSchema(tools["skill"]?.inputSchema);
    if (schema.validate === undefined) throw new Error("skill の検証が無い");

    expect(await schema.validate({ name: "" })).toMatchObject({ success: false });
  });
});

describe("skill_manage ツール", () => {
  test("作成、一覧、更新、削除ができる", async () => {
    const { tools, store, changes } = skillManageTools();
    const manage = definitionOf(tools, "skill_manage");

    const created = await manage.execute(
      {
        action: "create",
        name: "deploy-notes",
        description: "Deploy notes",
        content: "# Deploy\n\nRun make deploy.",
      } as never,
      { toolCallId: "call-1", messages: [] } as never,
    );

    expect(created).toContain('Created skill "deploy-notes"');
    expect(store.get("deploy-notes")?.content).toContain("Run make deploy.");
    expect(changes).toEqual([{ action: "create", name: "deploy-notes", description: "Deploy notes" }]);

    const listed = await manage.execute({ action: "list" } as never, { toolCallId: "call-2", messages: [] } as never);
    expect(listed).toContain("Built-in skills (read-only):");
    expect(listed).toContain("- computer-use: ");
    expect(listed).toContain("- deploy-notes: Deploy notes");

    const updated = await manage.execute(
      { action: "update", name: "deploy-notes", content: "# Deploy\n\nRun make deploy now." } as never,
      { toolCallId: "call-3", messages: [] } as never,
    );
    expect(updated).toContain('Updated skill "deploy-notes"');
    expect(store.get("deploy-notes")?.content).toContain("Run make deploy now.");
    expect(changes.at(-1)).toEqual({ action: "update", name: "deploy-notes" });

    const deleted = await manage.execute(
      { action: "delete", name: "deploy-notes" } as never,
      { toolCallId: "call-4", messages: [] } as never,
    );
    expect(deleted).toContain('Deleted skill "deploy-notes"');
    expect(store.get("deploy-notes")).toBeNull();
    expect(changes.at(-1)).toEqual({ action: "delete", name: "deploy-notes" });
  });

  test("組み込みスキルは変更も削除もできない", async () => {
    const { tools } = skillManageTools();
    const manage = definitionOf(tools, "skill_manage");

    await expect(
      manage.execute(
        { action: "update", name: "computer-use", description: "changed" } as never,
        { toolCallId: "call-1", messages: [] } as never,
      ),
    ).rejects.toThrow('"computer-use" is a built-in skill');

    await expect(
      manage.execute(
        { action: "delete", name: "skill-create" } as never,
        { toolCallId: "call-2", messages: [] } as never,
      ),
    ).rejects.toThrow('"skill-create" is a built-in skill');
  });

  test("同じ名前は作れない", async () => {
    const { tools } = skillManageTools();
    const manage = definitionOf(tools, "skill_manage");
    const input = {
      action: "create",
      name: "deploy-notes",
      description: "Deploy notes",
      content: "body",
    } as const;

    await manage.execute(input as never, { toolCallId: "call-1", messages: [] } as never);
    await expect(manage.execute(input as never, { toolCallId: "call-2", messages: [] } as never)).rejects.toThrow(
      'A skill named "deploy-notes" already exists',
    );
  });

  test("必要な項目が無ければ失敗する", async () => {
    const { tools } = skillManageTools();
    const manage = definitionOf(tools, "skill_manage");

    await expect(
      manage.execute({ action: "create" } as never, { toolCallId: "call-1", messages: [] } as never),
    ).rejects.toThrow('action "create" needs name');

    await expect(
      manage.execute(
        { action: "create", name: "deploy-notes", description: "Deploy notes" } as never,
        { toolCallId: "call-2", messages: [] } as never,
      ),
    ).rejects.toThrow('action "create" needs content');

    await expect(
      manage.execute(
        { action: "update", name: "deploy-notes" } as never,
        {
          toolCallId: "call-3",
          messages: [],
        } as never,
      ),
    ).rejects.toThrow('action "update" needs description or content');
  });

  test("list は読み飛ばしたディレクトリを理由付きで出す", async () => {
    const base = createSkillFileStoreStub();
    const store: SkillFileStore = {
      ...base,
      scan: () => ({
        skills: [],
        problems: [{ name: "broken", reason: "invalid YAML frontmatter" }],
      }),
    };
    const tools = createSkillManageTools({
      library: createSkillLibrary(store),
      store,
      onChange: () => undefined,
    });

    const listed = await definitionOf(tools, "skill_manage").execute(
      { action: "list" } as never,
      { toolCallId: "call-1", messages: [] } as never,
    );

    expect(listed).toContain("Skipped skill directories:");
    expect(listed).toContain("- broken: invalid YAML frontmatter");
  });
});

describe("computer-use の本文", () => {
  test("ツールは事前に渡らないことと、見つけ方を書いている", () => {
    const content = COMPUTER_USE_SKILL.content;

    expect(content).toContain("not preloaded");
    expect(content).toContain("tool_search");
    expect(content).toContain("tool_call");
  });

  test("名指ししている computer_ ツールは、実際に渡せるツールと一致する", () => {
    expect(mentionedTools(COMPUTER_USE_SKILL.content)).toEqual(availableTools());
  });
});

describe("connectors の本文", () => {
  test("接続ツールを名前で列挙せず、検索とカードの流れを書いている", () => {
    const content = CONNECTORS_SKILL.content;

    expect(content).toContain("app_connect_");
    expect(content).toContain("tool_search");
    expect(content).toContain("tool_call");
    expect(content).toContain("app_request");
  });
});

describe("skill-create の本文", () => {
  test("標準の置き場と作成ツールを書いている", () => {
    const content = SKILL_CREATE_SKILL.content;

    expect(content).toContain("/home/agent/.agents/skills");
    expect(content).toContain("SKILL.md");
    expect(content).toContain("skill_manage");
    expect(content).toContain("references/");
  });
});

describe("discord の本文", () => {
  test("送るツールと、事前に渡らないことと、見つけ方を書いている", () => {
    const content = DISCORD_SKILL.content;

    expect(content).toContain("discord_send");
    expect(content).toContain("discord_connect");
    expect(content).toContain("tool_search");
    expect(content).toContain("tool_call");
  });

  test("文字数・レート・メンションの制限と、できないことを書いている", () => {
    const content = DISCORD_SKILL.content;

    expect(content).toContain("2000");
    expect(content).toContain("429");
    expect(content).toContain("Mentions do not notify");
    expect(content).toContain("can only post");
    expect(content).toContain("bot token");
  });
});

describe("routine の本文", () => {
  test("聞くことと、スケジュールの形と、扱うツールを書いている", () => {
    const content = ROUTINE_SKILL.content;

    expect(content).toContain("routine_create");
    expect(content).toContain("routine_list");
    expect(content).toContain("routine_delete");
    expect(content).toContain('{"kind":"daily","time":"08:30"}');
    // 実行の仕方（誰に見せるか、どこへ届けるか）は、ルーチンを作るときの指示に書くもの。
    // 手順書には置かない。
    expect(content).not.toContain("Nobody is watching");
  });
});

describe("tera-create の本文", () => {
  test("聞き方と、ツールの見つけ方と、渡す値を書いている", () => {
    const content = TERA_CREATE_SKILL.content;

    // ユーザーにはフォームで聞き、ツールは検索してから実行する。
    expect(content).toContain("chat_ui");
    expect(content).toContain("<Form");
    expect(content).toContain("tool_search");
    expect(content).toContain("tool_call");
    expect(content).toContain("tera_create");

    // 渡す値と、作られたあとの置き場所。
    expect(content).toContain("id:");
    expect(content).toContain("role");
    expect(content).toContain("policy");
    expect(content).toContain("/home/agent/teras");
    expect(content).toContain("sidebar");
  });
});
