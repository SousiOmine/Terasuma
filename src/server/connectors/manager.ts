import { join } from "node:path";
import type { ConnectorsView } from "../../shared/api/settings";
import { ConnectorNotFound } from "../errors";
import { verifyAccount } from "./account";
import { CONNECTOR_PROVIDERS, type ConnectorProvider, type ProgramProviderChoice } from "./providers";
import { checkPi, setupPi, type PiRuntime, type PiStatus } from "./pi";
import { createProgramStore, type ProgramStore } from "./program-store";
import { createTokenStore, type TokenStore } from "./token-store";
import { createPendingRegistry } from "../wait/pending";

/**
 * コネクタの状態。
 *
 * token コネクタは、利用者がトークンを保存するまで待つ。
 * program コネクタ（pi）は、利用者がプロバイダと API キーを設定するまで待つ。
 * アプリごとの接続ツール（app_connect_<id>）は wait で待ち、setToken か connect が終わった時点で待っているツールを解く。
 * ポーリングも有効期限も無い。
 *
 * 同じアプリを待つツールが複数あれば、保存時にまとめて解く（待ちはプロバイダごとの集合）。
 * ターンが止まったときは signal で待ちを外す（環境変数の入力と同じ扱い）。
 *
 * Discord はここではなく、Tera ごとの webhook を server/discord が受け持つ。
 */

/** トークンの保存か、program の設定を待っているツール 1 つ。 */
type Waiter = {
  resolve(text: string): void;
  reject(error: unknown): void;
};

// コンピュータの中で走らせた結果の型は pi.ts が持つ（manager → pi の一方向にする）。
export type { ConnectorScriptResult } from "./pi";

export type ConnectorsManager = {
  /** 設定画面に出す現在の状態。 */
  view(): ConnectorsView;
  /** id の定義。無ければ ConnectorNotFound。 */
  provider(id: string): ConnectorProvider;
  /** 定義されているプロバイダの id。ツールの案内に使う。 */
  ids(): readonly string[];
  /** 接続済みか。token はトークンあり、program は確認済みの記録あり。 */
  connected(id: string): boolean;
  /**
   * トークンを保存する。保存する前にアカウントを読んで、受け付けられないトークンは保存しない。
   * 保存できたら、このアプリの待ちをすべて解く。
   */
  setToken(id: string, token: string): Promise<ConnectorsView>;
  /**
   * program コネクタの設定を書いて確かめる。キーが無ければ、いまの設定を確かめるだけ。
   * 確かめられたら、このアプリの待ちをすべて解く。
   */
  connect(
    id: string,
    input?: { provider?: string; apiKey?: string; model?: string },
  ): Promise<ConnectorsView>;
  /** トークンの保存を待っているツールを、取り消しの理由で失敗させる。 */
  cancelWait(id: string): void;
  /** 保存されているトークンと確認結果を消す。 */
  disconnect(id: string): ConnectorsView;
  /**
   * ツール用。接続済みなら使い方の文を返し、未接続なら接続が終わるまで待つ。
   * program はカードでユーザーが設定するまで待つ（キーが要るため）。
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
  /** トークンと確認結果を置くディレクトリ。 */
  dataDir: string;
  /** 差し替えたいときだけ渡す（テスト用）。 */
  providers?: readonly ConnectorProvider[];
  /** コンピュータの中の読み書きと実行。program コネクタに必要。 */
  runtime?: PiRuntime;
};

/** プロバイダごとのトークンと確認結果の置き場。 */
const TOKENS_DIR_NAME = "connectors";

/** ターンが終わって、待ちを続けられなくなったときの理由。 */
const WAIT_ENDED = "The turn ended before the connector was set up.";

