import { describe, expect, test } from "bun:test";
import { decodeEntities, htmlToText, pageTitle } from "../../src/server/websearch/html";
import { truncateText } from "../../src/shared/text";

describe("HTML から本文へ", () => {
  test("タイトルを取り出す", () => {
    expect(pageTitle("<html><head><title>  Hello &amp; world </title></head></html>")).toBe("Hello & world");
    expect(pageTitle("<html><body>no title</body></html>")).toBeNull();
    expect(pageTitle("<title>   </title>")).toBeNull();
  });

  test("script / style / noscript の中身は残さない", () => {
    const html = [
      "<html><body>",
      "<script>var secret = 1;</script>",
      "<style>body { color: red; }</style>",
      "<noscript>enable js</noscript>",
      "<p>Visible text</p>",
      "</body></html>",
    ].join("");

    const text = htmlToText(html);
    expect(text).toContain("Visible text");
    expect(text).not.toContain("secret");
    expect(text).not.toContain("color: red");
    expect(text).not.toContain("enable js");
  });

  test("ブロック要素と br は改行になる", () => {
    const html = "<div>one</div><div>two<br>three</div><ul><li>a</li><li>b</li></ul>";
    expect(htmlToText(html)).toBe("one\ntwo\nthree\na\nb");
  });

  test("実体参照を戻す", () => {
    expect(decodeEntities("&lt;p&gt; &amp; &quot;q&quot; &#39;s&#39; &#x3042; &nbsp;x")).toBe("<p> & \"q\" 's' あ  x");
    // 知らない名前と範囲外の番号はそのまま残す。
    expect(decodeEntities("&unknown; &#0;")).toBe("&unknown; &#0;");
  });

  test("行内の余分な空白を詰め、空行は 1 つまでにする", () => {
    const html = "<p>  a   b  </p>\n\n\n\n<p>c</p>";
    expect(htmlToText(html)).toBe("a b\n\nc");
  });

  test("タグだけの HTML は空になる", () => {
    expect(htmlToText("<html><body><div></div></body></html>")).toBe("");
  });
});

describe("本文の切り詰め", () => {
  test("上限以内はそのまま", () => {
    expect(truncateText("short", 10, "parens")).toBe("short");
  });

  test("上限を超えたら切って、残りの文字数を添える", () => {
    const text = "a".repeat(20);
    expect(truncateText(text, 5, "parens")).toBe("aaaaa\n… (15 more characters)");
  });
});
