import { describe, expect, test } from "bun:test";
import { MAX_ATTACHMENTS } from "../src/shared/attachments";
import { safeFileName, saveUploads, type UploadFile, type UploadWriter } from "../src/server/computer/uploads";

/** 書き込まれたパスと中身を記録するだけの置き場。 */
function recordingWriter(): UploadWriter & { writes: { path: string; bytes: Uint8Array }[] } {
  const writes: { path: string; bytes: Uint8Array }[] = [];

  return {
    writes,
    async writeFile(path, content) {
      writes.push({ path, bytes: content });
    },
  };
}

function upload(name: string, text: string): UploadFile {
  return { name, bytes: new TextEncoder().encode(text) };
}

describe("添付ファイルの名前", () => {
  test("パス区切りは落とし、置き場の外を指す名前を作らない", () => {
    expect(safeFileName("../escape.txt")).toBe("escape.txt");
    expect(safeFileName("..\\escape.txt")).toBe("escape.txt");
    expect(safeFileName("folder/note.txt")).toBe("note.txt");
    expect(safeFileName("folder\\note.txt")).toBe("note.txt");
  });

  test("空やドットだけの名前は file にする", () => {
    expect(safeFileName("")).toBe("file");
    expect(safeFileName("   ")).toBe("file");
    expect(safeFileName(".")).toBe("file");
    expect(safeFileName("..")).toBe("file");
  });

  test("制御文字を置き換え、長すぎる名前をバイト数で切る", () => {
    expect(safeFileName("a\u0000b\nc.txt")).toBe("a_b_c.txt");
    expect(safeFileName("a".repeat(300)).length).toBe(200);
    expect(Buffer.byteLength(safeFileName("あ".repeat(100)), "utf-8")).toBeLessThanOrEqual(200);
  });
});

describe("添付ファイルの保存", () => {
  test("コンテナの uploads に置き、名前とパスと大きさを返す", async () => {
    const writer = recordingWriter();
    const files = await saveUploads(
      writer,
      [upload("notes.txt", "hello"), upload("photo.png", "image")],
      new AbortController().signal,
    );

    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({
      name: "notes.txt",
      size: 5,
      path: expect.stringMatching(/^\/home\/agent\/uploads\/.+\/01-notes\.txt$/),
    });
    expect(files[1]?.path.endsWith("/02-photo.png")).toBe(true);

    expect(writer.writes).toHaveLength(2);
    expect(new TextDecoder().decode(writer.writes[0]?.bytes)).toBe("hello");
    expect(new TextDecoder().decode(writer.writes[1]?.bytes)).toBe("image");
  });

  test("ファイルが無ければ何も書かず、空の配列を返す", async () => {
    const writer = recordingWriter();
    const files = await saveUploads(writer, [], new AbortController().signal);

    expect(files).toEqual([]);
    expect(writer.writes).toEqual([]);
  });

  test("数が上限を超えたら書かずに止める", async () => {
    const writer = recordingWriter();
    const files = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, index) => upload(`${index}.txt`, "x"));

    await expect(saveUploads(writer, files, new AbortController().signal)).rejects.toThrow(
      `You can attach up to ${MAX_ATTACHMENTS} files`,
    );
    expect(writer.writes).toEqual([]);
  });
});
