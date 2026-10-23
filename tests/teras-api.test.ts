import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createMockEngine } from "../src/server/agent/engine/mock";
import { teraWorkspaceDir } from "../src/server/computer/workspaces";
import { DEFAULT_TERA_ID, DEFAULT_TERA_IDENTITY } from "../src/server/data/store";
import { parseCatalog, type Catalog } from "../src/server/provider/catalog";
import type { Tera } from "../src/shared/api/message";
import { CLIENT_HEADER } from "../src/shared/api/events";
import { withServer } from "./harness";
import { TEST_CLIENT } from "./support";

/**
 * Tera の削除。行（履歴・identity・要約は連鎖）と、Discord の webhook と、
 * 作業フォルダが 1 回の DELETE で消えること、最後の 1 体では既定を作り直すことを確かめる。
 */

/** テスト用のカタログ。TEST_SETTINGS の deepseek を解決できるようにする。 */
function testCatalog(): Catalog {
  const snapshot = parseCatalog(
    {
      deepseek: {
        id: "deepseek",
        name: "DeepSeek",
        npm: "@ai-sdk/openai-compatible",
        api: "https://api.deepseek.com",
        models: { "deepseek-flash": { id: "deepseek-flash", name: "DeepSeek Flash" } },
      },
    },
    1_000,
  );
  return { snapshot: () => snapshot, load: async () => snapshot };
}

/** 送信の本文。生成中のターンを作るのに使う。 */
function messageRequest(content: string): RequestInit {
  const form = new FormData();
  form.append("content", content);
  form.append("language", "ja");
  return { method: "POST", body: form, headers: { [CLIENT_HEADER]: TEST_CLIENT } };
}

/** DELETE の応答を、Tera の一覧として読む。 */
async function terasOf(response: Response): Promise<Tera[]> {
  const body = (await response.json()) as { teras: Tera[] };
  return body.teras;
}

describe("DELETE /api/teras/:id", () => {
  test("Tera を消し、消したあとの一覧を返す", async () => {
    await withServer(async (harness) => {
      harness.store.createTera({ id: "researcher", name: "調べる係", identity: "# Role\n調べる" });
      harness.store.appendMessage({ id: "m1", teraId: "researcher", role: "user", content: "消える本文" });

      const response = await harness.request("/api/teras/researcher", { method: "DELETE" });
      expect(response.status).toBe(200);

      expect((await terasOf(response)).map((tera) => tera.id)).toEqual([DEFAULT_TERA_ID]);
      expect(harness.store.getTera("researcher")).toBeNull();
      expect(harness.store.listMessagesSince("researcher", 0)).toEqual([]);

      // 消えた Tera の履歴は読めない。
      const messages = await harness.request("/api/teras/researcher/messages?limit=1");
      expect(messages.status).toBe(404);
    });
  });

  test("作業フォルダと Discord の webhook も消す", async () => {
    await withServer(async (harness) => {
      harness.store.createTera({ id: "researcher", name: "調べる係", identity: "# Role\n調べる" });

      const workspace = teraWorkspaceDir(harness.dir, "researcher");
      mkdirSync(join(workspace, "uploads"), { recursive: true });
      writeFileSync(join(workspace, "uploads", "a.txt"), "消える");

      const webhook = join(harness.dir, "discord", "researcher.json");
      mkdirSync(join(harness.dir, "discord"), { recursive: true });
      writeFileSync(webhook, "{}");

      const response = await harness.request("/api/teras/researcher", { method: "DELETE" });
      expect(response.status).toBe(200);

      expect(existsSync(workspace)).toBe(false);
      expect(existsSync(webhook)).toBe(false);
    });
  });

  test("最後の 1 体を消すと、既定の Tera を作り直して作業フォルダも用意する", async () => {
    await withServer(async (harness) => {
      const response = await harness.request(`/api/teras/${DEFAULT_TERA_ID}`, { method: "DELETE" });
      expect(response.status).toBe(200);

      const teras = await terasOf(response);
      expect(teras).toHaveLength(1);
      expect(teras[0]?.id).toBe(DEFAULT_TERA_ID);
      expect(teras[0]?.name).toBe("Tera");
      expect(harness.store.readIdentity(DEFAULT_TERA_ID)).toEqual({
        content: DEFAULT_TERA_IDENTITY,
        applied: DEFAULT_TERA_IDENTITY,
      });
      expect(existsSync(teraWorkspaceDir(harness.dir, DEFAULT_TERA_ID))).toBe(true);
    });
  });

  test("無い Tera は 404", async () => {
    await withServer(async (harness) => {
      const response = await harness.request("/api/teras/missing", { method: "DELETE" });
      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("tera_not_found");
    });
  });

  test("応答を生成している間は 409 で断り、Tera を消さない", async () => {
    // ゆっくり考えさせ、生成中のまま削除を送れるようにする。
    await withServer(
      async (harness) => {
        const sending = await harness.request(`/api/teras/${DEFAULT_TERA_ID}/messages`, messageRequest("こんにちは"));
        expect(sending.status).toBe(200);

        const response = await harness.request(`/api/teras/${DEFAULT_TERA_ID}`, { method: "DELETE" });
        expect(response.status).toBe(409);
        expect(((await response.json()) as { code: string }).code).toBe("turn_in_progress");
        expect(harness.store.getTera(DEFAULT_TERA_ID)).not.toBeNull();

        // ターンを止めて読み切れば、消せる。
        await harness.request(`/api/teras/${DEFAULT_TERA_ID}/stop`, { method: "POST" });
        await sending.text();

        const after = await harness.request(`/api/teras/${DEFAULT_TERA_ID}`, { method: "DELETE" });
        expect(after.status).toBe(200);
      },
      { engine: createMockEngine({ chunkSize: 1, delayMs: 5 }), catalog: testCatalog() },
    );
  });
});
