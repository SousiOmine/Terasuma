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
 * アプリ（コネクタ）のツールのサーバー id。
 * 接続（app_connect_<id>）と API の呼び出し（app_request）が並ぶ。
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

/**
 * 自分の identity を読む・書き換えるツール名。
 * 区切りを持たないので、プレフィックスを持つ MCP サーバーのツールとは衝突しない。
 */
export const IDENTITY_TOOL = "identity";

/**
 * 新しい Tera を作る内蔵ツールのサーバー id。
 * ツール名は "tera_create" になるので、MCP サーバーの id としては予約する。
 */
export const TERA_SERVER_ID = "tera";

/** 新しい Tera を作るツール名（サーバー id を付けない形）。 */
export const TERA_CREATE_TOOL = "create";

/** モデルへ渡すときの、新しい Tera を作るツールの名前。 */
export const TERA_CREATE_TOOL_NAME = `${TERA_SERVER_ID}${TOOL_NAME_SEPARATOR}${TERA_CREATE_TOOL}`;

/**
 * スケジュールされた実行（ルーチン）の内蔵ツールのサーバー id。
 * ツール名は "routine_create" などになるので、MCP サーバーの id としては予約する。
 */
export const ROUTINE_SERVER_ID = "routine";

/** ルーチンを作るツール名（サーバー id を付けない形）。 */
export const ROUTINE_CREATE_TOOL = "create";

/** モデルへ渡すときの、ルーチンを作るツールの名前。 */
export const ROUTINE_CREATE_TOOL_NAME = `${ROUTINE_SERVER_ID}${TOOL_NAME_SEPARATOR}${ROUTINE_CREATE_TOOL}`;

/** ルーチンの一覧を返すツール名（サーバー id を付けない形）。 */
export const ROUTINE_LIST_TOOL = "list";

/** モデルへ渡すときの、ルーチンの一覧を返すツールの名前。 */
export const ROUTINE_LIST_TOOL_NAME = `${ROUTINE_SERVER_ID}${TOOL_NAME_SEPARATOR}${ROUTINE_LIST_TOOL}`;

/** ルーチンを更新するツール名（サーバー id を付けない形）。 */
export const ROUTINE_UPDATE_TOOL = "update";

/** モデルへ渡すときの、ルーチンを更新するツールの名前。 */
export const ROUTINE_UPDATE_TOOL_NAME = `${ROUTINE_SERVER_ID}${TOOL_NAME_SEPARATOR}${ROUTINE_UPDATE_TOOL}`;

/** ルーチンを削除するツール名（サーバー id を付けない形）。 */
export const ROUTINE_DELETE_TOOL = "delete";

/** モデルへ渡すときの、ルーチンを削除するツールの名前。 */
export const ROUTINE_DELETE_TOOL_NAME = `${ROUTINE_SERVER_ID}${TOOL_NAME_SEPARATOR}${ROUTINE_DELETE_TOOL}`;

/** ルーチンをいま実行するツール名（サーバー id を付けない形）。 */
export const ROUTINE_RUN_TOOL = "run";

/** モデルへ渡すときの、ルーチンをいま実行するツールの名前。 */
export const ROUTINE_RUN_TOOL_NAME = `${ROUTINE_SERVER_ID}${TOOL_NAME_SEPARATOR}${ROUTINE_RUN_TOOL}`;

/**
 * MCP サーバーを足す・消す内蔵ツールのサーバー id。
 * ツール名は "mcp_add_server" などになるので、MCP サーバーの id としては予約する
 * （外部のサーバーが "mcp" を名乗ると、内蔵ツールと名前が衝突するため）。
 */
export const MCP_SERVER_ID = "mcp";

/** MCP サーバーを足すツール名（サーバー id を付けない形）。 */
export const MCP_ADD_TOOL = "add_server";

/** モデルへ渡すときの、MCP サーバーを足すツールの名前。 */
export const MCP_ADD_SERVER_TOOL_NAME = `${MCP_SERVER_ID}${TOOL_NAME_SEPARATOR}${MCP_ADD_TOOL}`;

/** MCP サーバーを消すツール名（サーバー id を付けない形）。 */
export const MCP_REMOVE_TOOL = "remove_server";

/** モデルへ渡すときの、MCP サーバーを消すツールの名前。 */
export const MCP_REMOVE_SERVER_TOOL_NAME = `${MCP_SERVER_ID}${TOOL_NAME_SEPARATOR}${MCP_REMOVE_TOOL}`;

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
 * アプリ（コネクタ）に接続するツール名の、サーバー id を付けない形。
 * アプリごとに 1 つ作り、名前でアプリが決まる（例: app_connect_github）。
 */
export const CONNECT_APP_TOOL = "connect";

/** モデルへ渡す、アプリ 1 つに接続するツールの名前（例: app_connect_github）。 */
export function connectAppToolName(appId: string): string {
  return `${APP_SERVER_ID}${TOOL_NAME_SEPARATOR}${CONNECT_APP_TOOL}${TOOL_NAME_SEPARATOR}${appId}`;
}

/** ツール名が接続ツールなら、アプリ id を返す。違えば null。 */
export function connectAppIdOf(toolName: string): string | null {
  const prefix = `${APP_SERVER_ID}${TOOL_NAME_SEPARATOR}${CONNECT_APP_TOOL}${TOOL_NAME_SEPARATOR}`;
  if (!toolName.startsWith(prefix)) return null;

  const id = toolName.slice(prefix.length);
  return id.length === 0 ? null : id;
}

/** 接続済みアプリの API を叩くツール名（サーバー id を付けない形）。 */
export const APP_REQUEST_TOOL = "request";

/** モデルへ渡すときの、アプリの API を叩くツールの名前。 */
export const APP_REQUEST_TOOL_NAME = `${APP_SERVER_ID}${TOOL_NAME_SEPARATOR}${APP_REQUEST_TOOL}`;

/**
 * Discord へメッセージを送る内蔵ツールのサーバー id。
 * 送信先は Tera ごとに保存した webhook が決めるので、名前はこの 1 つにまとめる。
 */
export const DISCORD_SERVER_ID = "discord";

/**
 * Discord に接続する（webhook URL を保存する）ツール名（サーバー id を付けない形）。
 * ユーザーはチャットのカードから URL を貼り、URL はモデルに渡らない。
 */
export const DISCORD_CONNECT_TOOL = "connect";

/** モデルへ渡すときの、Discord に接続するツールの名前。 */
export const DISCORD_CONNECT_TOOL_NAME = `${DISCORD_SERVER_ID}${TOOL_NAME_SEPARATOR}${DISCORD_CONNECT_TOOL}`;

/** Discord のチャンネルへメッセージを送るツール名（サーバー id を付けない形）。 */
export const DISCORD_SEND_TOOL = "send";

/** モデルへ渡すときの、Discord へメッセージを送るツールの名前。 */
export const DISCORD_SEND_TOOL_NAME = `${DISCORD_SERVER_ID}${TOOL_NAME_SEPARATOR}${DISCORD_SEND_TOOL}`;

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
