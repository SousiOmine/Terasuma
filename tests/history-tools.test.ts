import { describe, expect, test } from "bun:test";
import type { ToolSet } from "ai";
import { MAX_HISTORY_LIMIT, DEFAULT_HISTORY_LIMIT, createHistoryTools } from "../src/server/agent/tools/history";
import { createStore, DEFAULT_TERA_ID, type Store } from "../src/server/data/store";
import { HISTORY_SEARCH_TOOL_NAME } from "../src/shared/tools";
import type { ChatAttachment, MessagePart } from "../src/shared/api/message";

/**
 * history_search ツールの確認。
 * モデルを介さずにツールをそのまま呼び、どのメッセージが、どんな形で返るかを確かめる。
 */

/** 時刻を差し替えられるストア。日付の境界を作るために使う。 */
function createClockStore(): { store: Store; at: (time: number) => void } {
  let clock = new Date(2026, 9, 1, 9, 0).getTime();
  const store = createStore(":memory:", { now: () => clock });
  return {
    store,
    at: (time) => {
      clock = time;
    },
  };
}

/** 2026 年 10 月の、その日のローカル時刻。 */
function localTime(day: number, hour = 9, minute = 0): number {
  return new Date(2026, 9, day, hour, minute).getTime();
}

/** ユーザーの発言を 1 件足す。 */
function appendUser(store: Store, id: string, content: string, attachments: ChatAttachment[] | null = null): void {
  store.appendMessage({
    id,
    teraId: DEFAULT_TERA_ID,
    role: "user",
    content,
    ...(attachments === null ? {} : { attachments }),
  });
}

/** assistant の発言を 1 件足す。 */
function appendAssistant(store: Store, id: string, parts: MessagePart[]): void {
  store.appendMessage({ id, teraId: DEFAULT_TERA_ID, role: "assistant", content: "", parts });
}

/** ツールをモデルを介さずにそのまま呼ぶ。 */
async function search(store: Store, input: unknown): Promise<string> {
  const tools: ToolSet = createHistoryTools({ store, teraId: DEFAULT_TERA_ID });
  const tool = tools[HISTORY_SEARCH_TOOL_NAME];
  if (tool?.execute === undefined) throw new Error("history_search が無い");
  return (await tool.execute(input as never, {} as never)) as string;
}

