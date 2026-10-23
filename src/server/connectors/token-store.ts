import { rmSync } from "node:fs";
import { readPrivateJson, writePrivateJson } from "../data/secret-file";

/**
 * コネクタのトークンを 1 ファイルに保存する。
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

    const content = readPrivateJson(path);
    if (content.kind === "missing") {
      cached = { kind: "none" };
      return cached;
    }
    if (content.kind === "unreadable") {
      cached = { kind: "unreadable", detail: content.detail };
      return cached;
    }
    if (!isStoredToken(content.value)) {
      cached = { kind: "unreadable", detail: `${path} の内容がコネクタの記録として読めません` };
      return cached;
    }

    cached = { kind: "token", token: content.value };
    return cached;
  }

  return {
    read() {
      return load();
    },

    save(token) {
      writePrivateJson(path, token, { createDirectory: true });
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
