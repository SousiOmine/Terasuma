import { mcpServerIdProblem } from "../../../shared/ids";
import { trimOrNull } from "../../../shared/strings";
import type { McpServerForm, ProviderCredentials, WebSearchProviderForm } from "../../../shared/api/settings";
import { normalizeProvider, normalizeWebSearchProvider, readMcpServerEntry } from "./read";
import {
  describeMcpServerIdProblem,
  type McpServerSettings,
  type ProviderSettings,
  type WebSearchProviderSettings,
} from "./types";

/**
 * 画面（HTTP）から来た入力を、config.json に書ける形へ直す。
 *
 * 入力の検証は、設定ファイルを読むときと同じ規則に任せる（settings-schema.ts）。
 * ここが受け持つのは「未入力（null）を落とす」「前後の空白を落とす」という
 * 入力の形の違いだけにする。同じ規則を書き直すと、画面では通るのに保存できない状態になる。
 */

/** API から来た入力（未入力は null）を、設定ファイルに書ける形へ直す。 */
export function providerSettingsFromForm(form: ProviderCredentials): ProviderSettings {
  const settings: ProviderSettings = {};

  const apiKey = trimOrNull(form.apiKey ?? "");
  if (apiKey !== null) settings.apiKey = apiKey;

  const baseUrl = trimOrNull(form.baseUrl ?? "");
  if (baseUrl !== null) settings.baseUrl = baseUrl;

  const label = trimOrNull(form.label ?? "");
  if (label !== null) settings.label = label;

  return settings;
}

/**
 * 画面から来た MCP サーバーの入力（未入力は null）を、設定に書ける形へ直す。
 * 種類と食い違う項目は黙って捨てずに失敗させる（入れたつもりで効かない状態を作らないため）。
 */
export function mcpServerSettingsFromForm(form: McpServerForm, source: string): McpServerSettings {
  // id の検証は、設定ファイルを読むときと同じ 1 つの規則に任せる。
  const idProblem = mcpServerIdProblem(form.id);
  if (idProblem !== null) {
    throw new Error(`${source} の id に使えない値です: ${describeMcpServerIdProblem(form.id, idProblem)}`);
  }

  if (form.type === "stdio") {
    if (form.url !== null) {
      throw new Error(`${source} の url は http のサーバーにだけ指定できます`);
    }

    return readMcpServerEntry(
      form.id,
      {
        type: "stdio",
        command: form.command ?? undefined,
        args: form.args === null ? undefined : [...form.args],
        env: form.env === null ? undefined : { ...form.env },
      },
      source,
    );
  }

  if (form.command !== null || form.args !== null || form.env !== null) {
    throw new Error(`${source} の command / args / env は stdio のサーバーにだけ指定できます`);
  }

  return readMcpServerEntry(form.id, { type: "http", url: form.url ?? undefined }, source);
}

/** 画面から来た接続情報を、保存できる形に整える（検証まで済ませる）。 */
export function parseProviderCredentials(form: ProviderCredentials, source: string): ProviderSettings {
  return normalizeProvider(providerSettingsFromForm(form), source);
}

/**
 * 画面から来た検索プロバイダの入力を、設定に書ける形へ直す。
 * id と API キーの規則は、設定ファイルを読むときと同じ 1 箇所に任せる。
 */
export function webSearchProviderSettingsFromForm(
  form: WebSearchProviderForm,
  source: string,
): WebSearchProviderSettings {
  if (form.apiKey === null) throw new Error(`${source} の apiKey を指定してください`);
  return normalizeWebSearchProvider(form.id, form.apiKey, source);
}
