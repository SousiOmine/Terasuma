import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE_NAME, type FileSettings } from "../src/config";
import { createSettingsStore, type SettingsStore } from "../src/server/settings";
import { createStore } from "../src/server/store";

/** 時刻を固定したストア。updated_at の比較を決定的にするため。 */
export function makeStore() {
  let tick = 1_000;
  return createStore(":memory:", { now: () => (tick += 1) });
}

/** 一時ディレクトリに本物の設定ファイルを作り、そこを指すストアを渡す。 */
export async function withTempSettings<T>(
  content: FileSettings | null,
  run: (store: SettingsStore, path: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "terasuma-settings-"));
  const path = join(dir, CONFIG_FILE_NAME);

  try {
    if (content !== null) writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`, "utf8");
    return await run(createSettingsStore(path), path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** テストで使う設定。プロバイダ 1 件が設定済みで、既定のモデルも決まっている状態。 */
export const TEST_SETTINGS: FileSettings = {
  model: "deepseek/deepseek-flash",
  providers: { deepseek: { apiKey: "test-key" } },
};
