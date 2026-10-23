import { describe, expect, test } from "bun:test";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPrivateJson, writePrivateJson } from "../src/server/data/secret-file";
import { withTempDir } from "./harness";

describe("秘密の JSON ファイル", () => {
  test("親ディレクトリを作り、0600 で書く", async () => {
    await withTempDir("terasuma-secret-", (dir) => {
      const path = join(dir, "nested", "secret.json");

      writePrivateJson(path, { token: "x" }, { createDirectory: true });

      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, "nested")).mode & 0o777).toBe(0o700);
      expect(readPrivateJson(path)).toEqual({ kind: "value", value: { token: "x" } });
      // 一時ファイルを残さない。
      expect(readPrivateJson(`${path}.tmp`)).toEqual({ kind: "missing" });
    });
  });

  test("置き場を作らない指定では、無いディレクトリを勝手に作らない", async () => {
    await withTempDir("terasuma-secret-", (dir) => {
      const path = join(dir, "missing", "config.json");

      expect(() => writePrivateJson(path, { a: 1 })).toThrow();
      expect(() => statSync(join(dir, "missing"))).toThrow();
    });
  });

  test("無いファイルと、壊れたファイルを区別する", async () => {
    await withTempDir("terasuma-secret-", (dir) => {
      expect(readPrivateJson(join(dir, "none.json"))).toEqual({ kind: "missing" });

      const broken = join(dir, "broken.json");
      writeFileSync(broken, "{", "utf8");
      const content = readPrivateJson(broken);
      expect(content.kind).toBe("unreadable");
    });
  });

  test("書き換えは置き換えで行い、権限を保つ", async () => {
    await withTempDir("terasuma-secret-", (dir) => {
      mkdirSync(join(dir, "nested"), { recursive: true, mode: 0o700 });
      const path = join(dir, "nested", "secret.json");

      writePrivateJson(path, { step: 1 }, { createDirectory: true });
      writePrivateJson(path, { step: 2 }, { createDirectory: true });

      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readPrivateJson(path)).toEqual({ kind: "value", value: { step: 2 } });
    });
  });
});
