import { join } from "node:path";
import type { ConnectionFlowView, ConnectionsView } from "../../shared/types";
import type { SettingsStore } from "../data/settings";
import { ConnectionNotConfigured, ConnectionNotFound } from "../errors";
import { fetchAccount, pollToken, requestDeviceCode, verifyAccount, type DeviceCode } from "./device-flow";
import {
  CONNECTION_PROVIDERS,
  type ConnectionProvider,
  type DeviceFlowProvider,
} from "./providers";
import { createTokenStore, type TokenStore } from "./token-store";

/**
 * アプリの接続（Device Flow）の状態。
 *
 * 認可の開始は設定画面からもチャットのカードからも呼ばれる。同じプロバイダで
 * 二重に始めると、先に開いた認可ページのコードが使えなくなるので、進行中のフローを
 * 1 つだけ持ち、あとから来た呼び出しには同じコードを返す。
 *
 * 待ち（コンピュータのツール）は、トークンが保存された時点で解決する。
 * ターンが止まったときは signal で待ちを外す（環境変数の入力と同じ扱い）。
 */

/** 進行中の認可 1 件。 */
type ConnectionFlow = {
  provider: DeviceFlowProvider;
  code: DeviceCode;
  /** トークンを問い合わせる間隔（秒）。slow_down で延びる。 */
  intervalSeconds: number;
  /** ツールの待ち。認可が終わったら全員を解く。 */
  waiters: Set<Waiter>;
  /** 問い合わせを止める。 */
  abort: AbortController;
};

