import { describe, expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { resolveAppPaths } from "../src/paths";

describe("resolveAppPaths", () => {
  test("Windows はローミングの設定とローカルのデータを分ける", () => {
    const paths = resolveAppPaths(
      {
        APPDATA: win32.join("C:", "Users", "tester", "AppData", "Roaming"),
        LOCALAPPDATA: win32.join("C:", "Users", "tester", "AppData", "Local"),
      },
      "win32",
      win32.join("C:", "Users", "tester"),
    );

    expect(paths.configDir).toBe(win32.join("C:", "Users", "tester", "AppData", "Roaming", "Terasuma"));
    expect(paths.dataDir).toBe(win32.join("C:", "Users", "tester", "AppData", "Local", "Terasuma"));
  });

  test("Windows で APPDATA が無くても標準の場所を組み立てる", () => {
    const home = win32.join("C:", "Users", "tester");
    const paths = resolveAppPaths({}, "win32", home);

    expect(paths.configDir).toBe(win32.join(home, "AppData", "Roaming", "Terasuma"));
    expect(paths.dataDir).toBe(win32.join(home, "AppData", "Local", "Terasuma"));
  });

  test("macOS は Application Support にまとめる", () => {
    const paths = resolveAppPaths({}, "darwin", "/Users/tester");
    const expected = posix.join("/Users/tester", "Library", "Application Support", "Terasuma");

    expect(paths.configDir).toBe(expected);
    expect(paths.dataDir).toBe(expected);
  });

  test("Linux は XDG の既定値を使い、ディレクトリ名は小文字にする", () => {
    const paths = resolveAppPaths({}, "linux", "/home/tester");

    expect(paths.configDir).toBe(posix.join("/home/tester", ".config", "terasuma"));
    expect(paths.dataDir).toBe(posix.join("/home/tester", ".local", "share", "terasuma"));
  });

  test("XDG の環境変数があればそちらを使う", () => {
    const paths = resolveAppPaths(
      { XDG_CONFIG_HOME: "/opt/conf", XDG_DATA_HOME: "/opt/data" },
      "linux",
      "/home/tester",
    );

    expect(paths.configDir).toBe(posix.join("/opt/conf", "terasuma"));
    expect(paths.dataDir).toBe(posix.join("/opt/data", "terasuma"));
  });

  test("macOS と Linux は設定とデータを同じ規則で組み立てる", () => {
    const mac = resolveAppPaths({}, "darwin", "/Users/tester");
    const linux = resolveAppPaths({}, "linux", "/home/tester");

    expect(mac.configDir.endsWith("Terasuma")).toBe(true);
    expect(linux.configDir.endsWith("terasuma")).toBe(true);
  });
});
