/**
 * ツール名の規約。
 *
 * モデルへ渡すツール名は "<サーバー id>_<ツール名>" の 1 つの形にする。
 * MCP サーバーのツールも、Terasuma の内蔵ツール（computer_...）も同じ名前空間に並ぶ。
 * 組み立てる場所と分解する場所が離れると規則がずれるので、ここだけに置く。
 *
 * サーバー id には "_" を使えない（shared/ids.ts で弾いている）。
 * そのため分解は最初の "_" で必ず確定する。
 */

/** サーバー id とツール名の区切り。 */
export const TOOL_NAME_SEPARATOR = "_";

/** 内蔵のコンピュータ操作ツールのサーバー id。MCP サーバーの id としては使えない。 */
export const COMPUTER_SERVER_ID = "computer";

/**
 * 画像やファイルをチャットへ添付する内蔵ツールのサーバー id。
 * 本文はモデルの通常のテキストとして届くので、このツールは添付だけを扱う。
 */
export const CHAT_SERVER_ID = "chat";

/**
 * ツール検索（tool_search と tool_call）が使う内蔵のサーバー id。
 * モデルのツール一覧に載せないツールは、ここから見つけて実行する。
 */
export const TOOL_SERVER_ID = "tool";

/**
 * 過去の対話履歴（保存済みのやり取り）を検索する内蔵ツールのサーバー id。
 * いまの会話へ添付する chat_ とは別に、畳まれて文脈から外れたやり取りを引く。
 */
export const HISTORY_SERVER_ID = "history";

/**
 * Web 検索とページ取得の内蔵ツールのサーバー id。
 * プロバイダは設定で選ぶが、モデルへ渡す名前はこの 1 つに統一する。
 */
export const WEB_SERVER_ID = "web";

/**
 * 接続済みアプリの API を叩く内蔵ツールのサーバー id。
 * アプリごとの API を 1 つの名前にまとめる（"app_request"）。
 */
export const APP_SERVER_ID = "app";

/** ツールを検索するツール名（サーバー id を付けない形）。 */
export const TOOL_SEARCH_TOOL = "search";

/** モデルへ渡すときの、ツールを検索するツールの名前。 */
export const TOOL_SEARCH_TOOL_NAME = `${TOOL_SERVER_ID}${TOOL_NAME_SEPARATOR}${TOOL_SEARCH_TOOL}`;

/** 見つけたツールを実行するツール名（サーバー id を付けない形）。 */
export const TOOL_CALL_TOOL = "call";

/** モデルへ渡すときの、見つけたツールを実行するツールの名前。 */
export const TOOL_CALL_TOOL_NAME = `${TOOL_SERVER_ID}${TOOL_NAME_SEPARATOR}${TOOL_CALL_TOOL}`;

/** 過去の対話履歴を検索するツール名（サーバー id を付けない形）。 */
export const HISTORY_SEARCH_TOOL = "search";

/** モデルへ渡すときの、過去の対話履歴を検索するツールの名前。 */
export const HISTORY_SEARCH_TOOL_NAME = `${HISTORY_SERVER_ID}${TOOL_NAME_SEPARATOR}${HISTORY_SEARCH_TOOL}`;

/** Web を検索するツール名（サーバー id を付けない形）。 */
export const WEB_SEARCH_TOOL = "search";

/** モデルへ渡すときの、Web を検索するツールの名前。 */
export const WEB_SEARCH_TOOL_NAME = `${WEB_SERVER_ID}${TOOL_NAME_SEPARATOR}${WEB_SEARCH_TOOL}`;

/** URL の本文を取得するツール名（サーバー id を付けない形）。 */
export const WEB_FETCH_TOOL = "fetch";

/** モデルへ渡すときの、URL の本文を取得するツールの名前。 */
export const WEB_FETCH_TOOL_NAME = `${WEB_SERVER_ID}${TOOL_NAME_SEPARATOR}${WEB_FETCH_TOOL}`;

