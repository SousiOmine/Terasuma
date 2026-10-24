import { describe, expect, test } from "bun:test";
import { posix } from "node:path";
import { WORKDIR_IN_CONTAINER } from "../src/server/computer/contract";
import type { ConnectorScriptResult } from "../src/server/connectors/manager";
import { checkPi, setupPi, type PiRuntime } from "../src/server/connectors/pi";

/**
 * pi の設定と確認。
 * コンピュータへの読み書きとコマンド実行は、メモリ上の偽の PiRuntime で差し替える。
 * 確認は実際の 1 回の呼び出し（NDJSON）を読み、終了コードではなく stopReason で判定する。
 */

const AGENT_DIR = posix.join(WORKDIR_IN_CONTAINER, ".pi", "agent");
const AUTH_PATH = posix.join(AGENT_DIR, "auth.json");
const SETTINGS_PATH = posix.join(AGENT_DIR, "settings.json");
const API_KEY = "sk-secret-test-key";

type RuntimeOptions = {
  version?: string;
  versionResult?: ConnectorScriptResult;
  check?: ConnectorScriptResult;
  chmod?: ConnectorScriptResult;
};

function ok(stdout = ""): ConnectorScriptResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

function messageEnd(message: Record<string, unknown>): string {
  return `${JSON.stringify({ type: "message_end", message })}\n`;
}

function successCheck(text = "OK"): ConnectorScriptResult {
  return ok(messageEnd({ stopReason: "stop", content: [{ type: "text", text }] }));
}

/** メモリ上のファイルと、スクリプトの偽の実行を持つ PiRuntime。 */
function fakeRuntime(options: RuntimeOptions = {}) {
  const files = new Map<string, string>();
  const writes: { path: string; text: string }[] = [];
  const scripts: string[] = [];

  const runtime: PiRuntime = {
    async run(script) {
      scripts.push(script);

      if (script === "pi --version") {
        return options.versionResult ?? ok(`${options.version ?? "1.3.0"}\n`);
      }
      if (script.startsWith("rm -f ")) {
        for (const path of [AUTH_PATH, SETTINGS_PATH]) {
          if (script.includes(path)) files.delete(path);
        }
        return ok();
      }
      if (script.startsWith("chmod ")) return options.chmod ?? ok();
      return options.check ?? successCheck();
    },
    async readText(path) {
      return files.get(path) ?? null;
    },
    async writeText(path, text) {
      writes.push({ path, text });
      files.set(path, text);
    },
  };

  return { runtime, files, writes, scripts };
}

function rejectionOf(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "(resolved)",
    (error: unknown) => (error instanceof Error ? error.message : String(error)),
  );
}

