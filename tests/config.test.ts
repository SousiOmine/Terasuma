import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE_NAME, DEFAULT_PORT, loadConfig } from "../src/config";
import { mcpServerSettingsFromForm, providerSettingsFromForm } from "../src/server/data/settings-form";
import {
  normalizeProvider,
  readSettingsFile,
  toModelSettings,
  writeSettingsFile,
} from "../src/server/data/settings-schema";
import { isProviderId } from "../src/shared/ids";

/** 一時ディレクトリを設定ディレクトリとデータディレクトリの両方に見立てて loadConfig を呼ぶ。 */
function withConfigFile<T>(content: string | null, run: (env: NodeJS.ProcessEnv, dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "terasuma-config-"));
  try {
    if (content !== null) writeFileSync(join(dir, CONFIG_FILE_NAME), content, "utf8");
    return run({ TERASUMA_CONFIG_DIR: dir, TERASUMA_DATA_DIR: dir }, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadConfig", () => {
  test("設定ファイルが無ければ既定値になる", () => {
    withConfigFile(null, (env, dir) => {
      const config = loadConfig(env);

      expect(config.port).toBe(DEFAULT_PORT);
      expect(config.engine).toBe("ai-sdk");
      // モデルとプロバイダは未設定から始まる。設定画面で入れるまでは使えない。
      expect(toModelSettings(readSettingsFile(config.configPath))).toEqual({
        model: null,
        providers: {},
        modelOptions: {},
      });
      expect(config.configPath).toBe(join(dir, CONFIG_FILE_NAME));
    });
  });

  test("設定ファイルの値を読む", () => {
    withConfigFile(
      JSON.stringify({
        model: "deepseek/deepseek-v4-pro",
        providers: { deepseek: { apiKey: "secret" } },
        modelOptions: { "deepseek/deepseek-v4-pro": { reasoningEffort: "high" } },
        port: 4567,
      }),
      (env) => {
        const config = loadConfig(env);

        expect(config.port).toBe(4567);
        // engine は開発用の切り替えなので、設定ファイルではなく環境変数だけで決める。
        expect(config.engine).toBe("ai-sdk");
        expect(toModelSettings(readSettingsFile(config.configPath))).toEqual({
          model: "deepseek/deepseek-v4-pro",
          providers: { deepseek: { apiKey: "secret" } },
          modelOptions: { "deepseek/deepseek-v4-pro": { reasoningEffort: "high" } },
        });
      },
    );
  });

  test("環境変数は設定ファイルより優先される", () => {
    withConfigFile(JSON.stringify({ port: 4567 }), (env) => {
      const config = loadConfig({ ...env, TERASUMA_PORT: "5000", TERASUMA_ENGINE: "mock" });

      expect(config.port).toBe(5000);
      expect(config.engine).toBe("mock");
    });
  });

  test("設定ファイルの一部だけを書いてもよい", () => {
    withConfigFile(JSON.stringify({ port: 4567 }), (env) => {
      const config = loadConfig(env);

      expect(config.port).toBe(4567);
      expect(config.engine).toBe("ai-sdk");
    });
  });

  test("保存先は設定ディレクトリとデータディレクトリから組み立てる", () => {
    withConfigFile(null, (env, dir) => {
      const config = loadConfig(env);

      expect(config.configDir).toBe(dir);
      expect(config.configPath).toBe(join(dir, CONFIG_FILE_NAME));
      expect(config.dataDir).toBe(dir);
      expect(config.dbPath).toBe(join(dir, "terasuma.db"));
    });
  });

  test("JSON として読めない設定ファイルは起動時に止める", () => {
    withConfigFile('{"model": }', (env) => {
      expect(() => loadConfig(env)).toThrow(/JSON として解釈できません/);
    });
  });

  test("未知の項目は綴り違いとして止める", () => {
    withConfigFile(JSON.stringify({ provider: "deepseek" }), (env) => {
      expect(() => loadConfig(env)).toThrow(/未知の項目/);
    });
  });

  test("設定ファイルの model は形式を確かめる", () => {
    withConfigFile(JSON.stringify({ model: "deepseek-flash" }), (env) => {
      expect(() => loadConfig(env)).toThrow(/provider\/model/);
    });
  });

  test("設定ファイルの port は範囲を確かめる", () => {
    withConfigFile(JSON.stringify({ port: 70000 }), (env) => {
      expect(() => loadConfig(env)).toThrow(/65535/);
    });
  });

  test("環境変数の port は数値と範囲を確かめる", () => {
    withConfigFile(null, (env) => {
      expect(() => loadConfig({ ...env, TERASUMA_PORT: "3000abc" })).toThrow(/TERASUMA_PORT/);
      expect(() => loadConfig({ ...env, TERASUMA_PORT: "0" })).toThrow(/TERASUMA_PORT/);
    });
  });

  test("環境変数の engine は値を確かめる", () => {
    withConfigFile(null, (env) => {
      expect(() => loadConfig({ ...env, TERASUMA_ENGINE: "fake" })).toThrow(/TERASUMA_ENGINE/);
    });
  });
});

