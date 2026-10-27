import { describe, expect, test } from "bun:test";
import { interpretEvent } from "../../src/client/state/chat-events";
import type { AttachmentPart, ChatMessage, NoticePart, TextPart } from "../../src/shared/api/message";

/**
 * SSE のイベントを、画面の状態に何をするかへ読み替える部分。
 * signal も DOM も使わないので、そのまま確かめられる。
 */

const message: ChatMessage = {
  id: "m1",
  teraId: "t1",
  seq: 2,
  role: "assistant",
  content: "",
  attachments: null,
  parts: [{ type: "text", text: "こんにちは", at: 1 }],
  origin: null,
  createdAt: 1,
  usage: null,
};

const text: TextPart = { type: "text", text: "こんにちは", at: 2 };
const attachment: AttachmentPart = {
  type: "attachment",
  attachments: [{ name: "図.png", size: 12, url: "/api/images/x.png", image: { width: 4, height: 3 } }],
  at: 3,
};
const notice: NoticePart = { type: "notice", text: "上限に達しました", at: 4 };

describe("チャットのイベントの読み替え", () => {
  test("メッセージはそのまま足す", () => {
    expect(interpretEvent({ type: "user-message", message })).toEqual({ kind: "message", message });
    expect(interpretEvent({ type: "assistant-done", message })).toEqual({ kind: "message", message });
  });

  test("ターンの開始は、届いているターンの入れ替えになる", () => {
    expect(interpretEvent({ type: "assistant-start", id: "a1", createdAt: 1, seq: 2 })).toEqual({
      kind: "assistant-start",
      id: "a1",
      createdAt: 1,
      seq: 2,
    });
  });

  test("本文・添付・注記は、届いた単位で足す", () => {
    expect(interpretEvent({ type: "assistant-message", id: "a1", part: text })).toEqual({
      kind: "assistant-part",
      id: "a1",
      part: text,
    });
    expect(interpretEvent({ type: "assistant-message", id: "a1", part: attachment })).toEqual({
      kind: "assistant-part",
      id: "a1",
      part: attachment,
    });
    expect(interpretEvent({ type: "notice", id: "a1", part: notice })).toEqual({
      kind: "assistant-part",
      id: "a1",
      part: notice,
    });
  });

  test("tool_call 越しの画面を渡す呼び出しだけ、引き受けの開始になる", () => {
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: {
          type: "tool-call",
          id: "c1",
          server: "tool",
          tool: "call",
          args: { name: "computer_ask_user", args: { question: "ログイン" } },
        },
      }),
    ).toEqual({ kind: "handover-start", callId: "c1", question: "ログイン" });

    // 頼みが空でも、引き受けは始まる（何を頼むかを書いていないだけ）。
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: { type: "tool-call", id: "c2", server: "tool", tool: "call", args: { name: "computer_ask_user" } },
      }),
    ).toEqual({ kind: "handover-start", callId: "c2", question: null });

    // tool_call 越しでも、ほかのツールは画面に出さない。
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: { type: "tool-call", id: "c3", server: "tool", tool: "call", args: { name: "computer_screenshot" } },
      }),
    ).toBeNull();

    // ツール検索も画面には出さない。
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: { type: "tool-call", id: "c4", server: "tool", tool: "search", args: { query: "computer" } },
      }),
    ).toBeNull();
  });

  test("tool_call 越しの環境変数の呼び出しは、入力欄を出す", () => {
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: {
          type: "tool-call",
          id: "c5",
          server: "tool",
          tool: "call",
          args: { name: "computer_set_env", args: { name: "GITHUB_TOKEN", description: "リポジトリを読むため" } },
        },
      }),
    ).toEqual({
      kind: "env-request-start",
      callId: "c5",
      name: "GITHUB_TOKEN",
      description: "リポジトリを読むため",
    });

    // 説明が無くても、名前があれば入力を出す（何に使うかは画面で補える）。
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: {
          type: "tool-call",
          id: "c6",
          server: "tool",
          tool: "call",
          args: { name: "computer_set_env", args: { name: "TOKEN" } },
        },
      }),
    ).toEqual({ kind: "env-request-start", callId: "c6", name: "TOKEN", description: null });

    // 変数名が無ければ、何を設定するのか画面に出せないので何もしない。
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: {
          type: "tool-call",
          id: "c7",
          server: "tool",
          tool: "call",
          args: { name: "computer_set_env", args: {} },
        },
      }),
    ).toBeNull();
  });

  test("tool_call 越しのアプリの接続ツールは、そのアプリのカードを出す", () => {
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: {
          type: "tool-call",
          id: "c8",
          server: "tool",
          tool: "call",
          args: { name: "app_connect_github", args: { reason: "issue を読むため" } },
        },
      }),
    ).toEqual({
      kind: "connector-request-start",
      callId: "c8",
      provider: "github",
      reason: "issue を読むため",
    });

    // 理由が無くても、ツール名だけでアプリが分かるのでカードを出す。
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: {
          type: "tool-call",
          id: "c9",
          server: "tool",
          tool: "call",
          args: { name: "app_connect_github", args: {} },
        },
      }),
    ).toEqual({ kind: "connector-request-start", callId: "c9", provider: "github", reason: null });

    // 接続ツールでなければ、アプリが分からないので何もしない。
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: {
          type: "tool-call",
          id: "c10",
          server: "tool",
          tool: "call",
          args: { name: "app_request", args: { provider: "github", method: "GET", path: "/user" } },
        },
      }),
    ).toBeNull();
  });

  test("tool_call 越しの discord_connect は、Discord のコネクタカードを出す", () => {
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: {
          type: "tool-call",
          id: "c11",
          server: "tool",
          tool: "call",
          args: { name: "discord_connect", args: { reason: "通知を送るため" } },
        },
      }),
    ).toEqual({
      kind: "connector-request-start",
      callId: "c11",
      provider: "discord",
      reason: "通知を送るため",
    });

    // 理由が無くても、ツール名だけで Discord と分かる。
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: {
          type: "tool-call",
          id: "c12",
          server: "tool",
          tool: "call",
          args: { name: "discord_connect", args: {} },
        },
      }),
    ).toEqual({ kind: "connector-request-start", callId: "c12", provider: "discord", reason: null });
  });

  test("待ちの結果は、どの呼び出しの結果かだけを伝える", () => {
    const part = {
      type: "tool-result" as const,
      id: "c1",
      server: "tool",
      tool: "call",
      failed: false,
      output: "[computer_ask_user]\ndone",
    };

    // 成功した結果。待ちを終えるかどうかは、chat.ts が id で判定する。
    expect(interpretEvent({ type: "tool-result", id: "a1", part })).toEqual({
      kind: "tool-result",
      callId: "c1",
      failed: false,
    });

    // 取り消された環境変数の入力も、待ちを終える材料として流す。
    expect(interpretEvent({ type: "tool-result", id: "a1", part: { ...part, failed: true } })).toEqual({
      kind: "tool-result",
      callId: "c1",
      failed: true,
    });
  });

  test("tool_call 越しの tera_create は、一覧を読み直すきっかけになる", () => {
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: {
          type: "tool-call",
          id: "c13",
          server: "tool",
          tool: "call",
          args: { name: "tera_create", args: { id: "researcher", name: "調べる係" } },
        },
      }),
    ).toEqual({ kind: "tera-create-call", callId: "c13" });

    // ほかのツールの呼び出しでは、一覧を読み直さない。
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: { type: "tool-call", id: "c14", server: "tool", tool: "call", args: { name: "computer_screenshot" } },
      }),
    ).toBeNull();
  });

  test("chat_ui の呼び出しは、カードを置く効果になる", () => {
    const part = {
      type: "tool-call" as const,
      id: "c1",
      server: "chat",
      tool: "ui",
      args: { markup: "<Card><Text>選んでください</Text></Card>" },
    };

    // 引数（マークアップ）は解釈せず、そのまま渡す。解釈は画面側で 1 度だけ行う。
    expect(interpretEvent({ type: "tool-call", id: "a1", part })).toEqual({ kind: "chat-ui", id: "a1", part });

    // ほかのツール呼び出しはカードにしない。
    expect(
      interpretEvent({
        type: "tool-call",
        id: "a1",
        part: { type: "tool-call", id: "c2", server: "chat", tool: "attach", args: { screenshot: true } },
      }),
    ).toBeNull();
  });

  test("失敗はコードと詳細を運ぶ", () => {
    expect(interpretEvent({ type: "error", code: "model_error", detail: "失敗" })).toEqual({
      kind: "error",
      code: "model_error",
      detail: "失敗",
    });
  });
});
