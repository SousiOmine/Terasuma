/**
 * 設定画面と API がやり取りする形。
 *
 * 保存されている設定そのものは server/data/settings が持ち、ここには画面へ返す形だけを置く。
 */

import type { ModelId } from "../model";

/** 設定画面に出すプロバイダ 1 件。API キーそのものは返さず、設定済みかどうかだけを返す。 */
export type ProviderView = {
  /** config.json の providers のキー。モデル ID の先頭部分と一致する。 */
  id: string;
  /** 画面に出す名前。既知のプロバイダはカタログの名前、独自エンドポイントは label。 */
  name: string;
  /** OpenAI 互換の独自エンドポイントのときだけ入る。 */
  baseUrl: string | null;
  hasApiKey: boolean;
};

/** モデル設定の現在の状態。設定を変える API はすべてこの形を返す。 */
export type ModelSettingsView = {
  /** 既定のモデル。未設定なら null。 */
  model: ModelId | null;
  providers: ProviderView[];
};

/** プロバイダに接続するための入力。接続確認と追加・変更で同じ形を使う。 */
export type ProviderCredentials = {
  apiKey: string | null;
  /** OpenAI 互換の独自エンドポイントのときだけ。 */
  baseUrl: string | null;
  /** 独自エンドポイントの表示名。既知のプロバイダでは使わない。 */
  label: string | null;
};

/** 接続確認の入力。 */
export type ProviderForm = ProviderCredentials & {
  id: string;
};

/** 接続確認の結果。verified が false のときは、確認する手段が無かったことを表す。 */
export type ProviderCheckResult = {
  verified: boolean;
  /** 確認できたときに得られたモデル ID。独自エンドポイントのモデル選択に使う。 */
  models: readonly string[];
};

/**
 * 設定画面に並べるプロバイダ 1 件（models.dev のカタログ）。
 * モデルの呼び出し方（どの URL に投げるか）はエンジンが持つので、ここには出さない。
 */
export type CatalogProviderView = {
  /** モデル ID の先頭部分になる id。 */
  id: string;
  name: string;
  /** このプロバイダのモデルまでを持つかどうか。 */
  models: number;
};

/** 既定のモデルに設定できる思考強度。 */
export type ReasoningView = {
  /** 対象のモデル。未設定なら null。 */
  model: ModelId | null;
  /** このモデルに保存されている思考強度。未設定なら null。 */
  effort: string | null;
  /** 選べる値。思考強度を渡せないモデルでは空になる。 */
  values: readonly string[];
};

/** プロバイダの追加。追加と同時に既定のモデルを決められる。 */
export type AddProviderForm = ProviderForm & {
  /** 既定にするモデル。決めない場合は null。 */
  defaultModel: ModelId | null;
};

/** MCP サーバーの接続状態。 */
export type McpServerState =
  /** まだ接続を確かめていない。 */
  | "unknown"
  | "connected"
  /** ブラウザでの認可を待っている。 */
  | "authorizing"
  /** 認可が必要（認可すると繋がる可能性がある）。 */
  | "authorization_required"
  | "failed";

/** MCP サーバー 1 件の接続状態。 */
export type McpServerStatusView = {
  state: McpServerState;
  /** 接続できたときに公開されているツール名。 */
  tools: readonly string[];
  /** 繋がらない理由。無ければ null。 */
  detail: string | null;
};

/** 設定画面に並べる MCP サーバー 1 件。 */
export type McpServerView = {
  id: string;
  type: "stdio" | "http";
  /** ローカルのサーバーを起動するコマンド。http では null。 */
  command: string | null;
  /** コマンドに渡す引数（stdio のみ）。 */
  args: readonly string[];
  /** 子プロセスに足す環境変数（stdio のみ）。 */
  env: Record<string, string>;
  /** http のサーバーの URL。stdio では null。 */
  url: string | null;
  status: McpServerStatusView;
};

/**
 * 追加の前に確かめる接続の結果。
 * サーバーが認可を求めた場合は、ブラウザで開く画面の URL も返る。
 */
export type McpTestView = McpServerStatusView & {
  /** 認可が必要なときに開く画面の URL。要らないときは null。 */
  authorizationUrl: string | null;
};

/** MCP 設定の現在の状態。設定を変える API はすべてこの形を返す。 */
export type McpServersView = {
  servers: McpServerView[];
};

/** MCP サーバーの追加・変更の入力。未入力は null。 */
export type McpServerForm = {
  id: string;
  type: "stdio" | "http";
  command: string | null;
  args: readonly string[] | null;
  env: Record<string, string> | null;
  url: string | null;
};