describe("providers の検証", () => {
  const read = (providers: unknown) => withConfigFile(JSON.stringify({ providers }), (env) => loadConfig(env));

  test("既知のプロバイダは apiKey を要求する", () => {
    expect(() => read({ deepseek: {} })).toThrow(/apiKey/);
    expect(() => read({ deepseek: { apiKey: "" } })).toThrow(/空にはできません/);
    expect(() => read({ deepseek: { apiKey: "  " } })).toThrow(/空にはできません/);
  });

  test("baseUrl を持つものは独自エンドポイントとして扱い、label も持てる", () => {
    withConfigFile(
      JSON.stringify({ providers: { deepseek: { apiKey: "x", baseUrl: "https://example.test/v1", label: "社内" } } }),
      (env) => {
        const settings = toModelSettings(readSettingsFile(loadConfig(env).configPath));
        expect(settings.providers["deepseek"]).toEqual({
          apiKey: "x",
          baseUrl: "https://example.test/v1",
          label: "社内",
        });
      },
    );
  });

  test("接続先を自分で決めないものに label は書けない", () => {
    expect(() => read({ deepseek: { apiKey: "x", label: "社内" } })).toThrow(/label/);
  });

  test("カタログの有無は設定の読み込みでは確かめない（呼ぶ前に resolveModel が確かめる）", () => {
    withConfigFile(JSON.stringify({ providers: { mygateway: { apiKey: "x" } } }), (env) => {
      const config = loadConfig(env);
      expect(toModelSettings(readSettingsFile(config.configPath)).providers).toEqual({
        mygateway: { apiKey: "x" },
      });
    });
  });

  test("独自エンドポイントは baseUrl と label を持てる", () => {
    withConfigFile(
      JSON.stringify({
        providers: {
          "custom-1": { baseUrl: "https://gateway.example.test/v1/", label: "社内ゲートウェイ", apiKey: "x" },
        },
      }),
      (env) => {
        const settings = toModelSettings(readSettingsFile(loadConfig(env).configPath));

        // 末尾のスラッシュは落として保存する（URL の組み立てを単純にするため）。
        expect(settings.providers).toEqual({
          "custom-1": { baseUrl: "https://gateway.example.test/v1", label: "社内ゲートウェイ", apiKey: "x" },
        });
      },
    );
  });

  test("Ollama のような鍵の要らないエンドポイントは apiKey 無しでよい", () => {
    withConfigFile(JSON.stringify({ providers: { ollama: { baseUrl: "http://127.0.0.1:11434/v1" } } }), (env) => {
      const settings = toModelSettings(readSettingsFile(loadConfig(env).configPath));
      expect(settings.providers["ollama"]).toEqual({ baseUrl: "http://127.0.0.1:11434/v1" });
    });
  });

  test("書けない値を弾く", () => {
    expect(() => read([])).toThrow(/オブジェクト/);
    expect(() => read({ DeepSeek: { apiKey: "x" } })).toThrow(/使えない id/);
    expect(() => read({ deepseek: { apiKey: "x", apiKeey: "y" } })).toThrow(/未知の項目/);
    expect(() => read({ deepseek: "sk-xxx" })).toThrow(/オブジェクト/);
    expect(() => read({ "custom-1": { baseUrl: "ftp://example.test" } })).toThrow(/http/);
    expect(() => read({ "custom-1": { baseUrl: "not a url" } })).toThrow(/URL/);
  });
});

describe("modelOptions の検証", () => {
  const read = (modelOptions: unknown) => withConfigFile(JSON.stringify({ modelOptions }), (env) => loadConfig(env));

  test("モデル ID の形式を確かめる", () => {
    expect(() => read({ "deepseek-flash": { reasoningEffort: "high" } })).toThrow(/provider\/model/);
  });

  test("未知の項目は綴り違いとして止める", () => {
    expect(() => read({ "deepseek/deepseek-flash": { reasoningEfort: "high" } })).toThrow(/未知の項目/);
  });

  test("思考強度は空でない文字列に限る", () => {
    expect(() => read({ "deepseek/deepseek-flash": { reasoningEffort: "  " } })).toThrow(/空でない文字列/);
    expect(() => read({ "deepseek/deepseek-flash": { reasoningEffort: 3 } })).toThrow(/空でない文字列/);
  });

  test("モデル 1 件はオブジェクトにする", () => {
    expect(() => read({ "deepseek/deepseek-flash": "high" })).toThrow(/オブジェクト/);
    expect(() => read([])).toThrow(/オブジェクト/);
  });
});