describe("pi の設定", () => {
  test("auth.json に選んだプロバイダのキーを書き、ほかのプロバイダを残す", async () => {
    const fake = fakeRuntime();
    fake.files.set(AUTH_PATH, `${JSON.stringify({ openai: { type: "api_key", key: "old-key" } })}\n`);

    await setupPi(fake.runtime, { provider: "anthropic", apiKey: API_KEY, model: "claude-sonnet-4-5" });

    expect(JSON.parse(fake.files.get(AUTH_PATH) ?? "{}")).toEqual({
      openai: { type: "api_key", key: "old-key" },
      anthropic: { type: "api_key", key: API_KEY },
    });
  });

  test("settings.json に defaultProvider と defaultModel を書く", async () => {
    const fake = fakeRuntime();

    await setupPi(fake.runtime, { provider: "anthropic", apiKey: API_KEY, model: "claude-sonnet-4-5" });

    expect(JSON.parse(fake.files.get(SETTINGS_PATH) ?? "{}")).toMatchObject({
      defaultProvider: "anthropic",
      defaultModel: "claude-sonnet-4-5",
    });
  });

  test("設定ディレクトリとファイルの権限を 1 回のスクリプトで絞る", async () => {
    const fake = fakeRuntime();

    await setupPi(fake.runtime, { provider: "anthropic", apiKey: API_KEY, model: "claude-sonnet-4-5" });

    const chmod = fake.scripts.filter((script) => script.startsWith("chmod "));
    expect(chmod).toHaveLength(1);
    expect(chmod[0]).toContain("chmod 700");
    expect(chmod[0]).toContain("chmod 600");
    expect(chmod[0]).toContain("auth.json");
    expect(chmod[0]).toContain("settings.json");
  });

  test("確認に失敗したら、書く前の auth.json と settings.json に戻す", async () => {
    const fake = fakeRuntime({
      check: ok(messageEnd({ stopReason: "error", errorMessage: "401 unauthorized" })),
    });
    const originalAuth = `${JSON.stringify({ openai: { type: "api_key", key: "old-key" } }, null, 2)}\n`;
    const originalSettings = `${JSON.stringify({ defaultProvider: "openai", defaultModel: "gpt-4o" }, null, 2)}\n`;
    fake.files.set(AUTH_PATH, originalAuth);
    fake.files.set(SETTINGS_PATH, originalSettings);

    await expect(
      setupPi(fake.runtime, { provider: "anthropic", apiKey: API_KEY, model: "claude-sonnet-4-5" }),
    ).rejects.toThrow("401 unauthorized");

    expect(fake.files.get(AUTH_PATH)).toBe(originalAuth);
    expect(fake.files.get(SETTINGS_PATH)).toBe(originalSettings);
    expect(fake.scripts.filter((script) => script.startsWith("chmod "))).toHaveLength(2);
  });

  test("もとが無かったファイルは、失敗したら消す", async () => {
    const fake = fakeRuntime({
      check: ok(messageEnd({ stopReason: "error", errorMessage: "401 unauthorized" })),
    });

    await expect(
      setupPi(fake.runtime, { provider: "anthropic", apiKey: API_KEY, model: "claude-sonnet-4-5" }),
    ).rejects.toThrow("401 unauthorized");

    const removals = fake.scripts.filter((script) => script.includes("rm -f"));
    expect(removals).toHaveLength(2);
    expect(removals.some((script) => script.includes("auth.json"))).toBe(true);
    expect(removals.some((script) => script.includes("settings.json"))).toBe(true);
    expect(fake.files.has(AUTH_PATH)).toBe(false);
    expect(fake.files.has(SETTINGS_PATH)).toBe(false);
  });

  test("成功の NDJSON を読み、版と provider/model を 1 行にする", async () => {
    const fake = fakeRuntime();

    const status = await setupPi(fake.runtime, {
      provider: "anthropic",
      apiKey: API_KEY,
      model: "claude-sonnet-4-5",
    });

    expect(status).toEqual({
      status: "pi 1.3.0 (anthropic/claude-sonnet-4-5)",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    expect(fake.scripts).toContain("pi -p --mode json --no-session 'Reply with the single word OK.'");
  });

  test("stopReason が error なら、終了コード 0 でも errorMessage を理由にする", async () => {
    const fake = fakeRuntime({
      check: ok(
        messageEnd({
          stopReason: "error",
          errorMessage: '401 {\n  "message": "invalid x-api-key"\n}',
        }),
      ),
    });

    const reason = await rejectionOf(
      setupPi(fake.runtime, { provider: "anthropic", apiKey: API_KEY, model: "claude-sonnet-4-5" }),
    );

    expect(reason).toBe('401 { "message": "invalid x-api-key" }');
  });

  test("出力が空なら失敗する", async () => {
    const fake = fakeRuntime({ check: ok() });

    await expect(
      setupPi(fake.runtime, { provider: "anthropic", apiKey: API_KEY, model: "claude-sonnet-4-5" }),
    ).rejects.toThrow("pi did not answer.");
  });

  test("checkPi はファイルを書かない", async () => {
    const fake = fakeRuntime();
    fake.files.set(
      SETTINGS_PATH,
      `${JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5" })}\n`,
    );

    const status = await checkPi(fake.runtime);

    expect(fake.writes).toEqual([]);
    expect(status.status).toBe("pi 1.3.0 (anthropic/claude-sonnet-4-5)");
  });

  test("例外文にも戻り値にも API キーを含めない", async () => {
    const success = fakeRuntime();
    const status = await setupPi(success.runtime, {
      provider: "anthropic",
      apiKey: API_KEY,
      model: "claude-sonnet-4-5",
    });
    expect(JSON.stringify(status)).not.toContain(API_KEY);

    const failure = fakeRuntime({
      check: ok(messageEnd({ stopReason: "error", errorMessage: "401 unauthorized" })),
    });
    const reason = await rejectionOf(
      setupPi(failure.runtime, { provider: "anthropic", apiKey: API_KEY, model: "claude-sonnet-4-5" }),
    );
    expect(reason).not.toContain(API_KEY);
  });
});
