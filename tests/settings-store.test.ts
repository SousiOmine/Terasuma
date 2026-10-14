import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { readSettingsFile } from "../src/config";
import { withTempSettings } from "./support";

describe("設定ストア", () => {
  test("プロバイダを足すとファイルにも書かれる", async () => {
    await withTempSettings({ port: 4567 }, async (store, path) => {
      store.putProvider("deepseek", { apiKey: "sk-1" });

      expect(store.read()).toEqual({
        model: null,
        providers: { deepseek: { apiKey: "sk-1" } },
        modelOptions: {},
      });
      expect(readSettingsFile(path)).toEqual({ port: 4567, providers: { deepseek: { apiKey: "sk-1" } } });
    });
  });

  test("既定のモデルも同じ書き込みで変えられる", async () => {
    await withTempSettings(null, async (store, path) => {
      store.putProvider("deepseek", { apiKey: "sk-1" }, "deepseek/deepseek-v4-pro");

      expect(store.read().model).toBe("deepseek/deepseek-v4-pro");
      expect(readSettingsFile(path).model).toBe("deepseek/deepseek-v4-pro");
    });
  });

  test("プロバイダを消すとファイルからも消える", async () => {
    await withTempSettings({ providers: { deepseek: { apiKey: "sk-1" } } }, async (store, path) => {
      expect(store.deleteProvider("deepseek")).toBe(true);
      expect(store.read().providers).toEqual({});
      expect(readSettingsFile(path).providers).toEqual({});

      // 2 度目は設定が無いので、ファイルにも触らない。
      const before = readFileSync(path, "utf8");
      expect(store.deleteProvider("deepseek")).toBe(false);
      expect(readFileSync(path, "utf8")).toBe(before);
    });
  });

  test("既定のモデルは単独でも変えられる", async () => {
    await withTempSettings({ model: "deepseek/deepseek-flash" }, async (store) => {
      store.setModel("openai/gpt-5.6-sol");
      expect(store.read().model).toBe("openai/gpt-5.6-sol");
    });
  });

  test("思考強度はモデルごとに残る", async () => {
    await withTempSettings({ model: "deepseek/deepseek-flash" }, async (store, path) => {
      store.setReasoningEffort("deepseek/deepseek-flash", "medium");
      store.setReasoningEffort("deepseek/deepseek-v4-pro", "high");

      // モデルを切り替えても、それぞれの値が残っている。
      expect(store.read().modelOptions["deepseek/deepseek-flash"]).toEqual({ reasoningEffort: "medium" });
      expect(store.read().modelOptions["deepseek/deepseek-v4-pro"]).toEqual({ reasoningEffort: "high" });
      expect(readSettingsFile(path).modelOptions).toEqual({
        "deepseek/deepseek-flash": { reasoningEffort: "medium" },
        "deepseek/deepseek-v4-pro": { reasoningEffort: "high" },
      });

      // null で未設定に戻すと、書くものが無くなった項目は消える。
      store.setReasoningEffort("deepseek/deepseek-flash", null);
      expect(store.read().modelOptions["deepseek/deepseek-flash"]).toBeUndefined();
      expect(readSettingsFile(path).modelOptions).toEqual({
        "deepseek/deepseek-v4-pro": { reasoningEffort: "high" },
      });

      // 既に未設定のものを戻しても、ファイルには触らない。
      const before = readFileSync(path, "utf8");
      store.setReasoningEffort("deepseek/deepseek-flash", null);
      expect(readFileSync(path, "utf8")).toBe(before);
    });
  });

  test("起動中に手で編集した内容を消さない", async () => {
    await withTempSettings({ port: 4567, providers: { deepseek: { apiKey: "sk-1" } } }, async (store, path) => {
      // アプリが動いている間に、手で openai を足したとする。
      const edited = {
        port: 4567,
        providers: { deepseek: { apiKey: "sk-1" }, openai: { apiKey: "sk-2" } },
      };
      writeFileSync(path, JSON.stringify(edited), "utf8");

      store.setModel("openai/gpt-5.6-sol");

      expect(store.read()).toEqual({
        model: "openai/gpt-5.6-sol",
        providers: { deepseek: { apiKey: "sk-1" }, openai: { apiKey: "sk-2" } },
        modelOptions: {},
      });
      expect(readSettingsFile(path).providers?.["openai"]).toEqual({ apiKey: "sk-2" });
    });
  });

  test("MCP サーバーを足すとファイルにも書かれ、消すと消える", async () => {
    await withTempSettings({ port: 4567 }, async (store, path) => {
      store.putMcpServer("local", { type: "stdio", command: "bunx", args: ["-y", "server-filesystem"] });

      expect(store.readMcp()).toEqual({
        servers: { local: { type: "stdio", command: "bunx", args: ["-y", "server-filesystem"] } },
      });
      expect(readSettingsFile(path).mcpServers).toEqual({
        local: { type: "stdio", command: "bunx", args: ["-y", "server-filesystem"] },
      });
      // モデルの設定は触らない。
      expect(readSettingsFile(path).port).toBe(4567);

      expect(store.deleteMcpServer("local")).toBe(true);
      expect(store.readMcp().servers).toEqual({});
      expect(readSettingsFile(path).mcpServers).toEqual({});
      expect(store.deleteMcpServer("local")).toBe(false);
    });
  });

  test("MCP サーバーの設定は、手で書いた他の項目を消さずに書き換える", async () => {
    await withTempSettings(
      { mcpServers: { local: { type: "stdio", command: "bunx" } }, model: "deepseek/deepseek-flash" },
      async (store, path) => {
        store.putMcpServer("remote", { type: "http", url: "https://mcp.example.test/mcp", oauth: true });

        expect(readSettingsFile(path).mcpServers).toEqual({
          local: { type: "stdio", command: "bunx" },
          remote: { type: "http", url: "https://mcp.example.test/mcp", oauth: true },
        });
        expect(readSettingsFile(path).model).toBe("deepseek/deepseek-flash");
      },
    );
  });

  test("ファイルが壊れていたら書かずに失敗する", async () => {    await withTempSettings({ model: "deepseek/deepseek-flash" }, async (store, path) => {
      writeFileSync(path, "{ 壊れている", "utf8");

      expect(() => store.setModel("openai/gpt-5.6-sol")).toThrow(/JSON/);
      expect(readFileSync(path, "utf8")).toBe("{ 壊れている");
    });
  });
});