export function createConnectors(options: ConnectorsOptions): ConnectorsManager {
  const providers = options.providers ?? CONNECTOR_PROVIDERS;

  /** トークンの保存か確認を待っているツール（プロバイダ id → 待ち）。同じ id を複数のツールが待てる。 */
  const pending = createPendingRegistry<string, Waiter>({ multiple: true });
  /** プロバイダ id → トークンの置き場。 */
  const tokenStores = new Map<string, TokenStore>();
  /** プロバイダ id → program の確認結果の置き場。 */
  const programStores = new Map<string, ProgramStore>();

  function requireProvider(id: string): ConnectorProvider {
    const provider = providers.find((entry) => entry.id === id);
    if (provider === undefined) throw new ConnectorNotFound(id);
    return provider;
  }

  function tokenStore(id: string): TokenStore {
    const existing = tokenStores.get(id);
    if (existing !== undefined) return existing;

    const store = createTokenStore(join(options.dataDir, TOKENS_DIR_NAME, `${id}.json`));
    tokenStores.set(id, store);
    return store;
  }

  function programStore(id: string): ProgramStore {
    const existing = programStores.get(id);
    if (existing !== undefined) return existing;

    const store = createProgramStore(join(options.dataDir, TOKENS_DIR_NAME, `${id}.json`));
    programStores.set(id, store);
    return store;
  }

  /** ツールへ返す、接続できたときの文。トークンそのものは含めない。 */
  function connectedText(provider: ConnectorProvider, status: string | null): string {
    if (provider.kind === "program") {
      const version = status ?? "ready";
      return `${provider.name} is ready in the computer (${version}). ${provider.usage}`;
    }

    const who = status === null ? provider.name : `${provider.name} as @${status}`;
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

  /** program コネクタの設定を書き、実際に呼んで確かめる。 */
  async function setupProgram(
    provider: Extract<ConnectorProvider, { kind: "program" }>,
    input: { provider?: string; apiKey?: string; model?: string },
  ) {
    const runtime = options.runtime;
    if (runtime === undefined) {
      throw new Error(`The computer is not available, so ${provider.name} cannot be checked.`);
    }

    const apiKey = input.apiKey ?? "";
    // キーが無いときは「接続を確かめる」。設定は書かない。
    let status: PiStatus;
    if (apiKey.length === 0) {
      status = await checkPi(runtime);
    } else {
      const choice = requireProviderChoice(provider, input.provider);
      const model = input.model !== undefined && input.model.length > 0 ? input.model : choice.defaultModel;
      status = await setupPi(runtime, { provider: choice.id, apiKey, model });
    }

    programStore(provider.id).save({
      status: status.status,
      provider: status.provider,
      model: status.model,
      checkedAt: Date.now(),
    });
    resolveWaiters(provider.id, connectedText(provider, status.status));
    return status;
  }

  function view(): ConnectorsView {
    return {
      providers: providers.map((provider) => {
        if (provider.kind === "program") {
          const saved = programStore(provider.id).read();

          return {
            id: provider.id,
            name: provider.name,
            description: provider.description,
            setupUrl: provider.setupUrl,
            kind: provider.kind,
            token: null,
            setup: {
              provider: {
                label: provider.setup.provider.label,
                description: provider.setup.provider.description,
                choices: provider.setup.provider.choices.map((choice) => ({
                  id: choice.id,
                  label: choice.label,
                  defaultModel: choice.defaultModel,
                })),
                value: saved.kind === "record" ? saved.record.provider : null,
              },
              key: provider.setup.key,
              model: {
                ...provider.setup.model,
                value: saved.kind === "record" ? saved.record.model : null,
              },
            },
            permissions: provider.permissions,
            env: [],
            connected: saved.kind === "record",
            account: null,
            status: saved.kind === "record" ? saved.record.status : null,
            detail: saved.kind === "unreadable" ? saved.detail : null,
          };
        }

        const token = tokenStore(provider.id).read();

        return {
          id: provider.id,
          name: provider.name,
          description: provider.description,
          setupUrl: provider.setupUrl,
          kind: provider.kind,
          token: provider.token,
          setup: null,
          permissions: provider.permissions,
          env: provider.env,
          connected: token.kind === "token",
          account: token.kind === "token" ? token.token.account : null,
          status: null,
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

    connected(id) {
      const provider = requireProvider(id);
      if (provider.kind === "program") return programStore(id).read().kind === "record";
      return tokenStore(id).read().kind === "token";
    },

    async setToken(id, token) {
      const provider = requireProvider(id);
      if (provider.kind !== "token") {
        throw new Error(`${provider.name} does not use a token; check it in the settings instead.`);
      }

      // 間違ったトークンを保存すると、次のコマンドで初めて 401 になる。ここで確かめる。
      const account = await verifyAccount(provider, token);
      tokenStore(id).save({ accessToken: token, account, obtainedAt: Date.now() });
      resolveWaiters(id, connectedText(provider, account));
      return view();
    },

    async connect(id, input = {}) {
      const provider = requireProvider(id);
      if (provider.kind !== "program") {
        throw new Error(`${provider.name} is connected with a token; save the token instead.`);
      }

      await setupProgram(provider, input);
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
      programStore(id).clear();
      return view();
    },

    async wait(id, signal) {
      const provider = requireProvider(id);

      if (provider.kind === "program") {
        const saved = programStore(id).read();
        if (saved.kind === "record") return connectedText(provider, saved.record.status);

        // キーが要るので、トークンと同じくカードで設定されるまで待つ。
        return waitForToken(id, signal);
      }

      const saved = tokenStore(id).read();
      if (saved.kind === "unreadable") {
        throw new Error(`The saved ${provider.name} token could not be read (${saved.detail}). Save the token again.`);
      }
      if (saved.kind === "token") return connectedText(provider, saved.token.account);

      return waitForToken(id, signal);
    },

    token(id) {
      const provider = requireProvider(id);
      if (provider.kind !== "token") return null;

      const state = tokenStore(id).read();
      return state.kind === "token" ? state.token.accessToken : null;
    },

    env() {
      const variables: Record<string, string> = {};
      for (const provider of providers) {
        if (provider.kind !== "token") continue;

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

/** 画面から来た provider id を、定義済みの選択肢にする。 */
function requireProviderChoice(
  provider: Extract<ConnectorProvider, { kind: "program" }>,
  id: string | undefined,
): ProgramProviderChoice {
  const choice = provider.setup.provider.choices.find((entry) => entry.id === id);
  if (choice === undefined) {
    throw new Error(`${provider.name}: unknown provider "${id ?? ""}".`);
  }
  return choice;
}

