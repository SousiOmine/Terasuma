import { join } from "node:path";
import type { ConnectionsView } from "../../shared/types";
import type { SettingsStore } from "../data/settings";
import { ConnectionNotFound } from "../errors";
import { verifyAccount } from "./account";
import { CONNECTION_PROVIDERS, type ConnectionProvider } from "./providers";
import { createTokenStore, type TokenStore } from "./token-store";

/**
 * アプリの接続の状態。
 *
 * 接続はトークンを貼るだけなので、待つのは「トークンが保存されるまで」だけ。
 * computer_connect_app は wait で待ち、setToken が保存できた時点で待っているツールを解く。
 * ポーリングも有効期限も無い。
 *
 * 同じアプリを待つツールが複数あれば、保存時にまとめて解く（待ちはプロバイダごとの集合）。
 * ターンが止まったときは signal で待ちを外す（環境変数の入力と同じ扱い）。
 */

/** トークンの保存を待っているツール 1 つ。 */
type Waiter = {
  resolve(text: string): void;
  reject(error: unknown): void;
};

export type ConnectionsManager = {
  /** 設定画面に出す現在の状態。 */
  view(): ConnectionsView;
  /** id の定義。無ければ ConnectionNotFound。 */
  provider(id: string): ConnectionProvider;
  /** 定義されているプロバイダの id。ツールの案内に使う。 */
  ids(): readonly string[];
  /** Application ID を変える。null で設定ごと消す（Discord の招待リンクに使う）。 */
  setClientId(id: string, clientId: string | null): ConnectionsView;
  /**
   * トークンを保存する。保存する前にアカウントを読んで、受け付けられないトークンは保存しない。
   * 保存できたら、このアプリの待ちをすべて解く。
   */
  setToken(id: string, token: string): Promise<ConnectionsView>;
  /** トークンの保存を待っているツールを、取り消しの理由で失敗させる。 */
  cancelWait(id: string): void;
  /** 保存されているトークンを消す。 */
  disconnect(id: string): ConnectionsView;
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

export type ConnectionsOptions = {
  settings: SettingsStore;
  /** トークンを置くディレクトリ。 */
  dataDir: string;
  /** 差し替えたいときだけ渡す（テスト用）。 */
  providers?: readonly ConnectionProvider[];
};

/** プロバイダごとのトークンの置き場。 */
const TOKENS_DIR_NAME = "connections";

export function createConnections(options: ConnectionsOptions): ConnectionsManager {
  const { settings } = options;
  const providers = options.providers ?? CONNECTION_PROVIDERS;

  /** トークンの保存を待っているツール（プロバイダ id → 待ち）。 */
  const waiters = new Map<string, Set<Waiter>>();
  /** プロバイダ id → トークンの置き場。 */
  const stores = new Map<string, TokenStore>();

  function requireProvider(id: string): ConnectionProvider {
    const provider = providers.find((entry) => entry.id === id);
    if (provider === undefined) throw new ConnectionNotFound(id);
    return provider;
  }

  function tokenStore(id: string): TokenStore {
    const existing = stores.get(id);
    if (existing !== undefined) return existing;

    const store = createTokenStore(join(options.dataDir, TOKENS_DIR_NAME, `${id}.json`));
    stores.set(id, store);
    return store;
  }

  /** 保存済みの Application ID。未設定なら null。 */
  function clientIdOf(id: string): string | null {
    return settings.read().connections[id]?.clientId ?? null;
  }

  /** ツールへ返す、接続できたときの文。トークンそのものは含めない。 */
  function connectedText(provider: ConnectionProvider, account: string | null): string {
    const who = account === null ? provider.name : `${provider.name} as @${account}`;
    const envName = provider.env[0] ?? "TOKEN";

    return [
      `${who} is connected.`,
      `Commands in the computer can use $${envName}; do not print the token.`,
      provider.usage,
    ].join(" ");
  }

  /** 待っているツールを、成功の文で解く。 */
  function resolveWaiters(id: string, text: string): void {
    const pending = waiters.get(id);
    if (pending === undefined) return;

    waiters.delete(id);
    for (const waiter of pending) waiter.resolve(text);
  }

  /** 待っているツールを、理由を付けて失敗させる。 */
  function rejectWaiters(id: string, error: unknown): void {
    const pending = waiters.get(id);
    if (pending === undefined) return;

    waiters.delete(id);
    for (const waiter of pending) waiter.reject(error);
  }

  /** 待ち 1 つを外す（ターンの中断）。 */
  function removeWaiter(id: string, waiter: Waiter): void {
    const pending = waiters.get(id);
    if (pending === undefined) return;

    pending.delete(waiter);
    if (pending.size === 0) waiters.delete(id);
  }

  /** トークンが保存されるまで待つ。ターンの中断で待ちを外す。 */
  function waitForToken(id: string, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const waiter: Waiter = {
        resolve(text) {
          signal.removeEventListener("abort", onAbort);
          resolve(text);
        },
        reject(error) {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      };
      const onAbort = (): void => {
        removeWaiter(id, waiter);
        reject(new Error("The turn ended before the token was saved."));
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      const pending = waiters.get(id) ?? new Set<Waiter>();
      pending.add(waiter);
      waiters.set(id, pending);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function view(): ConnectionsView {
    return {
      providers: providers.map((provider) => {
        const token = tokenStore(provider.id).read();
        const clientId = clientIdOf(provider.id);

        return {
          id: provider.id,
          name: provider.name,
          description: provider.description,
          setupUrl: provider.setupUrl,
          token: provider.token,
          permissions: provider.permissions,
          env: provider.env,
          clientId,
          needsClientId: provider.invite !== undefined,
          connected: token.kind === "token",
          account: token.kind === "token" ? token.token.account : null,
          detail: token.kind === "unreadable" ? token.detail : null,
          inviteUrl: inviteUrlOf(provider, clientId),
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

    setClientId(id, clientId) {
      requireProvider(id);

      const current = clientIdOf(id);
      if (current === clientId) return view();

      settings.setConnectionClientId(id, clientId);
      return view();
    },

    cancelWait(id) {
      requireProvider(id);
      rejectWaiters(id, new Error("The user cancelled the connection."));
    },

    disconnect(id) {
      requireProvider(id);
      rejectWaiters(id, new Error("The connection was disconnected."));
      tokenStore(id).clear();
      return view();
    },

    async wait(id, signal) {
      const provider = requireProvider(id);

      const saved = tokenStore(id).read();
      if (saved.kind === "unreadable") {
        throw new Error(
          `The saved ${provider.name} token could not be read (${saved.detail}). Save the token again.`,
        );
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
      for (const id of [...waiters.keys()]) {
        rejectWaiters(id, new Error("Terasuma is shutting down; the connection was cancelled."));
      }
    },
  };
}

/** アプリをサーバーへ追加するリンク。Application ID が未設定、または invite を持たなければ null。 */
function inviteUrlOf(provider: ConnectionProvider, clientId: string | null): string | null {
  if (provider.invite === undefined || clientId === null) return null;

  const url = new URL(provider.invite.authorizeUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", provider.invite.scope);
  url.searchParams.set("permissions", provider.invite.permissions);
  return url.toString();
}
