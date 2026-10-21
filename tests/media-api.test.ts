import { describe, expect, test } from "bun:test";
import { withServer } from "./harness";
import { testPng } from "./support";

/**
 * エージェントが送った画像とファイルを、ブラウザへ返す経路。
 * URL は中身から決まり、画面はその URL をそのまま使う。
 */
describe("送った画像とファイルの配信", () => {
  test("保存した画像を、そのまま返す", async () => {
    await withServer(async (harness) => {
      const png = testPng(4, 3);
      const ref = harness.images.save(png, "image/png");

      const response = await harness.request(`/api/images/${ref.sha256}.png`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(png));
    });
  });

  test("保存したファイルを、元の名前でダウンロードさせる", async () => {
    await withServer(async (harness) => {
      const stored = harness.files.save(new TextEncoder().encode("hello"), "報告書.txt");

      const response = await harness.request(`/api/files/${stored.id}`);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(response.headers.get("content-disposition")).toContain(encodeURIComponent("報告書.txt"));
      expect(await response.text()).toBe("hello");
    });
  });

  test("無い画像・ファイルと、形の違う名前は 404", async () => {
    await withServer(async (harness) => {
      expect((await harness.request(`/api/images/${"0".repeat(64)}.png`)).status).toBe(404);
      expect((await harness.request(`/api/files/${"0".repeat(64)}`)).status).toBe(404);
      expect((await harness.request("/api/images/not-a-file")).status).toBe(404);
      expect((await harness.request("/api/files/not-a-hash")).status).toBe(404);
    });
  });
});
