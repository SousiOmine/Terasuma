import { describe, expect, test } from "bun:test";
import { screenTokenFromProtocols, screenTokenProtocol } from "../src/shared/screen";

describe("画面のトークン", () => {
  test("トークンを subprotocol の値にする", () => {
    expect(screenTokenProtocol("abc")).toBe("terasuma.vnc.abc");
  });

  test("subprotocol からトークンを取り出す", () => {
    expect(screenTokenFromProtocols("terasuma.vnc.abc")).toBe("abc");
  });

  test("複数の subprotocol から最初に一致したものを取り出し、前後の空白を落とす", () => {
    expect(screenTokenFromProtocols("foo, terasuma.vnc.abc")).toBe("abc");
    expect(screenTokenFromProtocols("foo,  terasuma.vnc.abc  , bar")).toBe("abc");
  });

  test("接頭辞が無い・null・接頭辞だけなら null", () => {
    expect(screenTokenFromProtocols("foo, bar")).toBeNull();
    expect(screenTokenFromProtocols(null)).toBeNull();
    expect(screenTokenFromProtocols("terasuma.vnc.")).toBeNull();
  });
});
