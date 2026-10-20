import { describe, expect, test } from "bun:test";
import { buildForm, envToText, lines, parseEnv, type McpFormFields } from "../../src/client/features/mcp/mcpForm";

/**
 * MCP サーバー追加ダイアログの入力の検証。
 * 文言はキーで返るので、辞書を読まずに確かめられる。
 */

function fields(overrides: Partial<McpFormFields> = {}): McpFormFields {
  return {
    id: "local",
    type: "stdio",
    command: "bunx",
    args: "-y\nserver-filesystem",
    env: "TOKEN=abc",
    url: "",
    ...overrides,
  };
}

describe("MCP サーバーの入力", () => {
  test("stdio はコマンド・引数・環境変数を整える", () => {
    expect(buildForm(fields(), [])).toEqual({
      kind: "ok",
      form: {
        id: "local",
        type: "stdio",
        command: "bunx",
        args: ["-y", "server-filesystem"],
        env: { TOKEN: "abc" },
        url: null,
      },
    });
  });

  test("http は url だけを持つ", () => {
    expect(buildForm(fields({ type: "http", url: "https://mcp.example.test/mcp" }), [])).toEqual({
      kind: "ok",
      form: { id: "local", type: "http", command: null, args: null, env: null, url: "https://mcp.example.test/mcp" },
    });
  });

  test("名前の規則は共有の 1 つに任せる", () => {
    expect(buildForm(fields({ id: "Local" }), [])).toEqual({
      kind: "error",
      message: "settings.mcp.form.invalidName",
    });
    // 内蔵ツールと衝突する名前は、サーバーへ行く前に断る。
    expect(buildForm(fields({ id: "computer" }), [])).toEqual({
      kind: "error",
      message: "settings.mcp.form.reservedName",
    });
    expect(buildForm(fields(), ["local"])).toEqual({
      kind: "error",
      message: "settings.mcp.form.nameTaken",
    });
  });

  test("種類ごとに要る項目が無ければ断る", () => {
    expect(buildForm(fields({ command: "  " }), [])).toEqual({
      kind: "error",
      message: "settings.mcp.form.needCommand",
    });
    expect(buildForm(fields({ env: "TOKEN" }), [])).toEqual({
      kind: "error",
      message: "settings.mcp.form.invalidEnv",
    });
    expect(buildForm(fields({ type: "http", url: " " }), [])).toEqual({
      kind: "error",
      message: "settings.mcp.form.needUrl",
    });
  });
});

describe("入力の読み替え", () => {
  test("1 行 1 項目は空行を落とす", () => {
    expect(lines("a\n\n b \n")).toEqual(["a", "b"]);
  });

  test("環境変数は KEY=VALUE だけを通す", () => {
    expect(parseEnv("A=1\nB=x=y")).toEqual({ A: "1", B: "x=y" });
    expect(parseEnv("=1")).toBeNull();
    expect(parseEnv("1A=1")).toBeNull();
  });

  test("対応表は KEY=VALUE の並びに戻せる", () => {
    expect(envToText({ A: "1", B: "2" })).toBe("A=1\nB=2");
  });
});
