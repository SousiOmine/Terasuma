import type { ModelId } from "../../../shared/model";
import { readSettingsFile, toModelSettings } from "./read";
import { writeSettingsFile } from "./write";
import type {
  EnvSettings,
  FileSettings,
  McpServerSettings,
  McpServersSettings,
  ModelSettings,
  ProviderSettings,
  StoredWebSearchSettings,
  WebSearchProviderSettings,
} from "./types";

/**
 * モデルとプロバイダ、MCP サーバーの設定。
 * config.json を唯一の保存先にしていて、変更のたびにファイルへ書き戻す。
 *
 * 読む口は 1 つにする。モデル用と MCP 用に分けて持つと、同じファイルを二重に読み、
 * 片方だけ古い状態を持ち続ける余地が生まれるため。
 */

/** 読み出した設定の全体。 */
export type StoredSettings = ModelSettings & {
  mcpServers: McpServersSettings;
  webSearch: StoredWebSearchSettings;
  /** コンピュータ（デスクトップコンテナ）のコマンドへ渡す環境変数。 */
  env: EnvSettings;
};

export type SettingsStore = {
  /** 現在の設定の全体。 */
  read(): StoredSettings;
  /**
   * プロバイダを追加・変更する。
   * 追加ウィザードでモデルまで選んだときは、既定のモデルも同じ書き込みで変える。
   */
  putProvider(id: string, provider: ProviderSettings, defaultModel?: ModelId): void;
  /** プロバイダを消す。設定が無ければ false を返し、何も書かない。 */
  deleteProvider(id: string): boolean;
  /** 既定のモデルを変える。 */
  setModel(model: ModelId): void;
  /**
   * モデルの思考強度を変える。null で未設定に戻す。
   * モデルごとに持つので、別のモデルへ切り替えても値は残る。
   */
  setReasoningEffort(model: ModelId, effort: string | null): void;
  /** MCP サーバーを追加・変更する。 */
  putMcpServer(id: string, server: McpServerSettings): void;
  /** MCP サーバーを消す。設定が無ければ false を返し、何も書かない。 */
  deleteMcpServer(id: string): boolean;
  /**
   * 検索プロバイダを追加・変更する。
   * makeDefault が true、または既定が未設定なら、このプロバイダを既定にする。
   */
  putWebSearchProvider(id: string, provider: WebSearchProviderSettings, makeDefault?: boolean): void;
  /** 検索プロバイダを消す。既定だった場合は既定も未設定に戻す。 */
  deleteWebSearchProvider(id: string): boolean;
  /** 既定の検索プロバイダを変える。null で未設定に戻す。 */
  setDefaultWebSearchProvider(id: string | null): void;
  /**
   * コンピュータのコマンドへ渡す環境変数を設定する。同じ名前は上書きする。
   * 値は画面へ返さない（名前だけを読める）。
   */
  setEnv(name: string, value: string): void;
  /** 環境変数を消す。設定が無ければ false を返し、何も書かない。 */
  deleteEnv(name: string): boolean;
};

/** 設定ファイルの内容を、実行時に読む形へ揃える。 */
function toStoredSettings(file: FileSettings): StoredSettings {
  return {
    ...toModelSettings(file),
    mcpServers: file.mcpServers ?? {},
    webSearch: {
      default: file.webSearch?.default ?? null,
      providers: file.webSearch?.providers ?? {},
    },
    env: file.env ?? {},
  };
}

/**
 * 設定ファイルを読み書きするストアを作る。
 *
 * 変更は必ず「ファイルを読み直す → 当てる → 書き戻す」の順で行う。
 * 起動中に config.json を手で編集されても、その内容を消さずに済ませるため。
 * 読み直した内容が壊れていれば、その時点でエラーになり、書き込みは行わない。
 */
