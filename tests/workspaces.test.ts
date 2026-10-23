import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TERAS_DIR_IN_CONTAINER,
  ensureTeraWorkspace,
  teraWorkspaceDir,
  teraWorkspaceInContainer,
} from "../src/server/computer/workspaces";

describe("Tera の作業フォルダ", () => {
  test("コンテナの中では /home/agent/teras/<tera id> になる", () => {
    expect(TERAS_DIR_IN_CONTAINER).toBe("/home/agent/teras");
    expect(teraWorkspaceInContainer("default")).toBe("/home/agent/teras/default");
    expect(teraWorkspaceInContainer("second")).toBe("/home/agent/teras/second");
  });

  test("ホスト側は、コンテナのホームをマウントしている場所の下になる", () => {
    expect(teraWorkspaceDir("/data", "default")).toBe(join("/data", "container", "home", "teras", "default"));
  });

  test("フォルダ名に使えない id は、別名にせず止める", () => {
    const invalid = ["", "..", ".", "a/b", "../escape", "A", "with space", ".hidden", "-lead"];

    for (const teraId of invalid) {
      expect(() => teraWorkspaceInContainer(teraId), teraId).toThrow();
      expect(() => teraWorkspaceDir("/data", teraId), teraId).toThrow();
    }
  });

  test("ensureTeraWorkspace はフォルダを作り、コンテナの中のパスを返す", () => {
    const dir = mkdtempSync(join(tmpdir(), "terasuma-workspaces-"));

    try {
      const path = ensureTeraWorkspace(dir, "default");
      expect(path).toBe("/home/agent/teras/default");
      expect(statSync(join(dir, "container", "home", "teras", "default")).isDirectory()).toBe(true);

      // 何度呼んでも同じ結果になる（すでにあっても失敗しない）。
      expect(ensureTeraWorkspace(dir, "default")).toBe(path);
      expect(existsSync(join(dir, "container", "home", "teras", "default"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