/** 認可を始めた結果。開く URL が返るか、すでに認可済みか。 */
export type McpAuthorizationView = {
  /** ブラウザで開く認可画面の URL。すでに認可済みなら null。 */
  url: string | null;
};

/** 設定画面に並べる検索プロバイダ 1 件。API キーそのものは返さない。 */
export type WebSearchProviderView = {
  /** exa / tavily / brave / perplexity / tinyfish のいずれか。 */
  id: string;
  name: string;
  /** ページ取得の API を持つかどうか。持たないものは直接取得になる。 */
  supportsFetch: boolean;
  hasApiKey: boolean;
  isDefault: boolean;
};

/** まだ登録していない検索プロバイダ（追加の候補）。 */
export type WebSearchAvailableProviderView = {
  id: string;
  name: string;
  supportsFetch: boolean;
};

/** Web 検索設定の現在の状態。設定を変える API はすべてこの形を返す。 */
export type WebSearchSettingsView = {
  /** 既定の検索プロバイダ。未設定なら null。 */
  defaultId: string | null;
  providers: WebSearchProviderView[];
  /** 追加できるプロバイダ。登録済みは含めない。 */
  available: WebSearchAvailableProviderView[];
};

/** 検索プロバイダの追加・変更の入力。変更で apiKey が null なら保存済みのキーを使う。 */
export type WebSearchProviderForm = {
  id: string;
  apiKey: string | null;
};

/**
 * 追加の前に確かめる接続の結果。
 * 失敗しても HTTP は 200 で返し、理由を detail に入れる（MCP の確認と同じ扱い）。
 */
export type WebSearchTestView = {
  ok: boolean;
  detail: string | null;
  /** 確認のために実行した検索の件数。成功したときの手応えとして出す。 */
  results: number;
};

/**
 * コンテナの状態。
 * どこまで準備できているかを、podman への問い合わせだけで決める（Terasuma 側に台帳を持たない）。
 */
export type ContainerState =
  /** podman が見つからない。 */
  | "podman_missing"
  /** イメージがまだ作られていない。 */
  | "image_missing"
  /** イメージはあるが、コンテナがまだ無い。 */
  | "container_missing"
  /** コンテナはあるが、動いていない。 */
  | "stopped"
  /** 動いている。 */
  | "running";

/** コンテナのいまの状態。設定画面とチャット画面はこれを見て案内を出す。 */
export type ContainerStatusView = {
  state: ContainerState;
  /** 画面の中継に使うホスト側のポート。動いていないときは null。 */
  vncPort: number | null;
  /** 状態を決められなかったときの理由。無ければ null。 */
  detail: string | null;
};

/**
 * コンピュータのコマンドへ渡す環境変数。
 * 値は API キーと同じ秘密なので返さず、名前だけを返す（設定画面の一覧に使う）。
 */
export type ComputerEnvView = {
  variables: readonly string[];
};

/** 設定画面に並べるコネクタ 1 件。トークンそのものは返さない。 */
export type ConnectorProviderView = {
  id: string;
  name: string;
  description: string;
  /** 設定や接続の手順を開くページ。 */
  setupUrl: string;
  /** トークンを貼るコネクタか、コンピュータの中のプログラムを確かめるコネクタか。 */
  kind: "token" | "program";
  /** トークン欄。program では null。 */
  token: { label: string; description: string; placeholder: string } | null;
  /** program コネクタの設定欄。token では null。 */
  setup: {
    provider: {
      label: string;
      description: string;
      choices: readonly { id: string; label: string; defaultModel: string }[];
      value: string | null;
    };
    key: { label: string; description: string; placeholder: string };
    model: { label: string; description: string; placeholder: string; value: string | null };
  } | null;
  /** トークンに付ける権限。画面に出す（GitHub は scope）。 */
  permissions: readonly string[];
  /** コネクタがコンピュータへ渡す環境変数の名前。program では空。 */
  env: readonly string[];
  /** 接続済みか。token はトークンあり、program は確認済みの記録あり。 */
  connected: boolean;
  /** 接続中のアカウント。未接続・program なら null。 */
  account: string | null;
  /** 接続しているものの説明（program のバージョンなど）。無ければ null。 */
  status: string | null;
  /** 保存されている記録を読めなかった理由。無ければ null。 */
  detail: string | null;
};

/** コネクタの設定の現在の状態。設定を変える API はすべてこの形を返す。 */
export type ConnectorsView = {
  providers: ConnectorProviderView[];
};