/**
 * スキルを読み込むツール名。
 * 区切りを持たないので、プレフィックスを持つ MCP サーバーのツールとは衝突しない。
 */
export const SKILL_TOOL = "skill";

/**
 * スキル関連のツールが使う内蔵のサーバー id。
 * スキルを管理するツールは "skill_manage" になるので、MCP サーバーの id としては予約する。
 */
export const SKILL_SERVER_ID = "skill";

/** スキルを管理するツール名（サーバー id を付けない形）。 */
export const SKILL_MANAGE_TOOL = "manage";

/** モデルへ渡すときの、スキルを管理するツールの名前。 */
export const SKILL_MANAGE_TOOL_NAME = `${SKILL_SERVER_ID}${TOOL_NAME_SEPARATOR}${SKILL_MANAGE_TOOL}`;

/** 画面をユーザーへ渡すツール名（サーバー id を付けない形）。 */
export const ASK_USER_TOOL = "ask_user";

/** モデルへ渡すときの、画面を渡すツールの名前。 */
export const ASK_USER_TOOL_NAME = `${COMPUTER_SERVER_ID}${TOOL_NAME_SEPARATOR}${ASK_USER_TOOL}`;

/**
 * コンピュータのコマンドで使う秘密（API キーなど）の入力を求めるツール名（サーバー id を付けない形）。
 * 値はユーザーがチャットで入力し、モデルには渡らない。
 */
export const SET_ENV_TOOL = "set_env";

/** モデルへ渡すときの、環境変数の入力を求めるツールの名前。 */
export const SET_ENV_TOOL_NAME = `${COMPUTER_SERVER_ID}${TOOL_NAME_SEPARATOR}${SET_ENV_TOOL}`;

/**
 * アプリ（GitHub など）にトークンで接続するツール名（サーバー id を付けない形）。
 * ユーザーはチャットのカードからトークンを貼り、トークンはモデルに渡らない。
 */
export const CONNECT_APP_TOOL = "connect_app";

/** モデルへ渡すときの、アプリに接続するツールの名前。 */
export const CONNECT_APP_TOOL_NAME = `${COMPUTER_SERVER_ID}${TOOL_NAME_SEPARATOR}${CONNECT_APP_TOOL}`;

/** 接続済みアプリの API を叩くツール名（サーバー id を付けない形）。 */
export const APP_REQUEST_TOOL = "request";

/** モデルへ渡すときの、アプリの API を叩くツールの名前。 */
export const APP_REQUEST_TOOL_NAME = `${APP_SERVER_ID}${TOOL_NAME_SEPARATOR}${APP_REQUEST_TOOL}`;

/** 画像やファイルをチャットへ添付するツール名（サーバー id を付けない形）。 */
export const ATTACH_TOOL = "attach";

/** モデルへ渡すときの、添付するツールの名前。 */
export const ATTACH_TOOL_NAME = `${CHAT_SERVER_ID}${TOOL_NAME_SEPARATOR}${ATTACH_TOOL}`;

/** チャットへ UI（カード）を送るツール名（サーバー id を付けない形）。 */
export const UI_TOOL = "ui";

/** モデルへ渡すときの、UI を送るツールの名前。 */
export const UI_TOOL_NAME = `${CHAT_SERVER_ID}${TOOL_NAME_SEPARATOR}${UI_TOOL}`;

/** サーバー id とツール名から、モデルへ渡す名前を組み立てる。 */
export function toolNameFor(server: string, tool: string): string {
  return server.length === 0 ? tool : `${server}${TOOL_NAME_SEPARATOR}${tool}`;
}

/**
 * モデルへ渡す名前を、サーバー id とツール名に分ける。
 * 区切りが無い名前は、内蔵ツール（サーバーを持たない）として扱う。
 */
export function splitToolName(name: string): { server: string; tool: string } {
  const boundary = name.indexOf(TOOL_NAME_SEPARATOR);
  if (boundary === -1) return { server: "", tool: name };
  return { server: name.slice(0, boundary), tool: name.slice(boundary + 1) };
}