describe("mcpServers の検証", () => {
  const read = (mcpServers: unknown) => withConfigFile(JSON.stringify({ mcpServers }), (env) => loadConfig(env));

  test("ローカルのサーバーは command と args, env を持つ", () => {
    withConfigFile(
      JSON.stringify({
        mcpServers: {
          local: {
            type: "stdio",
            command: "bunx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            env: { HOME_DIR: "/tmp" },
          },
        },
      }),
      (env) => {
        expect(readSettingsFile(loadConfig(env).configPath).mcpServers).toEqual({
          local: {
            type: "stdio",
            command: "bunx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
            env: { HOME_DIR: "/tmp" },
          },
        });
      },
    );
  });

  test("HTTP のサーバーは url だけを持つ", () => {
    withConfigFile(
      JSON.stringify({ mcpServers: { remote: { type: "http", url: "https://mcp.example.test/mcp/" } } }),
      (env) => {
        // 末尾のスラッシュは落として保存する（接続先そのものを指すため）。
        expect(readSettingsFile(loadConfig(env).configPath).mcpServers).toEqual({
          remote: { type: "http", url: "https://mcp.example.test/mcp" },
        });
      },
    );
  });

  test("type と食い違う項目は止める", () => {
    expect(() => read({ local: { type: "stdio", command: "bunx", url: "http://127.0.0.1/mcp" } })).toThrow(
      /http のサーバー/,
    );
    expect(() => read({ remote: { type: "http", url: "http://127.0.0.1/mcp", command: "bunx" } })).toThrow(
      /stdio のサーバー/,
    );
    expect(() => read({ remote: { type: "sse", url: "http://127.0.0.1/mcp" } })).toThrow(/"stdio" か "http"/);
  });

  test("未知の項目と使えない id は止める", () => {
    expect(() => read({ local: { type: "stdio", command: "bunx", shell: true } })).toThrow(/未知の項目/);
    expect(() => read({ remote: { type: "http", url: "http://127.0.0.1/mcp", oauth: true } })).toThrow(/未知の項目/);
    expect(() => read({ "Local Server": { type: "stdio", command: "bunx" } })).toThrow(/使えない id/);
  });

  test("command と url は空にできない", () => {
    expect(() => read({ local: { type: "stdio", command: "  " } })).toThrow(/空でない文字列/);
    expect(() => read({ remote: { type: "http", url: "" } })).toThrow(/空でない文字列/);
    expect(() => read({ remote: { type: "http", url: "file:///tmp/x" } })).toThrow(/http:\/\//);
    expect(() => read({ remote: { type: "http", url: "not a url" } })).toThrow(/URL として読めません/);
  });

  test("env の名前と値を確かめる", () => {
    expect(() => read({ local: { type: "stdio", command: "bunx", env: { "1BAD": "x" } } })).toThrow(/環境変数名/);
    expect(() => read({ local: { type: "stdio", command: "bunx", env: { GOOD: 3 } } })).toThrow(/文字列/);
  });

  test("args は空でない文字列の配列にする", () => {
    expect(() => read({ local: { type: "stdio", command: "bunx", args: "-y" } })).toThrow(/配列/);
    expect(() => read({ local: { type: "stdio", command: "bunx", args: [""] } })).toThrow(/空でない文字列/);
  });
});

describe("env の検証", () => {
  const read = (env: unknown) =>
    withConfigFile(JSON.stringify({ env }), (settingsEnv) => readSettingsFile(loadConfig(settingsEnv).configPath));

  test("コンピュータのコマンドへ渡す環境変数として読む", () => {
    expect(read({ GITHUB_TOKEN: "ghp_1", NO_COLOR: "1" }).env).toEqual({
      GITHUB_TOKEN: "ghp_1",
      NO_COLOR: "1",
    });
  });

  test("名前はシェルが読める形に限る", () => {
    expect(() => read({ "1BAD": "x" })).toThrow(/環境変数名/);
    expect(() => read({ "A-B": "x" })).toThrow(/環境変数名/);
  });

  test("値は空でない文字列に限る", () => {
    expect(() => read({ TOKEN: "" })).toThrow(/空にはできません/);
    expect(() => read({ TOKEN: 3 })).toThrow(/文字列/);
    // podman exec の引数にできない NUL は、起動してからではなく読み込みで止める。
    expect(() => read({ TOKEN: "a\0b" })).toThrow(/NUL/);
  });

  test("オブジェクトでなければ止める", () => {
    expect(() => read(["TOKEN"])).toThrow(/オブジェクト/);
  });
});

describe("MCP サーバーの入力の検証", () => {
  test("未入力は省き、trim して保存できる形にする", () => {
    expect(
      mcpServerSettingsFromForm(
        {
          id: "local",
          type: "stdio",
          command: "  bunx  ",
          args: ["-y", "@scope/pkg"],
          env: { TOKEN: "abc" },
          url: null,
        },
        "mcpServers.local",
      ),
    ).toEqual({
      type: "stdio",
      command: "bunx",
      args: ["-y", "@scope/pkg"],
      env: { TOKEN: "abc" },
    });

    expect(
      mcpServerSettingsFromForm(
        { id: "remote", type: "http", command: null, args: null, env: null, url: "https://mcp.example.test/mcp" },
        "mcpServers.remote",
      ),
    ).toEqual({ type: "http", url: "https://mcp.example.test/mcp" });
  });

  test("種類と食い違う項目は止める", () => {
    const base = { id: "x", command: null, args: null, env: null, url: null };

    expect(() => mcpServerSettingsFromForm({ ...base, type: "stdio" }, "mcpServers.x")).toThrow(/command/);
    expect(() => mcpServerSettingsFromForm({ ...base, type: "http" }, "mcpServers.x")).toThrow(/url/);
    expect(() =>
      mcpServerSettingsFromForm(
        { ...base, type: "stdio", command: "bunx", url: "http://127.0.0.1/mcp" },
        "mcpServers.x",
      ),
    ).toThrow(/http のサーバー/);
    expect(() =>
      mcpServerSettingsFromForm({ ...base, type: "http", url: "http://127.0.0.1/mcp", args: ["-y"] }, "mcpServers.x"),
    ).toThrow(/stdio のサーバー/);
  });
});

describe("writeSettingsFile", () => {
  test("書いた内容をそのまま読み直せる", () => {
    withConfigFile(null, (_env, dir) => {
      const path = join(dir, CONFIG_FILE_NAME);
      writeSettingsFile(path, { model: "openai/gpt-5.6-sol", port: 4567 });

      expect(readSettingsFile(path)).toEqual({ model: "openai/gpt-5.6-sol", port: 4567 });
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        model: "openai/gpt-5.6-sol",
        port: 4567,
      });
    });
  });

  test("プロバイダの並び順を保つ", () => {
    withConfigFile(null, (_env, dir) => {
      const path = join(dir, CONFIG_FILE_NAME);
      writeSettingsFile(path, {
        providers: { openai: { apiKey: "a" }, deepseek: { apiKey: "b" } },
      });

      expect(Object.keys(readSettingsFile(path).providers ?? {})).toEqual(["openai", "deepseek"]);
    });
  });
});

