import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describeError } from "../../shared/errors";

/**
 * 接続したアプリのトークンを 1 ファイルに保存する。
 *
 * トークンは秘密なので、ディレクトリを 0700、ファイルを 0600 にする。
 * 読めないファイルは「接続が壊れている」として理由を返し、コンピュータのコマンドは止めない
 * （その状態でも、接続し直せば上書きできる）。
 */

/** 保存するトークン。 */
export type StoredToken = {
  accessToken: string;
  /** 接続中のアカウント。分からなければ null。 */
  account: string | null;
  /** 取得した時刻。epoch ミリ秒。 */
  obtainedAt: number;
};

/** 読み出した結果。未接続と、読めなかった理由を区別する。 */
export type StoredTokenState =
  | { kind: "none" }
  | { kind: "token"; token: StoredToken }
  | { kind: "unreadable"; detail: string };

export type TokenStore = {
  read(): StoredTokenState;
  save(token: StoredToken): void;
  clear(): void;
};

export function createTokenStore(path: string): TokenStore {
  // 読み出しはコマンドのたびに走る（環境変数を組み立てる）ので、覚えておく。
  // 書くのはこのプロセスだけなので、保存・削除のときに覚え直せば足りる。
  let cached: StoredTokenState | null = null;

  function load(): StoredTokenState {
    if (cached !== null) return cached;

    if (!existsSync(path)) {
      cached = { kind: "none" };
      return cached;
    }

    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isStoredToken(raw)) {
        cached = { kind: "unreadable", detail: `${path} の内容が接続の記録として読めません` };
        return cached;
      }
      cached = { kind: "token", token: raw };
    } catch (error) {
      cached = { kind: "unreadable", detail: describeError(error) };
    }
    return cached;
  }

  return {
    read() {
      return load();
    },

    save(token) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });

      const temporary = `${path}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(token, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, path);
      chmodSync(path, 0o600);

      cached = { kind: "token", token };
    },

    clear() {
      rmSync(path, { force: true });
      cached = { kind: "none" };
    },
  };
}

/** 保存した形として読めるかどうか。壊れた値をトークンとして使わない。 */
function isStoredToken(value: unknown): value is StoredToken {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const record = value as Record<string, unknown>;
  return (
    typeof record["accessToken"] === "string" &&
    record["accessToken"].length > 0 &&
    (record["account"] === null || typeof record["account"] === "string") &&
    typeof record["obtainedAt"] === "number" &&
    Number.isFinite(record["obtainedAt"])
  );
}
