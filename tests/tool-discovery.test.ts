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
});

describe("tool_search と tool_call", () => {
  test("検索語を省くと、名前だけの一覧を返す", async () => {
    const tools = createDiscoveryTools(await registryOf());

    expect(await search(tools, {})).toContain("3 tool(s) available across 3 group(s)");
  });

  test("当たったツールの本文と、次にすることの案内を返す", async () => {
    const tools = createDiscoveryTools(await registryOf());
    const text = await search(tools, { query: "echo" });

    expect(text).toContain('Found 1 tool(s) matching "echo".');
    expect(text).toContain("- local_echo");
    expect(text).toContain("Arguments (JSON Schema):");
    expect(text).toContain("Run one with tool_call(name, args).");
  });

  test("当たらなくても、存在するツールの一覧を添える", async () => {
    const tools = createDiscoveryTools(await registryOf());
    const text = await search(tools, { query: "nothing-here" });

    expect(text.startsWith('No tools match "nothing-here".')).toBe(true);
    expect(text).toContain("local_echo");
  });

  test("見つけたツールを、名前を付けた結果で返す", async () => {
    const tools = createDiscoveryTools(await registryOf());
    const output = await runTool(tools, TOOL_CALL_TOOL_NAME, { name: "local_echo", args: { text: "hi" } });

    expect(readToolOutput(output)).toEqual({ text: "[local_echo]\necho: hi", images: [] });
  });

  test("ツールが返した画像は、tool_call 越しでもそのまま残る", async () => {
    const tools = createDiscoveryTools(await registryOf());
    const output = await runTool(tools, TOOL_CALL_TOOL_NAME, { name: "computer_screenshot" });

    expect(readToolOutput(output)).toEqual({ text: "[computer_screenshot]\n撮りました", images: [REF] });
  });

  test("知らない名前は、実行の失敗として返る", async () => {
    const tools = createDiscoveryTools(await registryOf());

    await expect(runTool(tools, TOOL_CALL_TOOL_NAME, { name: "nope" })).rejects.toThrow('Unknown tool "nope"');
  });
});
