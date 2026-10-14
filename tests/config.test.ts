import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_FILE_NAME,
  DEFAULT_PORT,
  isProviderId,
  loadConfig,
  normalizeProvider,
  providerSettingsFromForm,
  readSettingsFile,
  toModelSettings,
  writeSettingsFile,
} from "../src/config";

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
      expect(config.engine).toBe("mastra");
      // モデルとプロバイダは未設定から始まる。設定画面で入れるまでは使えない。
      expect(toModelSettings(readSettingsFile(config.configPath))).toEqual({ model: null, providers: {} });
      expect(config.configPath).toBe(join(dir, CONFIG_FILE_NAME));
    });
  });

  test("設定ファイルの値を読む", () => {
    withConfigFile(
      JSON.stringify({
        model: "deepseek/deepseek-v4-pro",
        providers: { deepseek: { apiKey: "secret" } },
        port: 4567,
        engine: "mock",
      }),
      (env) => {
        const config = loadConfig(env);

        expect(config.port).toBe(4567);
        expect(config.engine).toBe("mock");
        expect(toModelSettings(readSettingsFile(config.configPath))).toEqual({
          model: "deepseek/deepseek-v4-pro",
          providers: { deepseek: { apiKey: "secret" } },
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
      expect(config.engine).toBe("mastra");
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

  test("既知のプロバイダに baseUrl と label は書けない", () => {
    expect(() => read({ deepseek: { apiKey: "x", baseUrl: "https://example.test/v1" } })).toThrow(/baseUrl/);
    expect(() => read({ deepseek: { apiKey: "x", label: "社内" } })).toThrow(/label/);
  });

  test("知らない id は baseUrl を要求する", () => {
    expect(() => read({ mygateway: { apiKey: "x" } })).toThrow(/baseUrl/);
  });

  test("独自エンドポイントは baseUrl と label を持てる", () => {
    withConfigFile(
      JSON.stringify({
        providers: { "custom-1": { baseUrl: "https://gateway.example.test/v1/", label: "社内ゲートウェイ", apiKey: "x" } },
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

describe("writeSettingsFile", () => {
  test("書いた内容をそのまま読み直せる", () => {
    withConfigFile(null, (_env, dir) => {
      const path = join(dir, CONFIG_FILE_NAME);
      writeSettingsFile(path, { model: "openai/gpt-5.6-sol", port: 4567, engine: "mock" });

      expect(readSettingsFile(path)).toEqual({ model: "openai/gpt-5.6-sol", port: 4567, engine: "mock" });
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        model: "openai/gpt-5.6-sol",
        port: 4567,
        engine: "mock",
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

  test("normalizeProvider は既知のプロバイダの形を強制する", () => {
    expect(normalizeProvider("deepseek", { apiKey: "sk-1" }, "providers.deepseek")).toEqual({ apiKey: "sk-1" });
    expect(() => normalizeProvider("deepseek", {}, "providers.deepseek")).toThrow(/apiKey/);
    expect(() => normalizeProvider("deepseek", { baseUrl: "https://example.test/v1" }, "providers.deepseek")).toThrow(
      /baseUrl/,
    );
  });

  test("normalizeProvider は独自エンドポイントの URL を確かめる", () => {
    expect(normalizeProvider("custom-1", { baseUrl: "http://127.0.0.1:1234/v1/" }, "providers.custom-1")).toEqual({
      baseUrl: "http://127.0.0.1:1234/v1",
    });
    expect(() => normalizeProvider("custom-1", {}, "providers.custom-1")).toThrow(/baseUrl/);
    expect(() => normalizeProvider("custom-1", { baseUrl: "https://" }, "providers.custom-1")).toThrow(/URL/);
  });

  test("isProviderId はモデル ID の先頭部分に使える形だけを通す", () => {
    expect(isProviderId("deepseek")).toBe(true);
    expect(isProviderId("custom-1")).toBe(true);
    expect(isProviderId("Custom")).toBe(false);
    expect(isProviderId("custom/1")).toBe(false);
    expect(isProviderId("-custom")).toBe(false);
  });
});
