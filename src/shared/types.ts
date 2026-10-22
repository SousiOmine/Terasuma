/**
 * サーバとクライアントで共有する型。
 * バンドルすると別々のファイルになるため、実行時のコードはここに置く定数（API_ERROR_CODES）だけにする。
 */

import type { ModelId } from "./model";

export type MessageRole = "user" | "assistant";

/** モデル呼び出し 1 回分のトークン消費。cachedInputTokens はプロンプトキャッシュのヒット分。 */
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
};

/**
 * エージェントがチャットへ添付したファイル 1 件。
 * 実体は Terasuma のデータディレクトリに置き、画面は URL だけで読む。
 */
export type SentAttachment = {
  /** 画面に出す名前。 */
  name: string;
  /** バイト数。 */
  size: number;
  /** ブラウザから開く URL。画像はそのまま表示し、それ以外はダウンロードする。 */
  url: string;
  /** 画像のときだけ、表示に使う縦横。画像でなければ null。 */
  image: { width: number; height: number } | null;
};

/** モデルの本文。画面にそのまま出す。 */
export type TextPart = {
  type: "text";
  text: string;
  /** 本文が始まった時刻。epoch ミリ秒。 */
  at: number;
};

/** エージェントがチャットへ添付した画像・ファイルのまとまり。 */
export type AttachmentPart = {
  type: "attachment";
  /** 一緒に添付したファイル（添付した順）。 */
  attachments: SentAttachment[];
  /** 添付した時刻。epoch ミリ秒。 */
  at: number;
};

/** 画面に出すシステムの注記（操作の上限で止まった、など）。 */
export type NoticePart = {
  type: "notice";
  text: string;
  at: number;
};

/** 画面に出す部品。 */
export type VisiblePart = TextPart | AttachmentPart | NoticePart;

/**
 * 1 ターン分の記録を組み立てている部品。
 *
 * text・attachment・notice は画面に出す。ツールの呼び出しと結果は内部の記録で、
 * 画面には出さずモデルへ渡す履歴にだけ使う。順序を保ったまま部分ごとに持つ。
 */
export type MessagePart =
  | TextPart
  | AttachmentPart
  | NoticePart
  | {
      type: "tool-call";
      /** モデルが発行した呼び出し id。結果と突き合わせる。 */
      id: string;
      /** 接続している MCP サーバーの id。 */
      server: string;
      /** MCP サーバーが公開しているツール名。 */
      tool: string;
      /** モデルが組み立てた引数。 */
      args: unknown;
    }
  | {
      type: "tool-result";
      id: string;
      server: string;
      tool: string;
      /** ツールがエラーを返したかどうか。 */
      failed: boolean;
      /** ツールが返した内容（モデルへ渡るのと同じ文字列）。 */
      output: string;
      /** ツールが返した画像（返した順）。画像を返さないツールでは無い。 */
      images?: ImageRef[];
    };

/**
 * 保存した画像の在り処。
 * 実体はデータディレクトリにファイルで置き、メッセージにはこの参照だけを持たせる
 * （base64 を保存すると、会話を読み直すたびに大きな文字列を運ぶことになる）。
 */
export type ImageRef = {
  /** ファイル名になる。画像の中身の sha256。 */
  sha256: string;
  /** image/png、image/jpeg、image/gif、image/webp のいずれか。 */
  mime: string;
  width: number;
  height: number;
};

/**
 * 画面に出す添付ファイル。
 * name と size は画面用。path はモデル向けの案内にだけ使い、画面は参照しない。
 */
export type ChatAttachment = {
  /** 画面に出す名前。 */
  name: string;
  /** バイト数。 */
  size: number;
  /** コンテナの中の絶対パス。モデルへ渡す案内にだけ使う。 */
  path: string;
};

export type ChatMessage = {
  id: string;
  /** このメッセージを持つ Tera。 */
  teraId: string;
  /** Tera の中の連番。1 から始まり、履歴の並び順を確定させる。 */
  seq: number;
  role: MessageRole;
  /**
   * ユーザーが書いた本文。
   * assistant のメッセージでは常に空で、画面に出す本文は parts の text が持つ。
   */
  content: string;
  /**
   * ユーザーが添付したファイル。無ければ null。
   * モデルへは、content とこの配列から案内を組み立てて渡す。
   */
  attachments: ChatAttachment[] | null;
  /**
   * そのターンに起きたことの記録。assistant では常に配列（空のこともある）。
   * ユーザーのメッセージでは null。
   *
   * text・attachment・notice は画面に出す。ツールの呼び出しと結果は内部の記録で、
   * 画面には出さずモデルへ渡す履歴にだけ使う。
   */
  parts: MessagePart[] | null;
  /** epoch ミリ秒 */
  createdAt: number;
  usage: TokenUsage | null;
};

