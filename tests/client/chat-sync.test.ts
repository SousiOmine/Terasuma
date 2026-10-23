import { describe, expect, test } from "bun:test";
import type { AgentEngine, EngineEvent } from "../../src/server/agent/engine";
import { DEFAULT_TERA_ID } from "../../src/server/data/store";
import { parseCatalog, type Catalog } from "../../src/server/provider/catalog";
import { CLIENT_HEADER } from "../../src/shared/api/events";
import { type ServerHarness, withServer } from "../harness";

/**
 * 画面の側から見た同期。実際のサーバを起こし、別の画面（id の違う要求）で始まったターンが、
 * 開いている画面の状態（messages / liveTurn / isStreaming）へどう反映されるかを確かめる。
 *
 * ブラウザの代わりに、画面の fetch（相対 URL）を、起こしたサーバへ向ける。
 */

const TERA = DEFAULT_TERA_ID;

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

/** 画面の fetch を、起こしたサーバへ向ける。戻り値で元に戻す。 */
function pointFetchAt(url: string): () => void {
  const original = globalThis.fetch;

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    original(new URL(String(input), url), init)) as typeof fetch;

  return () => {
    globalThis.fetch = original;
  };
}

/** モデルの応答を待たせ、ターンの途中の状態を作るエンジン。 */
function gatedEngine(): AgentEngine & { started: Promise<void>; release(): void } {
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  let markStarted: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  return {
    name: "gated",
    started,
    release,
    async stream({ signal, takeSteering }) {
      markStarted();
      await Promise.race([
        released,
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);

      // 待っている間に届いた割り込みは、この呼び出しで文脈へ入れる。
      takeSteering();

      return {
        events: (async function* (): AsyncGenerator<EngineEvent> {
          if (signal.aborted) return;
          yield { type: "text-delta", delta: "こんにちは" };
        })(),
        usage: Promise.resolve({ inputTokens: 3, outputTokens: 5, cachedInputTokens: 0 }),
      };
    },
    complete() {
      return Promise.resolve("");
    },
  };
}

/** 別の画面からの送信。応答（SSE）は読み切って、ターンを終わらせる。 */
async function sendFromOtherDevice(harness: ServerHarness, content: string): Promise<Response> {
  const form = new FormData();
  form.append("content", content);
  form.append("language", "ja");

  const response = await harness.request(`/api/teras/${TERA}/messages`, {
    method: "POST",
    body: form,
    headers: { [CLIENT_HEADER]: "other-device" },
  });
  if (response.status !== 200) throw new Error(`別の画面からの送信が失敗しました: ${response.status}`);
  return response;
}

/** 別の画面からの割り込み。 */
async function steerFromOtherDevice(harness: ServerHarness, content: string): Promise<void> {
  const form = new FormData();
  form.append("content", content);

  const response = await harness.request(`/api/teras/${TERA}/steer`, {
    method: "POST",
    body: form,
    headers: { [CLIENT_HEADER]: "third-device" },
  });
  expect(response.status).toBe(200);
}

/** 状態が変わるまで待つ。 */
async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!check()) {
    if (Date.now() > deadline) throw new Error("待っても状態が変わりませんでした");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 保存された発言の本文をつなぐ。 */
function textOf(parts: readonly { type: string; text?: string }[] | null): string {
  if (parts === null) return "";
  return parts.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("画面から見た同期", () => {
  test("別の画面で送られた発言と応答が、購読から履歴へ入る", async () => {
    await withServer(
      async (harness) => {
        const restore = pointFetchAt(harness.url);
        try {
          const chat = await import("../../src/client/state/chat");
          await chat.openTera(TERA);
          expect(chat.messages.value).toEqual([]);

          const sending = await sendFromOtherDevice(harness, "こんにちは");
          await sending.text();

          await waitFor(() => chat.messages.value.length === 2);
          expect(chat.messages.value[0]).toMatchObject({ role: "user", content: "こんにちは" });
          expect(chat.messages.value[1]).toMatchObject({ role: "assistant" });
          expect(textOf(chat.messages.value[1]?.parts ?? null)).not.toBe("");
          expect(chat.isStreaming.value).toBe(false);
        } finally {
          restore();
        }
      },
      { catalog: testCatalog() },
    );
  });

  test("走っているターンは、途中の内容も応答中の表示も届く", async () => {
    const engine = gatedEngine();
    await withServer(
      async (harness) => {
        const restore = pointFetchAt(harness.url);
        try {
          const chat = await import("../../src/client/state/chat");
          await chat.openTera(TERA);

          const sending = sendFromOtherDevice(harness, "こんにちは");
          await engine.started;

          // 送った画面ではなくても、応答中であることが分かる。
          await waitFor(() => chat.isStreaming.value);
          await waitFor(() => chat.liveTurn.value !== null);

          engine.release();
          await (await sending).text();

          await waitFor(() => !chat.isStreaming.value);
          await waitFor(() => chat.messages.value.length === 2);
          expect(chat.liveTurn.value).toBeNull();
          expect(textOf(chat.messages.value[1]?.parts ?? null)).toBe("こんにちは");
        } finally {
          restore();
        }
      },
      { engine, catalog: testCatalog() },
    );
  }, 10_000);

  test("応答中の割り込みも、ほかの画面に発言として届く", async () => {
    const engine = gatedEngine();
    await withServer(
      async (harness) => {
        const restore = pointFetchAt(harness.url);
        try {
          const chat = await import("../../src/client/state/chat");
          await chat.openTera(TERA);

          const sending = sendFromOtherDevice(harness, "こんにちは");
          await engine.started;
          await waitFor(() => chat.messages.value.length === 1);

          await steerFromOtherDevice(harness, "あとから足す");
          await waitFor(() => chat.messages.value.length === 2);
          expect(chat.messages.value[1]).toMatchObject({ role: "user", content: "あとから足す" });

          engine.release();
          await (await sending).text();
          await waitFor(() => chat.messages.value.length === 3);
        } finally {
          restore();
        }
      },
      { engine, catalog: testCatalog() },
    );
  }, 10_000);
});
