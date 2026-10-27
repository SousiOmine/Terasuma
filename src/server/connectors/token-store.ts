import { createPrivateJsonStore } from "../data/private-store";

/**
 * コネクタのトークンを 1 ファイルに保存する。
 *
 * トークンは秘密なので、置き場と権限は data/private-store.ts に任せる（ディレクトリ 0700、ファイル 0600）。
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
  const store = createPrivateJsonStore<StoredToken>({
    path,
    is: isStoredToken,
    what: "コネクタの記録として読めません",
  });

  return {
    read() {
      const content = store.read();
      if (content.kind === "missing") return { kind: "none" };
      if (content.kind === "unreadable") return content;
      return { kind: "token", token: content.value };
    },

    save(token) {
      store.save(token);
    },

    clear() {
      store.clear();
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