describe("history_search", () => {
  test("ユーザーと assistant の本文に当たり、複数の語はすべて含むものだけを返す", async () => {
    const { store } = createClockStore();
    appendUser(store, "m1", "Deploy the release notes");
    appendAssistant(store, "m2", [{ type: "text", text: "リリースのメモを更新しました。", at: localTime(1) }]);

    // 大文字小文字は区別しない。
    const both = await search(store, { query: "DEPLOY notes" });
    expect(both).toContain("Deploy the release notes");
    expect(both).not.toContain("リリースのメモを更新しました。");

    // 日本語は部分一致で当たる。
    const japanese = await search(store, { query: "メモ" });
    expect(japanese).toContain("リリースのメモを更新しました。");
    expect(japanese).not.toContain("Deploy the release notes");
  });

  test("検索語は JavaScript の正規表現として扱う", async () => {
    const { store } = createClockStore();
    appendUser(store, "m1", "デプロイ手順をまとめた");
    appendUser(store, "m2", "リリースの手順をまとめた");
    appendUser(store, "m3", "2026-10-21 に決めた");
    appendUser(store, "m4", "今日は晴れ");

    const alternatives = await search(store, { query: "デプロイ.*手順|リリース.*手順" });
    expect(alternatives).toContain("デプロイ手順をまとめた");
    expect(alternatives).toContain("リリースの手順をまとめた");
    expect(alternatives).not.toContain("今日は晴れ");

    const digits = await search(store, { query: "\\d{4}-\\d{2}-\\d{2}" });
    expect(digits).toContain("2026-10-21 に決めた");
    expect(digits).not.toContain("今日は晴れ");
  });

  test("壊れた正規表現は、直し方の分かる理由で失敗する", async () => {
    const { store } = createClockStore();

    await expect(search(store, { query: "C++" })).rejects.toThrow("not a valid regular expression");
    await expect(search(store, { query: "C++" })).rejects.toThrow("Escape metacharacters");
  });

  test("wholeWord は語の境界でだけ当たる（grep -w）", async () => {
    const { store } = createClockStore();
    appendUser(store, "m1", "a cat sat here");
    appendUser(store, "m2", "concatenate");
    appendUser(store, "m3", "メモ を更新");
    appendUser(store, "m4", "メモを更新");

    const loose = await search(store, { query: "cat" });
    expect(loose).toContain("concatenate");

    const whole = await search(store, { query: "cat", wholeWord: true });
    expect(whole).toContain("(whole words only)");
    expect(whole).toContain("a cat sat here");
    expect(whole).not.toContain("concatenate");

    // 日本語は文字が続いていれば語の途中として扱う（grep と同じ）。
    const japanese = await search(store, { query: "メモ", wholeWord: true });
    expect(japanese).toContain("メモ を更新");
    expect(japanese).not.toContain("メモを更新");
  });

  test("invert は当たらないメッセージを返す（grep -v）", async () => {
    const { store } = createClockStore();
    appendUser(store, "m1", "秘密の計画");
    appendUser(store, "m2", "ふつうの話");

    const text = await search(store, { query: "秘密", invert: true });
    expect(text).toContain('not matching "秘密"');
    expect(text).toContain("ふつうの話");
    expect(text).not.toContain("秘密の計画");
  });

  test("invert はクエリが無いと失敗する", async () => {
    const { store } = createClockStore();
    await expect(search(store, { invert: true })).rejects.toThrow("invert needs a query");
  });

  test("期間で絞れる（指定した日の 0 時から、終わりの日の翌日 0 時まで）", async () => {
    const { store, at } = createClockStore();

    at(localTime(1, 23, 59));
    appendUser(store, "m1", "前日の夜");
    at(localTime(2, 0, 0));
    appendUser(store, "m2", "初日の 0 時");
    at(localTime(3, 23, 59));
    appendUser(store, "m3", "最終日の 23:59");
    at(localTime(4, 0, 0));
    appendUser(store, "m4", "翌日の 0 時");

    const text = await search(store, { from: "2026-10-02", to: "2026-10-03" });
    expect(text).toContain("初日の 0 時");
    expect(text).toContain("最終日の 23:59");
    expect(text).not.toContain("前日の夜");
    expect(text).not.toContain("翌日の 0 時");
    // 期間は見出しに出る。
    expect(text).toContain("from 2026-10-02 to 2026-10-03 (local time)");
  });

  test("件数を指定すると、新しい方からその件数を返す", async () => {
    const { store, at } = createClockStore();
    for (let index = 1; index <= 5; index += 1) {
      at(localTime(1, 9, index));
      appendUser(store, `m${index}`, `メッセージ ${index}`);
    }

    const text = await search(store, { query: "メッセージ", limit: 2 });
    expect(text).toContain("Found 5 message(s)");
    expect(text).toContain("Showing the newest 2");
    expect(text).toContain("メッセージ 4");
    expect(text).toContain("メッセージ 5");
    expect(text).not.toContain("メッセージ 3");

    // 選んだ 2 件は古い順に並ぶ（会話として読めるように）。
    expect(text.indexOf("メッセージ 4")).toBeLessThan(text.indexOf("メッセージ 5"));
  });

  test("件数を省くと既定の件数だけ返す", async () => {
    const { store, at } = createClockStore();
    for (let index = 1; index <= DEFAULT_HISTORY_LIMIT + 2; index += 1) {
      at(localTime(1, 9, index));
      appendUser(store, `m${index}`, `履歴 ${index}`);
    }

    const text = await search(store, { query: "履歴" });
    expect(text).toContain(`Found ${DEFAULT_HISTORY_LIMIT + 2} message(s)`);
    expect(text).toContain(`Showing the newest ${DEFAULT_HISTORY_LIMIT}`);
  });

  test("上限を超える件数は上限に丸める", async () => {
    const { store, at } = createClockStore();
    for (let index = 1; index <= MAX_HISTORY_LIMIT + 2; index += 1) {
      at(localTime(1, 9, index));
      appendUser(store, `m${index}`, `上限 ${String(index).padStart(3, "0")}`);
    }

    const text = await search(store, { query: "上限", limit: 10_000 });
    expect(text).toContain(`Found ${MAX_HISTORY_LIMIT + 2} message(s)`);
    expect(text).toContain(`Showing the newest ${MAX_HISTORY_LIMIT}`);

    // 新しい方から上限まで。古い 2 件は落ちる。
    expect(text).toContain("上限 102");
    expect(text).toContain("上限 003");
    expect(text).not.toContain("上限 002");
    expect(text).not.toContain("上限 001");
  });

  test("ツール呼び出しは名前だけを載せ、引数と結果は載せない", async () => {
    const { store } = createClockStore();
    appendUser(store, "m1", "調べて");
    appendAssistant(store, "m2", [
      { type: "text", text: "調べました。", at: 1 },
      { type: "tool-call", id: "call-1", server: "", tool: "read", args: { path: "/secret/path" } },
      { type: "tool-result", id: "call-1", server: "", tool: "read", failed: false, output: "秘密の出力" },
      {
        type: "tool-call",
        id: "call-2",
        server: "tool",
        tool: "call",
        args: { name: "computer_screenshot", args: {} },
      },
      {
        type: "tool-result",
        id: "call-2",
        server: "tool",
        tool: "call",
        failed: false,
        output: "[computer_screenshot]\n画面",
      },
      // 同じツールを 2 回呼んでも、名前は 1 回だけ並べる。
      { type: "tool-call", id: "call-3", server: "", tool: "read", args: { path: "again" } },
    ]);

    const text = await search(store, { query: "調べました" });
    // tool_call は入口なので、実際に動いたツールの名前に開く。
    expect(text).toContain("(tool calls: read, computer_screenshot)");
    expect(text).not.toContain("/secret/path");
    expect(text).not.toContain("秘密の出力");
    expect(text).not.toContain("again");
  });

  test("当たらなければ、期間内の件数とヒントを返す", async () => {
    const { store, at } = createClockStore();
    at(localTime(2));
    appendUser(store, "m1", "りんご");
    at(localTime(3));
    appendUser(store, "m2", "みかん");

    const text = await search(store, { query: "ぶどう", from: "2026-10-01", to: "2026-10-31" });
    expect(text).toContain('No message matching "ぶどう"');
    expect(text).toContain("2 message(s) exist");
    expect(text).toContain("Try fewer words");
  });

  test("日付の形式と実在しない日は、読める理由で失敗する", async () => {
    const { store } = createClockStore();

    await expect(search(store, { from: "2026/10/01" })).rejects.toThrow("YYYY-MM-DD");
    await expect(search(store, { from: "2026-02-30" })).rejects.toThrow("real date");
    await expect(search(store, { from: "2026-10-05", to: "2026-10-01" })).rejects.toThrow("is after");
  });

  test("本文が無い発言も、添付名から引ける", async () => {
    const { store } = createClockStore();
    appendUser(store, "m1", "", [{ name: "報告書.pdf", size: 10, path: "/home/agent/uploads/x/01-報告書.pdf" }]);

    const text = await search(store, { query: "報告書" });
    expect(text).toContain("(attached: 報告書.pdf)");
  });

  test("長い本文は切って、切ったことを書く", async () => {
    const { store } = createClockStore();
    appendUser(store, "m1", "あ".repeat(2_000));

    const text = await search(store, {});
    expect(text).toContain("more characters");
    expect(text.length).toBeLessThan(2_000);
  });

  test("履歴が空なら、そのことを返す", async () => {
    const { store } = createClockStore();
    expect(await search(store, {})).toContain("No messages have been saved");
  });
});