export function createSettingsStore(configPath: string): SettingsStore {
  let current = toStoredSettings(readSettingsFile(configPath));

  /** 変更を当てて、書き込んだ後の全体を覚え直す。変更が無ければ書かない。 */
  function mutate(change: (settings: FileSettings) => boolean): void {
    const settings = readSettingsFile(configPath);
    if (change(settings)) writeSettingsFile(configPath, settings);
    current = toStoredSettings(settings);
  }

  return {
    read() {
      return current;
    },

    putProvider(id, provider, defaultModel) {
      mutate((settings) => {
        settings.providers = { ...settings.providers, [id]: provider };
        if (defaultModel !== undefined) settings.model = defaultModel;
        return true;
      });
    },

    deleteProvider(id) {
      let removed = false;
      mutate((settings) => {
        if (settings.providers?.[id] === undefined) return false;

        const providers = { ...settings.providers };
        delete providers[id];
        settings.providers = providers;
        removed = true;
        return true;
      });
      return removed;
    },

    setModel(model) {
      mutate((settings) => {
        settings.model = model;
        return true;
      });
    },

    setReasoningEffort(model, effort) {
      mutate((settings) => {
        const options = { ...settings.modelOptions };

        if (effort === null) {
          if (options[model] === undefined) return false;

          // 他の設定が残っていれば残し、空になったら項目ごと消す。
          const rest = { ...options[model] };
          delete rest.reasoningEffort;
          if (Object.keys(rest).length === 0) delete options[model];
          else options[model] = rest;
        } else {
          options[model] = { ...options[model], reasoningEffort: effort };
        }

        settings.modelOptions = options;
        return true;
      });
    },

    putMcpServer(id, server) {
      mutate((settings) => {
        settings.mcpServers = { ...settings.mcpServers, [id]: server };
        return true;
      });
    },

    deleteMcpServer(id) {
      let removed = false;
      mutate((settings) => {
        if (settings.mcpServers?.[id] === undefined) return false;

        const servers = { ...settings.mcpServers };
        delete servers[id];
        settings.mcpServers = servers;
        removed = true;
        return true;
      });
      return removed;
    },

    putWebSearchProvider(id, provider, makeDefault) {
      mutate((settings) => {
        const current = settings.webSearch ?? { providers: {} };
        const providers = { ...current.providers, [id]: provider };
        const defaultId = makeDefault === true || current.default === undefined ? id : current.default;
        settings.webSearch = { providers, ...(defaultId === undefined ? {} : { default: defaultId }) };
        return true;
      });
    },

    deleteWebSearchProvider(id) {
      let removed = false;
      mutate((settings) => {
        const current = settings.webSearch;
        if (current?.providers[id] === undefined) return false;

        const providers = { ...current.providers };
        delete providers[id];

        // 既定を消したら、どのプロバイダも既定ではない状態に戻す（次の検索はできない）。
        const defaultId = current.default === id ? undefined : current.default;
        settings.webSearch = { providers, ...(defaultId === undefined ? {} : { default: defaultId }) };
        removed = true;
        return true;
      });
      return removed;
    },

    setDefaultWebSearchProvider(id) {
      mutate((settings) => {
        const current = settings.webSearch ?? { providers: {} };
        if (id !== null && current.providers[id] === undefined) {
          throw new Error(`検索プロバイダ ${id} は設定されていません`);
        }

        settings.webSearch = { providers: current.providers, ...(id === null ? {} : { default: id }) };
        return true;
      });
    },

    setEnv(name, value) {
      mutate((settings) => {
        settings.env = { ...settings.env, [name]: value };
        return true;
      });
    },

    deleteEnv(name) {
      let removed = false;
      mutate((settings) => {
        if (settings.env?.[name] === undefined) return false;

        const variables = { ...settings.env };
        delete variables[name];
        settings.env = variables;
        removed = true;
        return true;
      });
      return removed;
    },
  };
}

// 設定ファイルの形と検証も、この入口から使えるようにする（呼び出し側は data/settings だけを見る）。
export {
  normalizeHttpUrl,
  normalizeProvider,
  normalizeWebSearchProvider,
  readMcpServerEntry,
  readSettingsFile,
  readWebSearchProviderEntry,
  toModelSettings,
} from "./read";
export { writeSettingsFile } from "./write";
export {
  mcpServerSettingsFromForm,
  parseProviderCredentials,
  providerSettingsFromForm,
  webSearchProviderSettingsFromForm,
} from "./form";
export { describeMcpServerIdProblem } from "./types";
export type {
  EngineKind,
  EnvSettings,
  FileSettings,
  McpHttpServerSettings,
  McpServerSettings,
  McpServersSettings,
  McpStdioServerSettings,
  ModelOptionSettings,
  ModelOptionsSettings,
  ModelSettings,
  ProviderSettings,
  ProvidersSettings,
  StoredWebSearchSettings,
  WebSearchProviderSettings,
  WebSearchProvidersSettings,
  WebSearchSettings,
} from "./types";
