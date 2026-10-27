import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_IDENTITY_CHARS } from "../src/server/agent/identity";
import { createToolRegistry } from "../src/server/tools/registry";
import { createTeraToolset } from "../src/server/tools/tera";
import { TERA_CREATE_TOOL_NAME } from "../src/shared/tools";
import type { Store } from "../src/server/data/store";
import { makeStore } from "./support";

/**
 * 新しい Tera を作るツール。
 * モデルを介さずに直接呼び、作られるものと、断るときに何も残さないことを確かめる。
 */

/** ツール一式から、tera_create の実行を取り出す。 */
function createTool(store: Store, dataDir: string) {
  const tools = createTeraToolset({ store, dataDir }).toolset();
  const definition = tools[TERA_CREATE_TOOL_NAME] as
    | { execute?: (input: never, options: never) => unknown }
    | undefined;
  if (definition?.execute === undefined) throw new Error("tera_create ツールが無いか、実行を持っていません");
  return definition;
}

/** tera_create を 1 回呼ぶ。 */
async function call(store: Store, dataDir: string, input: Record<string, unknown>): Promise<string> {
  const output = await createTool(store, dataDir).execute?.(input as never, { toolCallId: "call-1" } as never);
  if (typeof output !== "string") throw new Error("tera_create の結果が文字列ではありません");
  return output;
}

/** 一時ディレクトリを作り、確かめ終わったら消す。 */
async function withDataDir<T>(run: (dataDir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "terasuma-tera-"));

  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** ホスト側の作業フォルダ。 */
function workspaceDir(dataDir: string, teraId: string): string {
  return join(dataDir, "container", "home", "teras", teraId);
}

/** 役割と行動方針と名前を持つ、正しい引数。 */
const VALID = {
  id: "researcher",
  name: "調べる係",
  role: "技術記事を調べて要点をまとめる。",
  policy: "出典を示す。分からないことは推測せず、ユーザーに聞く。",
};

describe("tera_create ツール", () => {
  test("新しい Tera と作業フォルダを作り、名前・役割・行動方針を identity に入れる", async () => {
    await withDataDir(async (dataDir) => {
      const store = makeStore();
      const output = await call(store, dataDir, VALID);

      expect(store.getTera("researcher")?.name).toBe("調べる係");
      expect(existsSync(workspaceDir(dataDir, "researcher"))).toBe(true);

      const identity = store.readIdentity("researcher");
      // 新しい Tera は、書いた版と system プロンプト用の版が同じところから始まる。
      expect(identity.content).toBe(identity.applied);
      expect(identity.applied).toContain('You are "調べる係".');
      expect(identity.applied).toContain("技術記事を調べて要点をまとめる。");
      expect(identity.applied).toContain("# How you work");
      expect(identity.applied).toContain("出典を示す。");

      expect(output).toContain("調べる係");
      expect(output).toContain("/home/agent/teras/researcher");
      expect(output).toContain("sidebar");
    });
  });

  test("名前の前後の空白は落とし、名前が空なら断る", async () => {
    await withDataDir(async (dataDir) => {
      const store = makeStore();
      await call(store, dataDir, { ...VALID, name: "  調べる係  " });

      expect(store.getTera("researcher")?.name).toBe("調べる係");

      await expect(call(store, dataDir, { ...VALID, id: "writer", name: "   " })).rejects.toThrow(
        "name must not be empty",
      );
      expect(store.getTera("writer")).toBeNull();
    });
  });

  test("同じ id と同じ名前は断り、Tera もフォルダも増やさない", async () => {
    await withDataDir(async (dataDir) => {
      const store = makeStore();
      await call(store, dataDir, VALID);

      await expect(call(store, dataDir, { ...VALID, name: "別の名前" })).rejects.toThrow(
        'A Tera with id "researcher" already exists',
      );
      await expect(call(store, dataDir, { ...VALID, id: "writer" })).rejects.toThrow(
        'A Tera named "調べる係" already exists',
      );

      expect(store.getTera("writer")).toBeNull();
      expect(existsSync(workspaceDir(dataDir, "writer"))).toBe(false);
    });
  });

  test("作業フォルダの名前にならない id は断り、何も作らない", async () => {
    await withDataDir(async (dataDir) => {
      const store = makeStore();

      for (const id of ["Researcher", "-researcher", "research_er", "研究", "a/b", ".."]) {
        await expect(call(store, dataDir, { ...VALID, id })).rejects.toThrow(
          "cannot be used as a workspace folder name",
        );
      }

      expect(store.listTeras().map((tera) => tera.id)).toEqual(["default"]);
    });
  });

  test("役割と行動方針が長すぎるときは、上限を添えて断る", async () => {
    await withDataDir(async (dataDir) => {
      const store = makeStore();

      await expect(call(store, dataDir, { ...VALID, policy: "あ".repeat(MAX_IDENTITY_CHARS) })).rejects.toThrow(
        `at most ${MAX_IDENTITY_CHARS} characters`,
      );

      expect(store.getTera("researcher")).toBeNull();
      expect(existsSync(workspaceDir(dataDir, "researcher"))).toBe(false);
    });
  });

  test("tool_search で見つけられる", async () => {
    await withDataDir(async (dataDir) => {
      const store = makeStore();
      const registry = await createToolRegistry(createTeraToolset({ store, dataDir }).toolset());

      expect(registry.names()).toEqual([TERA_CREATE_TOOL_NAME]);
      expect(registry.search("tera create", 10).map((match) => match.name)).toEqual([TERA_CREATE_TOOL_NAME]);
      expect(registry.search("create assistant", 10).map((match) => match.name)).toEqual([TERA_CREATE_TOOL_NAME]);
    });
  });
});
