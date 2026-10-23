import { join } from "node:path";
import type { ConnectorsView } from "../../shared/api/settings";
import { ConnectorNotFound } from "../errors";
import { verifyAccount } from "./account";
import { CONNECTOR_PROVIDERS, type ConnectorProvider } from "./providers";
import { createTokenStore, type TokenStore } from "./token-store";
import { createPendingRegistry } from "../wait/pending";

/**
 * コネクタの状態。
 *
 * コネクタはトークンを貼るだけなので、待つのは「トークンが保存されるまで」だけ。
 * computer_connect_app は wait で待ち、setToken が保存できた時点で待っているツールを解く。
 * ポーリングも有効期限も無い。
 *
 * 同じアプリを待つツールが複数あれば、保存時にまとめて解く（待ちはプロバイダごとの集合）。
 * ターンが止まったときは signal で待ちを外す（環境変数の入力と同じ扱い）。
 *
 * Discord はここではなく、Tera ごとの webhook を server/discord が受け持つ。
 */

/** トークンの保存を待っているツール 1 つ。 */
type Waiter = {
  resolve(text: string): void;
  reject(error: unknown): void;
};

export type ConnectorsManager = {
  /** 設定画面に出す現在の状態。 */
  view(): ConnectorsView;
  /** id の定義。無ければ ConnectorNotFound。 */
  provider(id: string): ConnectorProvider;
  /** 定義されているプロバイダの id。ツールの案内に使う。 */
  ids(): readonly string[];
  /**
   * トークンを保存する。保存する前にアカウントを読んで、受け付けられないトークンは保存しない。
   * 保存できたら、このアプリの待ちをすべて解く。
   */
  setToken(id: string, token: string): Promise<ConnectorsView>;
  /** トークンの保存を待っているツールを、取り消しの理由で失敗させる。 */
  cancelWait(id: string): void;
  /** 保存されているトークンを消す。 */
  disconnect(id: string): ConnectorsView;
  /**
   * ツール用。接続済みなら使い方の文を返し、未接続ならトークンが保存されるまで待つ。
   * ターンが止まったら signal で待ちを外す。
   */
  wait(id: string, signal: AbortSignal): Promise<string>;
  /** 接続済みのトークン。未接続・読めないときは null。 */
  token(id: string): string | null;
  /** コンピュータのコマンドへ渡す環境変数。 */
  env(): Record<string, string>;
  /** 待っているツールを止める。 */
  close(): void;
};

export type ConnectorsOptions = {
  /** トークンを置くディレクトリ。 */
  dataDir: string;
  /** 差し替えたいときだけ渡す（テスト用）。 */
  providers?: readonly ConnectorProvider[];
};

/** プロバイダごとのトークンの置き場。 */
const TOKENS_DIR_NAME = "connectors";

/** ターンが終わって、待ちを続けられなくなったときの理由。 */
const WAIT_ENDED = "The turn ended before the token was saved.";

export function createConnectors(options: ConnectorsOptions): ConnectorsManager {
  const providers = options.providers ?? CONNECTOR_PROVIDERS;

  /** トークンの保存を待っているツール（プロバイダ id → 待ち）。同じ id を複数のツールが待てる。 */
  const pending = createPendingRegistry<string, Waiter>({ multiple: true });
  /** プロバイダ id → トークンの置き場。 */
  const stores = new Map<string, TokenStore>();

  function requireProvider(id: string): ConnectorProvider {
    const provider = providers.find((entry) => entry.id === id);
    if (provider === undefined) throw new ConnectorNotFound(id);
    return provider;
  }

  function tokenStore(id: string): TokenStore {
    const existing = stores.get(id);
    if (existing !== undefined) return existing;

    const store = createTokenStore(join(options.dataDir, TOKENS_DIR_NAME, `${id}.json`));
    stores.set(id, store);
    return store;
  }

  /** ツールへ返す、接続できたときの文。トークンそのものは含めない。 */
  function connectedText(provider: ConnectorProvider, account: string | null): string {
    const who = account === null ? provider.name : `${provider.name} as @${account}`;
    const envName = provider.env[0] ?? "TOKEN";

    return [
      `${who} is connected.`,
      `Commands in the computer can use $${envName}; do not put the token in a URL or print it.`,
      provider.usage,
    ].join(" ");
  }

  /** 待っているツールを、成功の文で解く。 */
  function resolveWaiters(id: string, text: string): void {
    for (const entry of pending.takeAll(id)) entry.pending.resolve(text);
  }

  /** 待っているツールを、理由を付けて失敗させる。 */
  function rejectWaiters(id: string, error: unknown): void {
    for (const entry of pending.takeAll(id)) entry.pending.reject(error);
  }

  /** トークンが保存されるまで待つ。ターンの中断で待ちを外す。 */
  function waitForToken(id: string, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const entry = pending.register(id, { resolve, reject }, signal, () => reject(new Error(WAIT_ENDED)));
      if (entry === null) reject(new Error(WAIT_ENDED));
    });
  }

  function view(): ConnectorsView {
    return {
      providers: providers.map((provider) => {
        const token = tokenStore(provider.id).read();

        return {
          id: provider.id,
          name: provider.name,
          description: provider.description,
          setupUrl: provider.setupUrl,
          token: provider.token,
          permissions: provider.permissions,
          env: provider.env,
          connected: token.kind === "token",
          account: token.kind === "token" ? token.token.account : null,
          detail: token.kind === "unreadable" ? token.detail : null,
        };
      }),
    };
  }

  return {
    view,

    provider(id) {
      return requireProvider(id);
    },

    ids() {
      return providers.map((provider) => provider.id);
    },

    async setToken(id, token) {
      const provider = requireProvider(id);

      // 間違ったトークンを保存すると、次のコマンドで初めて 401 になる。ここで確かめる。
      const account = await verifyAccount(provider, token);
      tokenStore(id).save({ accessToken: token, account, obtainedAt: Date.now() });
      resolveWaiters(id, connectedText(provider, account));
      return view();
    },

    cancelWait(id) {
      requireProvider(id);
      rejectWaiters(id, new Error("The user cancelled the connector setup."));
    },

    disconnect(id) {
      requireProvider(id);
      rejectWaiters(id, new Error("The connector was disconnected."));
      tokenStore(id).clear();
      return view();
    },

    async wait(id, signal) {
      const provider = requireProvider(id);

      const saved = tokenStore(id).read();
      if (saved.kind === "unreadable") {
        throw new Error(`The saved ${provider.name} token could not be read (${saved.detail}). Save the token again.`);
      }
      if (saved.kind === "token") return connectedText(provider, saved.token.account);

      return waitForToken(id, signal);
    },

    token(id) {
      const state = tokenStore(id).read();
      return state.kind === "token" ? state.token.accessToken : null;
    },

    env() {
      const variables: Record<string, string> = {};
      for (const provider of providers) {
        const state = tokenStore(provider.id).read();
        if (state.kind !== "token") continue;

        for (const name of provider.env) variables[name] = state.token.accessToken;
      }
      return variables;
    },

    close() {
      for (const id of [...pending.keys()]) {
        rejectWaiters(id, new Error("Terasuma is shutting down; the connector setup was cancelled."));
      }
    },
  };
}