/** 待ち 1 つ分。 */
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
  /** Client ID を変える。null で設定ごと消す。進行中の認可は止める。 */
  setClientId(id: string, clientId: string | null): ConnectionsView;
  /**
   * Bot トークンを保存する（kind が "bot" のプロバイダだけ）。
   * 保存する前にアカウントを読んで、受け付けられないトークンは保存しない。
   */
  setToken(id: string, token: string): Promise<ConnectionsView>;
  /**
   * 認可を始める。進行中なら同じコードを返し、接続済みなら null を返す。
   * Client ID が未設定なら ConnectionNotConfigured。
   */
  start(id: string): Promise<ConnectionFlowView | null>;
  /** 進行中の認可を止める。待っているツールは失敗する。 */
  cancel(id: string): void;
  /** 保存されている認可を消す。 */
  disconnect(id: string): ConnectionsView;
  /**
   * ツール用。接続済みなら使い方の文を返し、未接続なら認可が終わるまで待つ。
   * ターンが止まったら signal で待ちを外す。
   */
  wait(id: string, signal: AbortSignal): Promise<string>;
  /** 接続済みのトークン。未接続・読めないときは null。 */
  token(id: string): string | null;
  /** コンピュータのコマンドへ渡す環境変数。 */
  env(): Record<string, string>;
  /** 進行中の問い合わせを止める。 */
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

  /** 進行中の認可（プロバイダ id → フロー）。 */
  const flows = new Map<string, ConnectionFlow>();
  /** 認可の開始を待っている呼び出し（同じプロバイダで二重に要求しない）。 */
  const starting = new Map<string, Promise<ConnectionFlowView>>();
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

  /** 保存済みの Client ID。未設定なら null。 */
  function clientIdOf(id: string): string | null {
    return settings.read().connections[id]?.clientId ?? null;
  }

  /** 進行中の認可を、画面に出せる形にする。 */
  function flowView(flow: ConnectionFlow): ConnectionFlowView {
    return {
      providerName: flow.provider.name,
      userCode: flow.code.userCode,
      verificationUri: flow.code.verificationUri,
      expiresAt: flow.code.expiresAt,
    };
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
  function resolveWaiters(flow: ConnectionFlow, text: string): void {
    const waiters = [...flow.waiters];
    flow.waiters.clear();
    for (const waiter of waiters) waiter.resolve(text);
  }

  /** 待っているツールを、理由を付けて失敗させる。 */
  function rejectWaiters(flow: ConnectionFlow, error: unknown): void {
    const waiters = [...flow.waiters];
    flow.waiters.clear();
    for (const waiter of waiters) waiter.reject(error);
  }

  /** 認可を始める。クライアント登録の往復だけを待ち、ポーリングは背景で続ける。 */
  async function begin(provider: DeviceFlowProvider, clientId: string): Promise<ConnectionFlowView> {
    const code = await requestDeviceCode(provider, clientId);
    const flow: ConnectionFlow = {
      provider,
      code,
      intervalSeconds: code.intervalSeconds,
      waiters: new Set(),
      abort: new AbortController(),
    };
    flows.set(provider.id, flow);
    void poll(flow, clientId);
    return flowView(flow);
  }

  /**
   * 認可が終わるまで、間隔を空けてトークンを問い合わせる。
   * 終わったらフローを片付け、待っているツールを解く。
   */
  async function poll(flow: ConnectionFlow, clientId: string): Promise<void> {
    const id = flow.provider.id;

    try {
      while (!flow.abort.signal.aborted) {
        const remaining = flow.code.expiresAt - Date.now();
        if (remaining <= 0) {
          throw new Error("The sign-in code expired. Ask the user to start the sign-in again.");
        }

        await sleep(Math.min(flow.intervalSeconds * 1_000, remaining), flow.abort.signal);
        if (flow.abort.signal.aborted) return;

        const result = await pollToken(flow.provider, clientId, flow.code.deviceCode);
        if (result.kind === "pending") continue;
        if (result.kind === "slow_down") {
          // 仕様どおり、次の問い合わせを 5 秒延ばす。
          flow.intervalSeconds += 5;
          continue;
        }
        if (result.kind === "failed") throw new Error(result.message);

        const account = await fetchAccount(flow.provider, result.accessToken);
        tokenStore(id).save({
          accessToken: result.accessToken,
          scope: result.scope,
          account,
          obtainedAt: Date.now(),
        });
        resolveWaiters(flow, connectedText(flow.provider, account));
        return;
      }
    } catch (error) {
      // 中止は画面側が待ちを片付けている。失敗として二重に伝えない。
      if (!flow.abort.signal.aborted) rejectWaiters(flow, error);
    } finally {
      if (flows.get(id) === flow) flows.delete(id);
    }
  }

  /** 認可を止める。待っているツールは「中止した」として失敗する。 */
  function cancel(id: string): void {
    const flow = flows.get(id);
    if (flow === undefined) return;

    flows.delete(id);
    flow.abort.abort();
    rejectWaiters(flow, new Error("The user cancelled the sign-in."));
  }

  /** 進行中のフローが終わるまで待つ。ターンの中断で待ちを外す。 */
  function waitForFlow(flow: ConnectionFlow, signal: AbortSignal): Promise<string> {
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
        flow.waiters.delete(waiter);
        reject(new Error("The turn ended before the sign-in finished."));
      };

      if (signal.aborted) {
        onAbort();
        return;
      }
      flow.waiters.add(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  function view(): ConnectionsView {
    return {
      providers: providers.map((provider) => {
        const token = tokenStore(provider.id).read();
        const flow = flows.get(provider.id);
        const clientId = clientIdOf(provider.id);

        return {
          id: provider.id,
          name: provider.name,
          description: provider.description,
          kind: provider.kind,
          setupUrl: provider.setupUrl,
          permissions: permissionsOf(provider),
          env: provider.env,
          clientId,
          connected: token.kind === "token",
          account: token.kind === "token" ? token.token.account : null,
          flow: flow === undefined ? null : flowView(flow),
          detail: token.kind === "unreadable" ? token.detail : null,
          inviteUrl: inviteUrlOf(provider, clientId),
        };
      }),
    };
  }

  /** 認可を始める。進行中なら同じコード、接続済みなら null を返す。 */
  async function startAuthorization(id: string): Promise<ConnectionFlowView | null> {
    const provider = requireProvider(id);
    if (tokenStore(id).read().kind === "token") return null;

    // Bot トークンは認可の画面では取れない。設定画面での保存を案内する。
    if (provider.kind === "bot") {
      throw new ConnectionNotConfigured(
        id,
        `${provider.name} は Bot トークンで接続します。設定 > 接続 でトークンを貼り付けて保存してください。`,
      );
    }

    const clientId = clientIdOf(id);
    if (clientId === null) throw new ConnectionNotConfigured(id);

    const existing = flows.get(id);
    if (existing !== undefined) return flowView(existing);

    const pending = starting.get(id);
    if (pending !== undefined) return pending;

    const begun = begin(provider, clientId);
    starting.set(id, begun);
    try {
      return await begun;
    } finally {
      starting.delete(id);
    }
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
      if (provider.kind !== "bot") {
        throw new Error(`${provider.name} does not use a pasted token; it has its own sign-in.`);
      }

      // 間違ったトークンを保存すると、次のコマンドで初めて 401 になる。ここで確かめる。
      const account = await verifyAccount(provider, token);
      tokenStore(id).save({ accessToken: token, scope: null, account, obtainedAt: Date.now() });
      return view();
    },

    setClientId(id, clientId) {
      requireProvider(id);

      const current = clientIdOf(id);
      if (current === clientId) return view();

      settings.setConnectionClientId(id, clientId);
      // 認可中のフローは古い Client ID で始まっている。登録が変わるのでやり直させる。
      cancel(id);
      return view();
    },

    start: startAuthorization,

    cancel,

    disconnect(id) {
      requireProvider(id);
      cancel(id);
      tokenStore(id).clear();
      return view();
    },

    async wait(id, signal) {
      const provider = requireProvider(id);

      const saved = tokenStore(id).read();
      if (saved.kind === "unreadable") {
        const action = provider.kind === "bot" ? "Save the token again." : "Connect again.";
        const what = provider.kind === "bot" ? "token" : "authorization";
        throw new Error(`The saved ${provider.name} ${what} could not be read (${saved.detail}). ${action}`);
      }
      if (saved.kind === "token") return connectedText(provider, saved.token.account);

      // Bot トークンは認可の画面では取れない。設定画面で貼ってもらうほかない。
      if (provider.kind === "bot") {
        throw new Error(
          [
            `${provider.name} is not connected.`,
            "Ask the user to open Settings > Connections, paste the Application ID and the bot token,",
            "and save the token. Then call this tool again.",
          ].join(" "),
        );
      }

      const clientId = clientIdOf(id);
      if (clientId === null) {
        throw new Error(
          [
            `${provider.name} is not connected, and no Client ID is configured.`,
            "Ask the user to open Settings > Connections, enter the Client ID of their OAuth app",
            "(with Device Flow enabled), and try again.",
          ].join(" "),
        );
      }

      // 進行中の認可があるなら、await を挟まずに待ちへ入る。
      // 挟むと、直後に届いた中止（カードの「やめる」）を取り逃す。
      const ongoing = flows.get(id);
      if (ongoing !== undefined) return waitForFlow(ongoing, signal);

      await startAuthorization(id);

      // start の間に認可が終わっていることがある（接続済み・失敗）。
      const flow = flows.get(id);
      if (flow === undefined) {
        const token = tokenStore(id).read();
        if (token.kind === "token") return connectedText(provider, token.token.account);
        throw new Error(`The ${provider.name} sign-in did not finish. Ask the user to try again.`);
      }

      return waitForFlow(flow, signal);
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
      const pending = [...flows.values()];
      flows.clear();
      for (const flow of pending) {
        flow.abort.abort();
        rejectWaiters(flow, new Error("Terasuma is shutting down; the sign-in was cancelled."));
      }
    },
  };
}

/** 画面に出す、要求する権限。device は scope 名、bot は API の権限名。 */
function permissionsOf(provider: ConnectionProvider): readonly string[] {
  return provider.kind === "device" ? provider.scopes : provider.permissions;
}

/** アプリをサーバーへ追加するリンク。clientId が未設定、または invite を持たなければ null。 */
function inviteUrlOf(provider: ConnectionProvider, clientId: string | null): string | null {
  if (provider.kind !== "bot" || provider.invite === undefined || clientId === null) return null;

  const url = new URL(provider.invite.authorizeUrl);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", provider.invite.scope);
  url.searchParams.set("permissions", provider.invite.permissions);
  return url.toString();
}

/** 指定した時間だけ待つ。signal が立ったら待つのをやめる。 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("The sign-in was cancelled."));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