/**
 * エージェント 1 体。会話の履歴を 1 本だけ持ち、モデルへ何を渡すかはこの単位で決める。
 * いまは既定の 1 体だけを起動時に用意する（増やす導線と、役割や人格は別の機会に足す）。
 */
export type Tera = {
  id: string;
  /** 画面に出す名前。 */
  name: string;
  /** epoch ミリ秒 */
  createdAt: number;
  updatedAt: number;
};

/**
 * サーバが返す機械可読なコード。画面に出す文言はクライアント側の i18n で解決する。
 * provider_* は、プロバイダの設定と接続確認で起きる失敗。
 * container_* は、コンテナの準備と操作で起きる失敗。
 *
 * 一覧を値としても持ち、型はそこから導く。型と一覧を別々に書くと、
 * コードを足したときに片方だけ古くなり、画面が理由を出せなくなる。
 */
export const API_ERROR_CODES = [
  "invalid_request",
  "tera_not_found",
  "model_error",
  "model_not_configured",
  "provider_not_found",
  "provider_exists",
  "provider_auth_failed",
  "provider_unreachable",
  "provider_no_models",
  "catalog_unavailable",
  "mcp_server_not_found",
  "mcp_server_exists",
  "mcp_authorization_failed",
  "connection_not_found",
  "connection_not_configured",
  "connection_authorization_failed",
  "web_search_not_found",
  "web_search_exists",
  "container_build_failed",
  "container_start_failed",
  "container_not_running",
  "handover_not_pending",
  "env_request_not_pending",
  "turn_in_progress",
  "media_not_found",
  "settings_write_failed",
  "internal_error",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

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

/**
 * 1 ターン分のストリーミングで流れるイベント。
 *
 * モデルの本文は、区切りごとに text パートとして assistant-message で流す。
 * 画像やファイルの添付は attachment パートとして流す。どちらも少しずつではなく、
 * 区切りが付いた時点で 1 件ずつ流す。ツール呼び出しと結果は、引き受け
 * （computer_ask_user）の始まりと終わりを見るために流す。
 */
export type ChatEvent =
  | { type: "user-message"; message: ChatMessage }
  | { type: "assistant-start"; id: string; createdAt: number }
  | { type: "assistant-message"; id: string; part: TextPart | AttachmentPart }
  | { type: "notice"; id: string; part: NoticePart }
  | { type: "tool-call"; id: string; part: Extract<MessagePart, { type: "tool-call" }> }
  | { type: "tool-result"; id: string; part: Extract<MessagePart, { type: "tool-result" }> }
  | { type: "assistant-done"; message: ChatMessage }
  | { type: "error"; code: ApiErrorCode; detail: string | null };

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

/**
 * アプリの認可（Device Flow）1 件。
 * コードはユーザーが認可ページへ入力し、終わるまでサーバーがトークンを問い合わせる。
 */
export type ConnectionFlowView = {
  /** アプリの表示名（"GitHub" など）。チャットのカードに出す。 */
  providerName: string;
  /** ユーザーが認可ページへ入力するコード。 */
  userCode: string;
  /** ブラウザで開く認可ページ。 */
  verificationUri: string;
  /** コードの有効期限。epoch ミリ秒。 */
  expiresAt: number;
};

/** 設定画面に並べる接続 1 件。トークンそのものは返さない。 */
export type ConnectionProviderView = {
  id: string;
  name: string;
  description: string;
  /** アプリを登録するためのページ。 */
  setupUrl: string;
  /** 接続で要求する権限。 */
  scopes: readonly string[];
  /** 接続がコンピュータへ渡す環境変数の名前。 */
  env: readonly string[];
  /** 保存済みの Client ID。未設定なら null。 */
  clientId: string | null;
  /** 接続中のアカウント。未接続なら null。 */
  account: string | null;
  /** 進行中の認可。無ければ null。 */
  flow: ConnectionFlowView | null;
  /** 保存されている認可を読めなかった理由。無ければ null。 */
  detail: string | null;
};

/** 接続の設定の現在の状態。設定を変える API はすべてこの形を返す。 */
export type ConnectionsView = {
  providers: ConnectionProviderView[];
};

/** 認可を始めた結果。すでに接続済みなら flow は null。 */
export type ConnectionAuthorizationView = {
  flow: ConnectionFlowView | null;
};
