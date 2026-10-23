import { describe, expect, test } from "bun:test";
import { pastedFiles, type PastedItem } from "../../src/client/lib/composer-paste";

/** 文字列や画像など、ファイル以外の項目。 */
function textItem(): PastedItem {
  return { kind: "string", getAsFile: () => null };
}

/** ファイルを持つ項目。 */
function fileItem(file: File | null): PastedItem {
  return { kind: "file", getAsFile: () => file };
}

function textFile(name: string, body = "hello"): File {
  return new File([body], name, { type: "text/plain" });
}

describe("貼り付けられたファイルの取り出し", () => {
  test("files があれば、その順番のまま使う", () => {
    const first = textFile("first.txt");
    const second = textFile("second.txt");

    expect(pastedFiles([first, second], [])).toEqual([first, second]);
  });

  test("files が空なら items のファイルだけを拾う", () => {
    const image = new File(["png"], "image.png", { type: "image/png" });
    const note = textFile("note.txt");

    const files = pastedFiles([], [textItem(), fileItem(image), fileItem(null), fileItem(note)]);

    expect(files).toEqual([image, note]);
  });

  test("files と items の両方にあっても、二重には数えない", () => {
    const image = new File(["png"], "image.png", { type: "image/png" });

    expect(pastedFiles([image], [fileItem(image)])).toEqual([image]);
  });

  test("ファイルが無ければ空", () => {
    expect(pastedFiles([], [textItem()])).toEqual([]);
    expect(pastedFiles([], [])).toEqual([]);
  });
});
