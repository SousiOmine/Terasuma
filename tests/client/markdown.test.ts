import { describe, expect, test } from "bun:test";
import { parseMarkdown } from "../../src/client/features/chat/markdown-parse";

/**
 * 発言の Markdown の解釈。
 * 画面には描かず、木だけを確かめる（DOM を使わないので、そのまま走る）。
 */

describe("段落と改行", () => {
  test("空行で段落を分け、改行は break にする", () => {
    expect(parseMarkdown("こんにちは\n世界\n\n次の段落")).toEqual([
      {
        type: "paragraph",
        children: [{ type: "text", text: "こんにちは" }, { type: "break" }, { type: "text", text: "世界" }],
      },
      { type: "paragraph", children: [{ type: "text", text: "次の段落" }] },
    ]);
  });

  test("CRLF も同じように読む", () => {
    expect(parseMarkdown("a\r\nb")).toEqual([
      {
        type: "paragraph",
        children: [{ type: "text", text: "a" }, { type: "break" }, { type: "text", text: "b" }],
      },
    ]);
  });
});

describe("見出し", () => {
  test("レベルごとに分ける", () => {
    expect(parseMarkdown("# 見出し\n\n### 三")).toEqual([
      { type: "heading", level: 1, children: [{ type: "text", text: "見出し" }] },
      { type: "heading", level: 3, children: [{ type: "text", text: "三" }] },
    ]);
  });

  test("末尾の # は落とす", () => {
    expect(parseMarkdown("## 題 ##")).toEqual([
      { type: "heading", level: 2, children: [{ type: "text", text: "題" }] },
    ]);
  });
});

describe("行の中の書き方", () => {
  test("太字・斜体・コード・取り消し線", () => {
    expect(parseMarkdown("**太字** と *斜体* と `code` と ~~消す~~")).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "strong", children: [{ type: "text", text: "太字" }] },
          { type: "text", text: " と " },
          { type: "em", children: [{ type: "text", text: "斜体" }] },
          { type: "text", text: " と " },
          { type: "code", text: "code" },
          { type: "text", text: " と " },
          { type: "strike", children: [{ type: "text", text: "消す" }] },
        ],
      },
    ]);
  });

  test("太字の中の斜体も読む", () => {
    expect(parseMarkdown("**a *b* c**")).toEqual([
      {
        type: "paragraph",
        children: [
          {
            type: "strong",
            children: [
              { type: "text", text: "a " },
              { type: "em", children: [{ type: "text", text: "b" }] },
              { type: "text", text: " c" },
            ],
          },
        ],
      },
    ]);
  });

  test("語の中の _ は斜体にしない", () => {
    expect(parseMarkdown("foo_bar_baz")).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "foo_bar_baz" }] },
    ]);
  });

  test("記号のまわりの空白は式として残す", () => {
    expect(parseMarkdown("2 * 3 * 4")).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "2 * 3 * 4" }] },
    ]);
  });

  test("\\ で記号を打ち消せる", () => {
    expect(parseMarkdown("\\*そのまま\\*")).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "*そのまま*" }] },
    ]);
  });
});

describe("リンク", () => {
  test("表示名つきのリンクと autolink", () => {
    expect(parseMarkdown("[Terasuma](https://example.com) と <https://example.org>")).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "link", href: "https://example.com", children: [{ type: "text", text: "Terasuma" }] },
          { type: "text", text: " と " },
          { type: "link", href: "https://example.org", children: [{ type: "text", text: "https://example.org" }] },
        ],
      },
    ]);
  });

  test("本文の URL をリンクにする", () => {
    expect(parseMarkdown("詳しくは https://example.com/a. を見て")).toEqual([
      {
        type: "paragraph",
        children: [
          { type: "text", text: "詳しくは " },
          { type: "link", href: "https://example.com/a", children: [{ type: "text", text: "https://example.com/a" }] },
          { type: "text", text: ". を見て" },
        ],
      },
    ]);
  });

  test("危険な URL はリンクにせず文字として残す", () => {
    expect(parseMarkdown("[危険](javascript:alert(1))")).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "[危険](javascript:alert(1))" }] },
    ]);
  });

  test("画像は読み込まず、リンクとして出す", () => {
    expect(parseMarkdown("![図](https://example.com/a.png)")).toEqual([
      {
        type: "paragraph",
        children: [
          {
            type: "link",
            href: "https://example.com/a.png",
            children: [{ type: "text", text: "図" }],
          },
        ],
      },
    ]);
  });
});

describe("コードブロック", () => {
  test("言語名を落とし、中身はそのまま読む", () => {
    expect(parseMarkdown("```ts\nconst a = 1;\n**not bold**\n```")).toEqual([
      { type: "code", text: "const a = 1;\n**not bold**" },
    ]);
  });

  test("閉じていなくても、末尾までをコードにする", () => {
    expect(parseMarkdown("```\nabc")).toEqual([{ type: "code", text: "abc" }]);
  });
});

describe("一覧", () => {
  test("入れ子の一覧", () => {
    expect(parseMarkdown("- ひとつ\n- ふたつ\n  - 入れ子")).toEqual([
      {
        type: "list",
        ordered: false,
        start: 1,
        items: [
          {
            checked: null,
            blocks: [{ type: "paragraph", children: [{ type: "text", text: "ひとつ" }] }],
          },
          {
            checked: null,
            blocks: [
              { type: "paragraph", children: [{ type: "text", text: "ふたつ" }] },
              {
                type: "list",
                ordered: false,
                start: 1,
                items: [
                  {
                    checked: null,
                    blocks: [{ type: "paragraph", children: [{ type: "text", text: "入れ子" }] }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  test("番号つきの一覧は、最初の番号から始める", () => {
    const block = parseMarkdown("3. 三\n4. 四")[0];
    expect(block).toMatchObject({ type: "list", ordered: true, start: 3 });
  });

  test("タスクリストの印を読む", () => {
    expect(parseMarkdown("- [x] 済み\n- [ ] 未了")).toEqual([
      {
        type: "list",
        ordered: false,
        start: 1,
        items: [
          {
            checked: true,
            blocks: [{ type: "paragraph", children: [{ type: "text", text: "済み" }] }],
          },
          {
            checked: false,
            blocks: [{ type: "paragraph", children: [{ type: "text", text: "未了" }] }],
          },
        ],
      },
    ]);
  });
});

describe("引用・罫線・表", () => {
  test("引用の中の段落", () => {
    expect(parseMarkdown("> 引用\n> **強調**")).toEqual([
      {
        type: "quote",
        children: [
          {
            type: "paragraph",
            children: [
              { type: "text", text: "引用" },
              { type: "break" },
              { type: "strong", children: [{ type: "text", text: "強調" }] },
            ],
          },
        ],
      },
    ]);
  });

  test("罫線", () => {
    expect(parseMarkdown("---")).toEqual([{ type: "rule" }]);
  });

  test("表の列の揃えを読む", () => {
    expect(parseMarkdown("| 名前 | 数 |\n| :--- | ---: |\n| a | 1 |")).toEqual([
      {
        type: "table",
        align: ["left", "right"],
        header: [[{ type: "text", text: "名前" }], [{ type: "text", text: "数" }]],
        rows: [[[{ type: "text", text: "a" }], [{ type: "text", text: "1" }]]],
      },
    ]);
  });
});

describe("文字として扱うもの", () => {
  test("HTML はタグとして解釈しない", () => {
    expect(parseMarkdown("<b>太字</b>")).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "<b>太字</b>" }] },
    ]);
  });
});
