import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  BASH_TIMEOUT_MS,
  READ_MAX_BYTES,
  READ_MAX_LINES,
  createCodingToolset,
  resolveToolPath,
  type CodingToolset,
} from "../src/server/coding";

/**
 * read / write / edit / bash を、モデルを介さずにそのまま呼ぶ。
 * ツールがモデルへ渡る形（Mastra 経由）は tests/engine-tools.test.ts で確かめる。
 */

type ToolContext = { abortSignal?: AbortSignal };

async function withTools<T>(run: (context: { tools: CodingToolset; dir: string }) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "terasuma-coding-"));

  try {
    return await run({ tools: createCodingToolset({ cwd: dir }), dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** ツールをモデルを介さずにそのまま呼ぶ。 */
async function callTool(
  tools: CodingToolset,
  name: string,
  input: unknown,
  context: ToolContext = {},
): Promise<string> {
  const tool = tools[name];
  if (tool?.execute === undefined) throw new Error(`${name} が無い`);
  return (await tool.execute(input as never, context as never)) as string;
}

describe("read", () => {
  test("ファイルをそのまま読む", async () => {
    await withTools(async ({ tools, dir }) => {
      writeFileSync(join(dir, "note.txt"), "alpha\nbeta\n", "utf8");
      expect(await callTool(tools, "read", { path: "note.txt" })).toBe("alpha\nbeta\n");
    });
  });

  test("絶対パスも読める", async () => {
    await withTools(async ({ tools, dir }) => {
      const path = join(dir, "note.txt");
      writeFileSync(path, "absolute\n", "utf8");
      expect(await callTool(tools, "read", { path })).toBe("absolute\n");
    });
  });

  test("offset と limit で一部だけ読む", async () => {
    await withTools(async ({ tools, dir }) => {
      writeFileSync(join(dir, "lines.txt"), "l1\nl2\nl3\nl4\n", "utf8");
      expect(await callTool(tools, "read", { path: "lines.txt", offset: 2, limit: 2 })).toBe(
        "l2\nl3\n\n[1 more lines in file. Use offset=4 to continue.]",
      );
    });
  });

  test("大きいファイルは行数で切り、続きの offset を添える", async () => {
    await withTools(async ({ tools, dir }) => {
      const content = Array.from({ length: READ_MAX_LINES + 500 }, (_, index) => `line ${index + 1}`).join("\n");
      writeFileSync(join(dir, "large.txt"), `${content}\n`, "utf8");

      const output = await callTool(tools, "read", { path: "large.txt" });
      const [body, notice] = output.split("\n\n");

      expect(body?.split("\n").length).toBe(READ_MAX_LINES);
      expect(body?.startsWith("line 1\n")).toBe(true);
      expect(body).not.toContain(`line ${READ_MAX_LINES + 1}\n`);
      expect(notice).toBe(`[Showing lines 1-${READ_MAX_LINES} of ${READ_MAX_LINES + 500}. Use offset=${READ_MAX_LINES + 1} to continue.]`);
    });
  });

  test("1 行が上限を超えるときは bash を案内する", async () => {
    await withTools(async ({ tools, dir }) => {
      writeFileSync(join(dir, "huge.txt"), "x".repeat(READ_MAX_BYTES + 1), "utf8");
      await expect(callTool(tools, "read", { path: "huge.txt" })).rejects.toThrow("exceeds 50.0KB limit");
    });
  });

  test("offset が末尾を超えたら失敗する", async () => {
    await withTools(async ({ tools, dir }) => {
      writeFileSync(join(dir, "note.txt"), "one\ntwo\n", "utf8");
      await expect(callTool(tools, "read", { path: "note.txt", offset: 3 })).rejects.toThrow(
        "beyond end of file",
      );
    });
  });

  test("存在しないファイルは理由つきで失敗する", async () => {
    await withTools(async ({ tools }) => {
      await expect(callTool(tools, "read", { path: "missing.txt" })).rejects.toThrow();
    });
  });

  test("バイナリは読まない", async () => {
    await withTools(async ({ tools, dir }) => {
      writeFileSync(join(dir, "binary.bin"), new Uint8Array([0x00, 0x01, 0x02]));
      await expect(callTool(tools, "read", { path: "binary.bin" })).rejects.toThrow("is a binary file");
    });
  });
});

describe("write", () => {
  test("親ディレクトリを作って書く", async () => {
    await withTools(async ({ tools, dir }) => {
      const output = await callTool(tools, "write", { path: "nested/deep/note.txt", content: "hello\n" });

      expect(readFileSync(join(dir, "nested/deep/note.txt"), "utf8")).toBe("hello\n");
      expect(output).toContain("Successfully wrote to");
      expect(output).toContain(join(dir, "nested/deep/note.txt"));
    });
  });

  test("既存のファイルを上書きする", async () => {
    await withTools(async ({ tools, dir }) => {
      await callTool(tools, "write", { path: "note.txt", content: "first\n" });
      await callTool(tools, "write", { path: "note.txt", content: "second\n" });

      expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("second\n");
    });
  });

  test("空の内容も書ける", async () => {
    await withTools(async ({ tools, dir }) => {
      expect(await callTool(tools, "write", { path: "empty.txt", content: "" })).toContain("Successfully wrote to");
      expect(statSync(join(dir, "empty.txt")).size).toBe(0);
    });
  });
});

describe("edit", () => {
  test("一意な文字列を置き換える", async () => {
    await withTools(async ({ tools, dir }) => {
      writeFileSync(join(dir, "note.txt"), "hello world\n", "utf8");

      expect(await callTool(tools, "edit", { path: "note.txt", oldText: "world", newText: "there" })).toContain(
        "Successfully replaced 1 block",
      );
      expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("hello there\n");
    });
  });

  test("同じ文字列が複数あるときは、一意にするよう失敗する", async () => {
    await withTools(async ({ tools, dir }) => {
      writeFileSync(join(dir, "note.txt"), "a\na\n", "utf8");

      await expect(callTool(tools, "edit", { path: "note.txt", oldText: "a", newText: "b" })).rejects.toThrow(
        "2 occurrences",
      );
      expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("a\na\n");
    });
  });

  test("見つからないときは失敗する", async () => {
    await withTools(async ({ tools, dir }) => {
      writeFileSync(join(dir, "note.txt"), "hello\n", "utf8");

      await expect(
        callTool(tools, "edit", { path: "note.txt", oldText: "goodbye", newText: "hi" }),
      ).rejects.toThrow("Could not find the exact text");
    });
  });

  test("空の oldText は失敗する", async () => {
    await withTools(async ({ tools, dir }) => {
      writeFileSync(join(dir, "note.txt"), "hello\n", "utf8");

      await expect(callTool(tools, "edit", { path: "note.txt", oldText: "", newText: "hi" })).rejects.toThrow(
        "oldText must not be empty",
      );
    });
  });

  test("置き換えても内容が変わらないときは失敗する", async () => {
    await withTools(async ({ tools, dir }) => {
      writeFileSync(join(dir, "note.txt"), "hello\n", "utf8");

      await expect(
        callTool(tools, "edit", { path: "note.txt", oldText: "hello", newText: "hello" }),
      ).rejects.toThrow("No changes made");
    });
  });

  test("CRLF と BOM を保つ", async () => {
    await withTools(async ({ tools, dir }) => {
      writeFileSync(join(dir, "note.txt"), "\uFEFFa\r\nb\r\n", "utf8");

      await callTool(tools, "edit", { path: "note.txt", oldText: "b", newText: "c" });

      expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("\uFEFFa\r\nc\r\n");
    });
  });

  test("CRLF のファイルでも、LF で書いた oldText が一致する", async () => {
    await withTools(async ({ tools, dir }) => {
      writeFileSync(join(dir, "note.txt"), "a\r\nb\r\n", "utf8");

      await callTool(tools, "edit", { path: "note.txt", oldText: "a\nb", newText: "x" });

      expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("x\r\n");
    });
  });

  test("置換後の $ 記号をそのまま書く", async () => {
    await withTools(async ({ tools, dir }) => {
      writeFileSync(join(dir, "note.txt"), "price\n", "utf8");

      await callTool(tools, "edit", { path: "note.txt", oldText: "price", newText: "$&$1" });

      expect(readFileSync(join(dir, "note.txt"), "utf8")).toBe("$&$1\n");
    });
  });

  test("存在しないファイルは失敗する", async () => {
    await withTools(async ({ tools }) => {
      await expect(
        callTool(tools, "edit", { path: "missing.txt", oldText: "a", newText: "b" }),
      ).rejects.toThrow();
    });
  });
});

describe("bash", () => {
  test("標準出力と標準エラーをまとめ、終了コードが 0 でなければ失敗にする", async () => {
    await withTools(async ({ tools }) => {
      const failure = await callTool(tools, "bash", {
        command: "printf out; printf err >&2; exit 3",
      }).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain("outerr");
      expect(message).toContain("Command exited with code 3");
    });
  });

  test("成功したときは、終了コードを付けずに本文だけを返す", async () => {
    await withTools(async ({ tools }) => {
      expect(await callTool(tools, "bash", { command: "printf hello" })).toBe("hello");
    });
  });

  test("作業ディレクトリは基準ディレクトリ", async () => {
    await withTools(async ({ tools, dir }) => {
      const output = await callTool(tools, "bash", { command: "pwd -P" });
      expect(output).toContain(realpathSync(dir));
    });
  });

  test("何も出力しないコマンドでも結果を返す", async () => {
    await withTools(async ({ tools }) => {
      expect(await callTool(tools, "bash", { command: "true" })).toBe("(no output)");
    });
  });

  test("出力が大きすぎると、切ったことを残す", async () => {
    await withTools(async ({ tools }) => {
      const output = await callTool(tools, "bash", { command: "seq 1 30000" });

      // 末尾 2,000 行だけが残り、先頭は落ちている。
      expect(output.startsWith("28001\n")).toBe(true);
      expect(output).toContain("30000");
      expect(output).toContain("Showing lines 28001-30000 of 30000");
      expect(output).toContain("The beginning was omitted.");
    });
  });

  test("時間内に終わらなければ、切り捨てたことを添えて失敗する", async () => {
    await withTools(async ({ tools }) => {
      const output = callTool(tools, "bash", { command: "sleep 5", timeout: 0.2 });
      await expect(output).rejects.toThrow("timed out after 0.2 seconds");
    });
  });

  test("ターンが止まったら、実行中のコマンドも止める", async () => {
    await withTools(async ({ tools }) => {
      const controller = new AbortController();
      const running = callTool(tools, "bash", { command: "sleep 5" }, { abortSignal: controller.signal });
      setTimeout(() => controller.abort(), 100);

      await expect(running).rejects.toThrow("aborted");
    });
  });

  test("待ち時間の既定値は 120 秒", () => {
    expect(BASH_TIMEOUT_MS).toBe(120_000);
  });
});

describe("パスの解決", () => {
  test("相対パスは基準ディレクトリから解決する", () => {
    expect(resolveToolPath("src/a.ts", "/work")).toBe(resolve("/work", "src/a.ts"));
  });

  test("絶対パスはそのまま使う", () => {
    expect(resolveToolPath("/tmp/a.ts", "/work")).toBe("/tmp/a.ts");
  });

  test("~ はホームディレクトリに広げる", () => {
    expect(resolveToolPath("~", "/work")).toBe(homedir());
    expect(resolveToolPath("~/a.ts", "/work")).toBe(join(homedir(), "a.ts"));
  });

  test("空のパスは失敗する", () => {
    expect(() => resolveToolPath("  ", "/work")).toThrow("path must not be empty");
  });
});

describe("ツール名", () => {
  test("read / write / edit / bash をそのままの名前で渡す", () => {
    const dir = mkdtempSync(join(tmpdir(), "terasuma-coding-"));
    try {
      expect(Object.keys(createCodingToolset({ cwd: dir })).sort()).toEqual(["bash", "edit", "read", "write"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
