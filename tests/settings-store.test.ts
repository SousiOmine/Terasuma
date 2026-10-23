import { describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readSettingsFile } from "../src/server/data/settings";
import { withTempDir } from "./harness";
import { withTempSettings } from "./support";

describe("設定ストア", () => {
  test("プロバイダを足すとファイルにも書かれる", async () => {
    await withTempSettings({ port: 4567 }, async (store, path) => {
      store.putProvider("deepseek", { apiKey: "sk-1" });

      expect(store.read()).toEqual({
        model: null,
        providers: { deepseek: { apiKey: "sk-1" } },
        modelOptions: {},
        mcpServers: {},
        webSearch: { default: null, providers: {} },
        env: {},
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
        mcpServers: {},
        webSearch: { default: null, providers: {} },
        env: {},
      });
      expect(readSettingsFile(path).providers?.["openai"]).toEqual({ apiKey: "sk-2" });
    });
  });

  test("MCP サーバーを足すとファイルにも書かれ、消すと消える", async () => {
    await withTempSettings({ port: 4567 }, async (store, path) => {
      store.putMcpServer("local", { type: "stdio", command: "bunx", args: ["-y", "server-filesystem"] });

      expect(store.read().mcpServers).toEqual({
        local: { type: "stdio", command: "bunx", args: ["-y", "server-filesystem"] },
      });
      expect(readSettingsFile(path).mcpServers).toEqual({
        local: { type: "stdio", command: "bunx", args: ["-y", "server-filesystem"] },
      });
      // モデルの設定は触らない。
      expect(readSettingsFile(path).port).toBe(4567);

      expect(store.deleteMcpServer("local")).toBe(true);
      expect(store.read().mcpServers).toEqual({});
      expect(readSettingsFile(path).mcpServers).toEqual({});
      expect(store.deleteMcpServer("local")).toBe(false);
    });
  });

  test("MCP サーバーの設定は、手で書いた他の項目を消さずに書き換える", async () => {
    await withTempSettings(
      { mcpServers: { local: { type: "stdio", command: "bunx" } }, model: "deepseek/deepseek-flash" },
      async (store, path) => {
        store.putMcpServer("remote", { type: "http", url: "https://mcp.example.test/mcp" });

        expect(readSettingsFile(path).mcpServers).toEqual({
          local: { type: "stdio", command: "bunx" },
          remote: { type: "http", url: "https://mcp.example.test/mcp" },
        });
        expect(readSettingsFile(path).model).toBe("deepseek/deepseek-flash");
      },
    );
  });

  test("ファイルが壊れていたら書かずに失敗する", async () => {
    await withTempSettings({ model: "deepseek/deepseek-flash" }, async (store, path) => {
      writeFileSync(path, "{ 壊れている", "utf8");

      expect(() => store.setModel("openai/gpt-5.6-sol")).toThrow(/JSON/);
      expect(readFileSync(path, "utf8")).toBe("{ 壊れている");
    });
  });

  test("検索プロバイダを足すとファイルにも書かれ、既定になる", async () => {
    await withTempSettings({ port: 4567 }, async (store, path) => {
      store.putWebSearchProvider("exa", { apiKey: "exa-key" });

      expect(store.read().webSearch).toEqual({
        default: "exa",
        providers: { exa: { apiKey: "exa-key" } },
      });
      expect(readSettingsFile(path).webSearch).toEqual({
        providers: { exa: { apiKey: "exa-key" } },
        default: "exa",
      });
    });
  });

  test("検索プロバイダを足しても、既定は明示したときだけ変わる", async () => {
    await withTempSettings(null, async (store, path) => {
      store.putWebSearchProvider("exa", { apiKey: "a" });
      store.putWebSearchProvider("tavily", { apiKey: "b" });

      // 2 つ目を足しても、既定は最初のもののまま。
      expect(store.read().webSearch.default).toBe("exa");

      store.setDefaultWebSearchProvider("tavily");
      expect(store.read().webSearch.default).toBe("tavily");
      expect(readSettingsFile(path).webSearch?.default).toBe("tavily");

      store.putWebSearchProvider("brave", { apiKey: "c" }, true);
      expect(store.read().webSearch.default).toBe("brave");
    });
  });

  test("既定の検索プロバイダを消すと、既定も未設定に戻る", async () => {
    await withTempSettings(null, async (store, path) => {
      store.putWebSearchProvider("exa", { apiKey: "a" });
      store.putWebSearchProvider("tavily", { apiKey: "b" });
      expect(store.deleteWebSearchProvider("exa")).toBe(true);

      expect(store.read().webSearch).toEqual({
        default: null,
        providers: { tavily: { apiKey: "b" } },
      });
      expect(readSettingsFile(path).webSearch).toEqual({ providers: { tavily: { apiKey: "b" } } });

      // 2 度目は設定が無いので、ファイルにも触らない。
      expect(store.deleteWebSearchProvider("exa")).toBe(false);
    });
  });

  test("知らない検索プロバイダ id は設定の読み込みで止まる", async () => {
    await withTempDir("terasuma-settings-", async (dir) => {
      const path = join(dir, "config.json");
      writeFileSync(path, JSON.stringify({ webSearch: { providers: { unknown: { apiKey: "x" } } } }), "utf8");

      expect(() => readSettingsFile(path)).toThrow(/使える id/);
    });
  });

  test("既定が登録されていない検索プロバイダを指すと止まる", async () => {
    await withTempDir("terasuma-settings-", async (dir) => {
      const path = join(dir, "config.json");
      writeFileSync(path, JSON.stringify({ webSearch: { default: "exa", providers: {} } }), "utf8");

      expect(() => readSettingsFile(path)).toThrow(/設定されていません/);
    });
  });

  test("コンピュータの環境変数を設定すると、ファイルにも書かれる", async () => {
    await withTempSettings(null, async (store, path) => {
      store.setEnv("GITHUB_TOKEN", "ghp_1");

      expect(store.read().env).toEqual({ GITHUB_TOKEN: "ghp_1" });
      expect(readSettingsFile(path).env).toEqual({ GITHUB_TOKEN: "ghp_1" });
    });
  });

  test("環境変数は同じ名前を上書きし、消すとファイルからも消える", async () => {
    await withTempSettings({ env: { GITHUB_TOKEN: "old", NO_COLOR: "1" } }, async (store, path) => {
      store.setEnv("GITHUB_TOKEN", "new");
      expect(store.read().env).toEqual({ GITHUB_TOKEN: "new", NO_COLOR: "1" });

      expect(store.deleteEnv("GITHUB_TOKEN")).toBe(true);
      expect(store.read().env).toEqual({ NO_COLOR: "1" });
      expect(readSettingsFile(path).env).toEqual({ NO_COLOR: "1" });

      // 2 度目は設定が無いので、ファイルにも触らない。
      expect(store.deleteEnv("GITHUB_TOKEN")).toBe(false);
    });
  });

  test("設定ファイルは、ほかの利用者から読めない権限で書く", async () => {
    await withTempSettings(null, async (store, path) => {
      store.setEnv("GITHUB_TOKEN", "ghp_1");

      // プロバイダの API キーと同じファイルなので、0600 に締める。
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });
  });
});
