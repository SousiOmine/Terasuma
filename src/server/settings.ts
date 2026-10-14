import {
  readSettingsFile,
  toMcpSettings,
  toModelSettings,
  writeSettingsFile,
  type FileSettings,
  type McpServerSettings,
  type McpSettings,
  type ModelSettings,
  type ProviderSettings,
} from "../config";
import type { ModelId } from "../shared/model";

/**
 * モデルとプロバイダ、MCP サーバーの設定。
 * config.json を唯一の保存先にしていて、変更のたびにファイルへ書き戻す。
 */
export type SettingsStore = {
  /** 現在のモデル設定。 */
  read(): ModelSettings;
  /** 現在の MCP サーバーの設定。 */
  readMcp(): McpSettings;
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

/**
 * 設定ファイルを読み書きするストアを作る。
 *
 * 変更は必ず「ファイルを読み直す → 当てる → 書き戻す」の順で行う。
 * 起動中に config.json を手で編集されても、その内容を消さずに済ませるため。
 * 読み直した内容が壊れていれば、その時点でエラーになり、書き込みは行わない。
 */
export function createSettingsStore(configPath: string): SettingsStore {
  let current = toModelSettings(readSettingsFile(configPath));
  let currentMcp = toMcpSettings(readSettingsFile(configPath));

  function mutate(change: (settings: FileSettings) => boolean): void {
    const settings = readSettingsFile(configPath);
    if (change(settings)) writeSettingsFile(configPath, settings);
    current = toModelSettings(settings);
    currentMcp = toMcpSettings(settings);
  }

  return {
    read() {
      return current;
    },

    readMcp() {
      return currentMcp;
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
