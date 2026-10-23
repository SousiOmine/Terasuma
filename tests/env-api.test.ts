import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CONFIG_FILE_NAME } from "../src/config";
import type { ComputerEnvView } from "../src/shared/types";
import { readSettingsFile } from "../src/server/data/settings";
import { withServer } from "./harness";

/**
 * 環境変数の API。
 * 値は入力の経路でだけ受け取り、応答にも一覧にも含めない。
 */

function answerRequest(teraId: string, body: Record<string, unknown>): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ teraId, ...body }),
  };
}

/** 名前の一覧を読む。 */
async function readNames(response: Response): Promise<readonly string[]> {
  expect(response.status).toBe(200);
  return ((await response.json()) as ComputerEnvView).variables;
}

describe("環境変数の API", () => {
  test("入力された値は設定に保存され、応答にも戻り値にも含めない", async () => {
    await withServer(async ({ request, envRequests, settingsPath }) => {
      const waiting = envRequests.wait("t1", "GITHUB_TOKEN", new AbortController().signal);

      const response = await request(
        "/api/computer/env/answer",
        answerRequest("t1", { name: "GITHUB_TOKEN", kind: "value", value: "ghp_secret" }),
      );

      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");

      // モデルへ返る文にも、保存されたファイルにも、値は応答として出さない。
      expect(await waiting).not.toContain("ghp_secret");
      expect(readSettingsFile(settingsPath).env).toEqual({ GITHUB_TOKEN: "ghp_secret" });
    });
  });

  test("取り消すと、保存せずに待ちを終える", async () => {
    await withServer(async ({ request, envRequests, settingsPath }) => {
      const waiting = envRequests.wait("t1", "GITHUB_TOKEN", new AbortController().signal);
      // 失敗する待ちなので、返事を送る前に受け取る側を用意しておく。
      const failure = waiting.catch((error: unknown) => (error as Error).message);

      const response = await request(
        "/api/computer/env/answer",
        answerRequest("t1", { name: "GITHUB_TOKEN", kind: "cancel" }),
      );

      expect(response.status).toBe(204);
      expect(await failure).toContain("did not enter a value");
      expect(readSettingsFile(settingsPath).env).toBeUndefined();
    });
  });

  test("空の値は 400 で断り、待ちは残す", async () => {
    await withServer(async ({ request, envRequests }) => {
      const waiting = envRequests.wait("t1", "GITHUB_TOKEN", new AbortController().signal);

      const empty = await request(
        "/api/computer/env/answer",
        answerRequest("t1", { name: "GITHUB_TOKEN", kind: "value", value: "   " }),
      );
      expect(empty.status).toBe(400);
      expect(((await empty.json()) as { code: string }).code).toBe("invalid_request");

      const nul = await request(
        "/api/computer/env/answer",
        answerRequest("t1", { name: "GITHUB_TOKEN", kind: "value", value: "a\u0000b" }),
      );
      expect(nul.status).toBe(400);

      // 断っただけなので、正しい値なら通る。
      const accepted = await request(
        "/api/computer/env/answer",
        answerRequest("t1", { name: "GITHUB_TOKEN", kind: "value", value: "ghp_1" }),
      );
      expect(accepted.status).toBe(204);
      expect(await waiting).toContain("GITHUB_TOKEN");
    });
  });

  test("名前が違う返事は 409 で断り、待ちは残す", async () => {
    await withServer(async ({ request, envRequests }) => {
      const waiting = envRequests.wait("t1", "GITHUB_TOKEN", new AbortController().signal);

      const response = await request(
        "/api/computer/env/answer",
        answerRequest("t1", { name: "OTHER", kind: "value", value: "x" }),
      );
      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("env_request_not_pending");

      const accepted = await request(
        "/api/computer/env/answer",
        answerRequest("t1", { name: "GITHUB_TOKEN", kind: "value", value: "ghp_1" }),
      );
      expect(accepted.status).toBe(204);
      expect(await waiting).toContain("GITHUB_TOKEN");
    });
  });

  test("待っていない Tera への返事は 409", async () => {
    await withServer(async ({ request }) => {
      const response = await request(
        "/api/computer/env/answer",
        answerRequest("t1", { name: "GITHUB_TOKEN", kind: "value", value: "x" }),
      );

      expect(response.status).toBe(409);
      expect(((await response.json()) as { code: string }).code).toBe("env_request_not_pending");
    });
  });

  test("壊れた入力は 400 で断る", async () => {
    await withServer(async ({ request, envRequests }) => {
      const waiting = envRequests.wait("t1", "GITHUB_TOKEN", new AbortController().signal);

      const withoutTera = await request("/api/computer/env/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "GITHUB_TOKEN", kind: "value", value: "x" }),
      });
      expect(withoutTera.status).toBe(400);

      const badName = await request(
        "/api/computer/env/answer",
        answerRequest("t1", { name: "1BAD", kind: "value", value: "x" }),
      );
      expect(badName.status).toBe(400);

      const unknownKind = await request(
        "/api/computer/env/answer",
        answerRequest("t1", { name: "GITHUB_TOKEN", kind: "whatever" }),
      );
      expect(unknownKind.status).toBe(400);

      const missingValue = await request(
        "/api/computer/env/answer",
        answerRequest("t1", { name: "GITHUB_TOKEN", kind: "value" }),
      );
      expect(missingValue.status).toBe(400);

      // どれも受け付けていないので、待ちは残っている。
      expect(envRequests.answer("t1", { kind: "value", name: "GITHUB_TOKEN", value: "ghp_1" })).toBe(true);
      expect(await waiting).toContain("GITHUB_TOKEN");
    });
  });

  test("一覧は名前だけを名前順で返し、値は返さない", async () => {
    await withServer(async ({ request, settings }) => {
      settings.setEnv("ZED_TOKEN", "secret-z");
      settings.setEnv("ALPHA_TOKEN", "secret-a");

      const response = await request("/api/computer/env");
      expect(await readNames(response)).toEqual(["ALPHA_TOKEN", "ZED_TOKEN"]);

      const body = await request("/api/computer/env").then((res) => res.text());
      expect(body).not.toContain("secret-a");
      expect(body).not.toContain("secret-z");
    });
  });

  test("削除すると一覧から消え、次のコマンドから使えなくなる", async () => {
    await withServer(async ({ request, settings, settingsPath }) => {
      settings.setEnv("GITHUB_TOKEN", "ghp_1");
      settings.setEnv("NO_COLOR", "1");

      const response = await request("/api/computer/env/GITHUB_TOKEN", { method: "DELETE" });
      expect(await readNames(response)).toEqual(["NO_COLOR"]);
      expect(readSettingsFile(settingsPath).env).toEqual({ NO_COLOR: "1" });

      // もう無い名前でも、同じ結果を返す（画面は一覧を置き直せる）。
      const again = await request("/api/computer/env/GITHUB_TOKEN", { method: "DELETE" });
      expect(await readNames(again)).toEqual(["NO_COLOR"]);
    });
  });

  test("使えない名前の削除は 400", async () => {
    await withServer(async ({ request }) => {
      const response = await request("/api/computer/env/1BAD", { method: "DELETE" });

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("invalid_request");
    });
  });

  test("設定を書けないときは 500 で、待ちも失敗させる", async () => {
    // 置き場のディレクトリごと無い状態にして、保存だけが失敗する形にする。
    await withServer(
      async ({ request, envRequests }) => {
        const waiting = envRequests.wait("t1", "GITHUB_TOKEN", new AbortController().signal);
        // 失敗する待ちなので、返事を送る前に受け取る側を用意しておく。
        const failure = waiting.catch((error: unknown) => (error as Error).message);

        const response = await request(
          "/api/computer/env/answer",
          answerRequest("t1", { name: "GITHUB_TOKEN", kind: "value", value: "ghp_1" }),
        );

        expect(response.status).toBe(500);
        expect(((await response.json()) as { code: string }).code).toBe("settings_write_failed");
        expect(await failure).toContain("保存できませんでした");
      },
      { settings: null, configPath: (dir) => join(dir, "missing", CONFIG_FILE_NAME) },
    );
  });
});
