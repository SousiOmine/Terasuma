import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE_NAME, DEFAULT_MODEL, DEFAULT_PORT, loadConfig } from "../src/config";

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
    withConfigFile(null, (env) => {
      const config = loadConfig(env);

      expect(config.model).toBe(DEFAULT_MODEL);
      expect(config.port).toBe(DEFAULT_PORT);
      expect(config.engine).toBe("mastra");
      expect(config.baseUrl).toBeNull();
      expect(config.apiKey).toBeNull();
    });
  });

  test("設定ファイルの値を読む", () => {
    withConfigFile(
      JSON.stringify({
        model: "openai/gpt-5.6-sol",
        port: 4567,
        engine: "mock",
        baseUrl: "https://example.test/v1",
        apiKey: "secret",
      }),
      (env) => {
        const config = loadConfig(env);

        expect(config.model).toBe("openai/gpt-5.6-sol");
        expect(config.port).toBe(4567);
        expect(config.engine).toBe("mock");
        expect(config.baseUrl).toBe("https://example.test/v1");
        expect(config.apiKey).toBe("secret");
      },
    );
  });

  test("環境変数は設定ファイルより優先される", () => {
    withConfigFile(JSON.stringify({ model: "openai/gpt-5.6-sol", port: 4567 }), (env) => {
      const config = loadConfig({ ...env, TERASUMA_MODEL: "deepseek/deepseek-flash", TERASUMA_PORT: "5000" });

      expect(config.model).toBe("deepseek/deepseek-flash");
      expect(config.port).toBe(5000);
    });
  });

  test("設定ファイルの一部だけを書いてもよい", () => {
    withConfigFile(JSON.stringify({ port: 4567 }), (env) => {
      const config = loadConfig(env);

      expect(config.port).toBe(4567);
      expect(config.model).toBe(DEFAULT_MODEL);
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
