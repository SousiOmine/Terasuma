import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createImageStore } from "../src/server/images";
import { testPng } from "./support";

function withStore<T>(run: (context: { store: ReturnType<typeof createImageStore>; dir: string }) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "terasuma-images-"));

  try {
    return run({ store: createImageStore(dir), dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("画像の置き場", () => {
  test("保存すると、大きさが分かる参照が返る", () => {
    withStore(({ store }) => {
      const ref = store.save(testPng(1280, 800), "image/png");

      expect(ref.width).toBe(1280);
      expect(ref.height).toBe(800);
      expect(ref.mime).toBe("image/png");
      expect(ref.sha256).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  test("同じ中身は同じ参照になり、ファイルも 1 つで済む", () => {
    withStore(({ store, dir }) => {
      const first = store.save(testPng(1280, 800), "image/png");
      const second = store.save(testPng(1280, 800), "image/png");

      expect(second.sha256).toBe(first.sha256);
      expect(readdirSync(join(dir, "images"))).toHaveLength(1);
    });
  });

  test("中身が違えば別のファイルになる", () => {
    withStore(({ store, dir }) => {
      store.save(testPng(1280, 800), "image/png");
      store.save(testPng(640, 400), "image/png");

      expect(readdirSync(join(dir, "images"))).toHaveLength(2);
    });
  });

  test("保存した画像は、参照からもハッシュからも読める", () => {
    withStore(({ store }) => {
      const png = testPng(100, 50);
      const ref = store.save(png, "image/png");

      expect(store.read(ref)).toEqual(png);

      const found = store.find(ref.sha256);
      expect(found?.mime).toBe("image/png");
      expect(found?.data).toEqual(png);
    });
  });

  test("無い画像は null を返す（例外にしない）", () => {
    withStore(({ store }) => {
      expect(store.find("0".repeat(64))).toBeNull();
      // ハッシュの形でない値は、パスを組み立てる前に断る。
      expect(store.find("../../etc/passwd")).toBeNull();
      expect(store.find("短い")).toBeNull();
    });
  });

  test("扱えない種類と、壊れた中身は失敗させる", () => {
    withStore(({ store }) => {
      expect(() => store.save(testPng(10, 10), "image/gif")).toThrow();
      // PNG の署名が無い中身を、大きさが分からないまま保存しない。
      expect(() => store.save(new Uint8Array(24), "image/png")).toThrow();
      expect(() => store.save(new Uint8Array(4), "image/png")).toThrow();
    });
  });
});
