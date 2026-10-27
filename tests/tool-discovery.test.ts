import { describe, expect, test } from "bun:test";
import { jsonSchema, tool } from "ai";
import { z } from "zod";
import { readToolOutput } from "../src/server/agent/tool-output";
import { createDiscoveryTools } from "../src/server/agent/tools/discovery";
import { createToolRegistry, type ToolRegistry } from "../src/server/agent/tools/registry";
import { TOOL_CALL_TOOL_NAME, TOOL_SEARCH_TOOL_NAME } from "../src/shared/tools";
import type { ImageRef } from "../src/shared/api/message";

/**
 * モデルのツール一覧に載せないツールの置き場と、それを検索・実行する 2 つ。
 * モデルを通さずに、検索結果の本文と実行の振る舞いをそのまま確かめる。
 */

const REF: ImageRef = { sha256: "a".repeat(64), mime: "image/png", width: 4, height: 3 };

/** ツールを 1 つ実行する。 */
async function runTool(tools: Record<string, unknown>, name: string, input: unknown): Promise<unknown> {
  const definition = tools[name] as { execute?: (value: never, options: never) => unknown } | undefined;
  if (definition?.execute === undefined) throw new Error(`${name} が無いか、実行を持っていません`);
  return definition.execute(input as never, { toolCallId: "call-1", messages: [] } as never);
}

/** 検索の結果の本文を取り出す。 */
async function search(tools: Record<string, unknown>, input: unknown): Promise<string> {
  const output = await runTool(tools, TOOL_SEARCH_TOOL_NAME, input);
  if (typeof output !== "string") throw new Error("tool_search の結果が文字列ではありません");
  return output;
}

/** レジストリを作り、その getter を渡した tool_search / tool_call を組む。 */
async function discoveryTools() {
  const registry = await registryOf();
  return createDiscoveryTools(() => registry);
}

