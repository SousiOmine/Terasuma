import { homedir } from "node:os";
import { posix, win32 } from "node:path";

/** Windows と macOS はアプリ名をそのままディレクトリ名に使う。 */
const APP_DIR_NAME = "Terasuma";
/** Linux などでは小文字が慣例。 */
const APP_DIR_NAME_LOWER = "terasuma";

type AppPaths = {
  /** 設定ファイル（config.json）を置くディレクトリ。 */
  configDir: string;
  /** 会話データ（SQLite）を置くディレクトリ。 */
  dataDir: string;
};

/**
 * OS ごとの標準的な保存先を返す。
 *
 * Windows はローミングされる設定とマシン固有のデータを分ける。SQLite の DB を
 * ローミングの対象に置くと、同期の途中でファイルの一部だけが渡って開けなくなることがある。
 * macOS は Application Support にまとめ、それ以外は XDG Base Directory 仕様に従う。
 *
 * 引数はテストのために差し替えられるようにしてある。
 */
export function resolveAppPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): AppPaths {
  if (platform === "win32") {
    const separator = win32;
    // APPDATA が無い環境（サービスとして起動した場合など）でも標準の場所を組み立てる。
    const roaming = env.APPDATA?.trim() || separator.join(home, "AppData", "Roaming");
    const local = env.LOCALAPPDATA?.trim() || separator.join(home, "AppData", "Local");

    return {
      configDir: separator.join(roaming, APP_DIR_NAME),
      dataDir: separator.join(local, APP_DIR_NAME),
    };
  }

  if (platform === "darwin") {
    const base = posix.join(home, "Library", "Application Support", APP_DIR_NAME);
    return { configDir: base, dataDir: base };
  }

  const configHome = env.XDG_CONFIG_HOME?.trim() || posix.join(home, ".config");
  const dataHome = env.XDG_DATA_HOME?.trim() || posix.join(home, ".local", "share");

  return {
    configDir: posix.join(configHome, APP_DIR_NAME_LOWER),
    dataDir: posix.join(dataHome, APP_DIR_NAME_LOWER),
  };
}
