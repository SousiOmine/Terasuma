import { describe, expect, test } from "bun:test";
import { asSchema } from "ai";
import { createHandover } from "../src/server/computer/handover";
import { BUILTIN_SKILLS, COMPUTER_USE_SKILL, SKILL_CATALOG } from "../src/server/agent/skills";
import { createComputerTools } from "../src/server/agent/tools/computer";
import { createSkillTools } from "../src/server/agent/tools/skill";
import { createContainerStub, createImageStub } from "./support";

/**
 * 組み込みスキル。
 * 本文とツールの一覧がずれると、エージェントは存在しないツールを探しに行く。
 * ここで名前を突き合わせて、片方だけを直したときに気づけるようにする。
 */

/** スキルの本文が名指ししている computer_ ツール。 */
function mentionedTools(content: string): string[] {
  return [...new Set(content.match(/computer_[a-z_]+/g) ?? [])].sort();
}

/** 実際にモデルへ渡せる computer_ ツール。 */
function availableTools(): string[] {
  const tools = createComputerTools({
    container: createContainerStub(),
    images: createImageStub(),
    handover: createHandover(),
    teraId: "t1",
  });
  return Object.keys(tools).sort();
}

describe("スキルのカタログ", () => {
  test("computer-use が説明つきで載る", () => {
    expect(SKILL_CATALOG).toContain("- computer-use: ");
    expect(SKILL_CATALOG).toContain(COMPUTER_USE_SKILL.description);
    expect(BUILTIN_SKILLS.map((skill) => skill.name)).toEqual(["computer-use"]);
  });
});

describe("skill ツール", () => {
  test("名前を渡すと本文を返す", async () => {
    const tools = createSkillTools(BUILTIN_SKILLS);
    const definition = tools["skill"] as { execute?: (value: never, options: never) => unknown } | undefined;
    if (definition?.execute === undefined) throw new Error("skill ツールが無い");

    const output = await definition.execute(
      { name: "computer-use" } as never,
      {
        toolCallId: "call-1",
        messages: [],
      } as never,
    );

    expect(output).toBe(COMPUTER_USE_SKILL.content);
  });

  test("知らない名前は、存在するスキルを添えて失敗する", async () => {
    const tools = createSkillTools(BUILTIN_SKILLS);
    const definition = tools["skill"] as { execute?: (value: never, options: never) => unknown } | undefined;
    if (definition?.execute === undefined) throw new Error("skill ツールが無い");

    await expect(
      definition.execute({ name: "nope" } as never, { toolCallId: "call-1", messages: [] } as never),
    ).rejects.toThrow('Unknown skill "nope". Available skills: computer-use');
  });

  test("名前は空を許さない", async () => {
    const tools = createSkillTools(BUILTIN_SKILLS);
    const schema = asSchema(tools["skill"]?.inputSchema);
    if (schema.validate === undefined) throw new Error("skill の検証が無い");

    expect(await schema.validate({ name: "" })).toMatchObject({ success: false });
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