describe("API から来た入力の検証", () => {
  test("空欄は未入力として扱い、トリムして渡す", () => {
    expect(providerSettingsFromForm({ apiKey: "  ", baseUrl: "", label: null })).toEqual({});
    expect(providerSettingsFromForm({ apiKey: " sk-1 ", baseUrl: null, label: " 社内 " })).toEqual({
      apiKey: "sk-1",
      label: "社内",
    });
  });

  test("normalizeProvider はプロバイダの設定を検証する", () => {
    expect(normalizeProvider({ apiKey: "sk-1" }, "providers.deepseek")).toEqual({ apiKey: "sk-1" });
    expect(() => normalizeProvider({}, "providers.deepseek")).toThrow(/apiKey/);
    // カタログの有無はこの層では分からない（呼び出しの前に resolveModel が確かめる）。
    expect(normalizeProvider({ apiKey: "sk-1" }, "providers.mygateway")).toEqual({ apiKey: "sk-1" });
    // baseUrl を書けば独自エンドポイントとして通る。
    expect(normalizeProvider({ baseUrl: "https://example.test/v1" }, "providers.deepseek")).toEqual({
      baseUrl: "https://example.test/v1",
    });
  });

  test("normalizeProvider は独自エンドポイントの URL を確かめる", () => {
    expect(normalizeProvider({ baseUrl: "http://127.0.0.1:1234/v1/" }, "providers.custom-1")).toEqual({
      baseUrl: "http://127.0.0.1:1234/v1",
    });
    expect(() => normalizeProvider({ baseUrl: "https://" }, "providers.custom-1")).toThrow(/URL/);
  });

  test("isProviderId はモデル ID の先頭部分に使える形だけを通す", () => {
    expect(isProviderId("deepseek")).toBe(true);
    expect(isProviderId("custom-1")).toBe(true);
    expect(isProviderId("Custom")).toBe(false);
    expect(isProviderId("custom/1")).toBe(false);
    expect(isProviderId("-custom")).toBe(false);
  });
});