async function registryOf(): Promise<ToolRegistry> {
  return createToolRegistry({
    local_echo: tool({
      description: "ローカルの文字をそのまま返す",
      inputSchema: z.object({ text: z.string().describe("返す文字") }),
      execute: async ({ text }: { text: string }) => `echo: ${text}`,
    }),
    computer_screenshot: tool({
      description: "画面を撮る",
      inputSchema: z.object({}),
      execute: async () => ({ text: "撮りました", images: [REF] }),
    }),
    files_read: tool({
      description: "ファイルを読む",
      inputSchema: jsonSchema({ type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
      execute: async () => "file body",
    }),
  });
}

describe("ツールのレジストリ", () => {
  test("名前は名前順に返る", async () => {
    const registry = await registryOf();
    expect(registry.names()).toEqual(["computer_screenshot", "files_read", "local_echo"]);
  });

  test("名前と説明のどちらでも見つかり、件数の上限で切れる", async () => {
    const registry = await registryOf();

    expect(registry.search("echo", 10).map((match) => match.name)).toEqual(["local_echo"]);
    expect(registry.search("ファイル", 10).map((match) => match.name)).toEqual(["files_read"]);
    // 大文字で書かれても同じように見つかる。
    expect(registry.search("ECHO", 10).map((match) => match.name)).toEqual(["local_echo"]);
    expect(registry.search("e", 1)).toHaveLength(1);
  });

  test("当たらなければ空で、空の検索語も空", async () => {
    const registry = await registryOf();

    expect(registry.search("nothing-here", 10)).toEqual([]);
    expect(registry.search("   ", 10)).toEqual([]);
  });

  test("一覧はサーバー id ごとにまとまり、件数とグループ数が出る", async () => {
    const registry = await registryOf();
    const listing = registry.browse();

    expect(listing).toContain("3 tool(s) available across 3 group(s)");
    expect(listing).toContain("computer (1): computer_screenshot");
    expect(listing).toContain("files (1): files_read");
    expect(listing).toContain("local (1): local_echo");
  });

  test("引数があるツールには、引数の JSON Schema を添える", async () => {
    const registry = await registryOf();
    const [match] = registry.search("echo", 10);

    expect(match?.text).toContain("- local_echo");
    expect(match?.text).toContain("ローカルの文字をそのまま返す");
    expect(match?.text).toContain("Arguments (JSON Schema):");
    expect(match?.text).toContain('"required":["text"]');
  });

  test("引数の無いツールには、引数の節を添えない", async () => {
    const registry = await registryOf();
    const [match] = registry.search("screenshot", 10);

    expect(match?.text).toContain("- computer_screenshot");
    expect(match?.text).not.toContain("Arguments");
  });

  test("引数の説明でも見つかる", async () => {
    const registry = await registryOf();

    expect(registry.search("返す文字", 10).map((match) => match.name)).toEqual(["local_echo"]);
  });

  test("説明が無いツールは、そのことを示す", async () => {
    const registry = await createToolRegistry({
      bare: tool({ description: "", inputSchema: z.object({}), execute: async () => "ok" }),
    });
    const [match] = registry.search("bare", 10);

    expect(match?.text).toContain("(no description)");
  });

  test("名前で実行でき、戻り値はそのまま返る", async () => {
    const registry = await registryOf();
    const output = await registry.call("local_echo", { text: "hi" }, { toolCallId: "call-1" });

    expect(output).toBe("echo: hi");
  });

  test("知らない名前は、検索へ戻る理由つきで失敗する", async () => {
    const registry = await registryOf();
    const failure = await registry.call("nope", {}, { toolCallId: "call-1" }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('Unknown tool "nope"');
    expect((failure as Error).message).toContain("tool_search");
  });

  test("引数がスキーマに合わなければ、実行せずに理由つきで失敗する", async () => {
    const registry = await registryOf();
    const failure = await registry
      .call("local_echo", { text: 1 }, { toolCallId: "call-1" })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('Invalid arguments for "local_echo"');
  });

  test("tool_call で引数が合わないときは、モデルが直せる短い本文にする", async () => {
    const tools = await discoveryTools();
    const failure = await runTool(tools, TOOL_CALL_TOOL_NAME, {
      name: "local_echo",
      args: { text: 1 },
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message.startsWith('Invalid arguments for "local_echo"')).toBe(true);
    expect(message).not.toContain("AI_");
    expect(message.length).toBeLessThan(300);
  });
});

describe("tool_search と tool_call", () => {
  test("検索語を省くと、名前だけの一覧を返す", async () => {
    const tools = await discoveryTools();

    expect(await search(tools, {})).toContain("3 tool(s) available across 3 group(s)");
  });

  test("当たったツールの本文と、次にすることの案内を返す", async () => {
    const tools = await discoveryTools();
    const text = await search(tools, { query: "echo" });

    expect(text).toContain('Found 1 tool(s) matching "echo".');
    expect(text).toContain("- local_echo");
    expect(text).toContain("Arguments (JSON Schema):");
    expect(text).toContain("Run one with tool_call(name, args).");
  });

  test("当たらなくても、存在するツールの一覧を添える", async () => {
    const tools = await discoveryTools();
    const text = await search(tools, { query: "nothing-here" });

    expect(text.startsWith('No tools match "nothing-here".')).toBe(true);
    expect(text).toContain("local_echo");
  });

  test("見つけたツールを、名前を付けた結果で返す", async () => {
    const tools = await discoveryTools();
    const output = await runTool(tools, TOOL_CALL_TOOL_NAME, { name: "local_echo", args: { text: "hi" } });

    expect(readToolOutput(output)).toEqual({ text: "[local_echo]\necho: hi", images: [] });
  });

  test("args が JSON 文字列でも実行でき、空白だけなら引数なしとして扱う", async () => {
    const tools = await discoveryTools();
    const output = await runTool(tools, TOOL_CALL_TOOL_NAME, {
      name: "local_echo",
      args: JSON.stringify({ text: "hi" }),
    });

    expect(readToolOutput(output)).toEqual({ text: "[local_echo]\necho: hi", images: [] });

    const shot = await runTool(tools, TOOL_CALL_TOOL_NAME, { name: "computer_screenshot", args: "   " });
    expect(readToolOutput(shot)).toEqual({ text: "[computer_screenshot]\n撮りました", images: [REF] });
  });

  test("args がオブジェクトでない JSON 文字列なら、短い理由で失敗する", async () => {
    const tools = await discoveryTools();

    await expect(runTool(tools, TOOL_CALL_TOOL_NAME, { name: "local_echo", args: "[1,2]" })).rejects.toThrow(
      'args must be a JSON object, for example {"name":"..."}.',
    );
    await expect(runTool(tools, TOOL_CALL_TOOL_NAME, { name: "local_echo", args: "not json" })).rejects.toThrow(
      "args must be a JSON object",
    );
  });

  test("ツールが返した画像は、tool_call 越しでもそのまま残る", async () => {
    const tools = await discoveryTools();
    const output = await runTool(tools, TOOL_CALL_TOOL_NAME, { name: "computer_screenshot" });

    expect(readToolOutput(output)).toEqual({ text: "[computer_screenshot]\n撮りました", images: [REF] });
  });

  test("知らない名前は、検索へ戻る短い理由で失敗する", async () => {
    const tools = await discoveryTools();

    await expect(runTool(tools, TOOL_CALL_TOOL_NAME, { name: "nope" })).rejects.toThrow(
      'No tool named "nope". Use tool_search to find the name, then call it with tool_call.',
    );
  });

  test("getter は実行のたびに引き直され、差し替えたレジストリが見える", async () => {
    let registry = await registryOf();
    const tools = createDiscoveryTools(() => registry);

    expect(await search(tools, { query: "echo" })).toContain("local_echo");

    // ターンの途中でレジストリが差し替わったのと同じ状態にする。
    registry = await createToolRegistry({
      late_echo: tool({
        description: "あとから足したツール",
        inputSchema: z.object({ text: z.string() }),
        execute: async ({ text }: { text: string }) => `late: ${text}`,
      }),
    });

    expect(await search(tools, { query: "late" })).toContain("late_echo");
    expect(
      readToolOutput(await runTool(tools, TOOL_CALL_TOOL_NAME, { name: "late_echo", args: { text: "hi" } })),
    ).toEqual({ text: "[late_echo]\nlate: hi", images: [] });
  });
});
