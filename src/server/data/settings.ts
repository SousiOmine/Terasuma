import type { ModelId } from "../../shared/model";
import {
  readSettingsFile,
  toModelSettings,
  writeSettingsFile,
  type FileSettings,
  type McpServerSettings,
  type McpServersSettings,
  type ModelSettings,
  type ProviderSettings,
} from "./settings-schema";

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
};

/** 設定ファイルの内容を、実行時に読む形へ揃える。 */
function toStoredSettings(file: FileSettings): StoredSettings {
  return { ...toModelSettings(file), mcpServers: file.mcpServers ?? {} };
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
  };
}
