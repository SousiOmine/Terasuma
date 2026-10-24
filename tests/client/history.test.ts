import { describe, expect, test } from "bun:test";
import { mergeLatestPage, mergeSaved, newestSavedSeq, UNSAVED_SEQ } from "../../src/client/state/history";
import type { ChatMessageView, MessagePage } from "../../src/shared/api/message";

/** 保存済みの発言。 */
function saved(id: string, seq: number): ChatMessageView {
  return {
    id,
    teraId: "t1",
    seq,
    role: "user",
    content: id,
    attachments: null,
    parts: null,
    origin: null,
    createdAt: seq,
  };
}

/** 連番が分からないまま置いておく発言（送信の応答が途中で切れたとき）。 */
function unsaved(id: string): ChatMessageView {
  return {
    id,
    teraId: "t1",
    seq: UNSAVED_SEQ,
    role: "assistant",
    content: "",
    attachments: null,
    parts: [],
    origin: null,
    createdAt: 99,
  };
}

function ids(messages: readonly ChatMessageView[]): string[] {
  return messages.map((message) => message.id);
}

describe("履歴の重ね合わせ", () => {
  test("新しい発言は、末尾ではなく seq の位置へ入る", () => {
    const merged = mergeSaved([saved("a", 1), saved("c", 3)], [saved("b", 2)]);

    expect(ids(merged)).toEqual(["a", "b", "c"]);
  });

  test("古いページを読み足しても、並びは保たれる", () => {
    const merged = mergeSaved([saved("c", 3), saved("d", 4)], [saved("a", 1), saved("b", 2)]);

    expect(ids(merged)).toEqual(["a", "b", "c", "d"]);
  });

  test("同じ id は、あとから来た内容で置き換える", () => {
    const before = saved("a", 1);
    const after: ChatMessageView = { ...before, content: "直した内容", attachments: [{ name: "添付", size: 1 }] };

    const merged = mergeSaved([before], [after]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.content).toBe("直した内容");
  });

  test("仮置き（seq 0）は、保存された発言へ置き換わり、位置も seq の場所へ移る", () => {
    // 送信の応答が切れたため、assistant の発言を seq 0 で末尾に置いていた。
    const placeholder = unsaved("a2");
    const current = [saved("u1", 1), placeholder];

    // 読み直したら、保存された同じ id の発言が出てきた。
    const merged = mergeSaved(current, [saved("a2", 2)]);
    expect(ids(merged)).toEqual(["u1", "a2"]);
    expect(merged[1]?.seq).toBe(2);
  });

  test("置き換わらない仮置きは、末尾に残る", () => {
    const merged = mergeSaved([saved("u1", 1)], [unsaved("a2")]);

    expect(ids(merged)).toEqual(["u1", "a2"]);
  });

  test("最新の seq は、仮置き（seq 0）を数えない", () => {
    expect(newestSavedSeq([saved("u1", 1), unsaved("a2")])).toBe(1);
    expect(newestSavedSeq([])).toBe(0);
    expect(newestSavedSeq([unsaved("a2")])).toBe(0);
  });
});

/** 最新のページ。 */
function page(messages: ChatMessageView[], hasMore = true): MessagePage {
  return { messages, hasMore };
}

describe("最新のページの重ね合わせ", () => {
  test("足りない分が 1 ページに収まれば、持っている履歴へ重ねる", () => {
    const merged = mergeLatestPage([saved("a", 1), saved("b", 2)], page([saved("c", 3), saved("d", 4)]));

    expect(ids(merged.messages)).toEqual(["a", "b", "c", "d"]);
    expect(merged.resetOlder).toBe(false);
  });

  test("同じ発言が重ならなければ、重なった分は置き換える", () => {
    const merged = mergeLatestPage([saved("a", 1), saved("b", 2)], page([saved("b", 2), saved("c", 3)]));

    expect(ids(merged.messages)).toEqual(["a", "b", "c"]);
  });

  test("欠けが 1 ページに収まらないときは、履歴を捨てて最新から読み直す", () => {
    // 手元は 1 件だけ。向こうでは 3 件増えていて、最新の 2 件では届かない。
    const merged = mergeLatestPage([saved("a", 1)], page([saved("d", 4), saved("e", 5)]));

    expect(ids(merged.messages)).toEqual(["d", "e"]);
    expect(merged.resetOlder).toBe(true);
  });

  test("何も持っていなかったときは、古い側の情報も最新のページから作る", () => {
    const merged = mergeLatestPage([], page([saved("a", 1)], false));

    expect(ids(merged.messages)).toEqual(["a"]);
    expect(merged.resetOlder).toBe(true);
  });
});
