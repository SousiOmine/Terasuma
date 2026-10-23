import index from "../../client/index.html";
import { OAUTH_CALLBACK_PATH } from "../mcp/oauth";
import type { ApiHandlers } from "./handlers";
import type { WithErrorHandling } from "./respond";
import type { ScreenSocket } from "./screen-socket";

/**
 * API のルート表。
 *
 * Bun の routes はリテラルのパスからパラメータの型を作るので、表はここでリテラルのまま並べる。
 * ハンドラ名は ApiHandlers で型検査し、表とハンドラの対応は tests/architecture.test.ts が突き合わせる。
 */
export function createRoutes(api: WithErrorHandling<ApiHandlers>, screen: ScreenSocket) {
  return {
    "/": index,
    // Tera（会話の持ち主）と、その 1 本の履歴。
    "/api/teras": {
      GET: api.listTeras,
    },
    "/api/teras/:id/messages": {
      GET: api.listMessages,
      POST: api.sendMessage,
    },
    // 応答を生成しているターンの途中へ、発言を足す（終わっていれば 409）。
    "/api/teras/:id/steer": {
      POST: api.steerTurn,
    },
    // 生成中のターンを、ここで打ち切る（それまでの本文や添付は保存される）。
    "/api/teras/:id/stop": {
      POST: api.stopTurn,
    },
    // エージェントが送った画像・ファイル。URL は中身のハッシュから決まる。
    "/api/images/:file": {
      GET: api.readImage,
    },
    "/api/files/:id": {
      GET: api.readFile,
    },
    "/api/model": {
      GET: api.readModelSettings,
      PUT: api.setDefaultModel,
    },
    "/api/model/reasoning": {
      GET: api.readReasoning,
      PUT: api.setReasoning,
    },
    "/api/model/catalog": {
      GET: api.listCatalogProviders,
    },
    "/api/model/catalog/:id/models": {
      GET: api.listCatalogModels,
    },
    "/api/model/check": {
      POST: api.checkProvider,
    },
    "/api/model/providers": {
      POST: api.addProvider,
    },
    "/api/model/providers/:id": {
      PATCH: api.updateProvider,
      DELETE: api.removeProvider,
    },
    "/api/model/providers/:id/models": {
      GET: api.listProviderModels,
    },
    "/api/mcp/servers": {
      GET: api.listMcpServers,
      POST: api.addMcpServer,
    },
    // 追加の前に、入力された設定で繋がるかを確かめる（設定には書かない）。
    "/api/mcp/test": {
      POST: api.testMcpServer,
    },
    "/api/mcp/servers/:id": {
      PATCH: api.updateMcpServer,
      DELETE: api.removeMcpServer,
    },
    "/api/mcp/servers/:id/check": {
      POST: api.checkMcpServer,
    },
    "/api/mcp/servers/:id/authorize": {
      POST: api.authorizeMcpServer,
      DELETE: api.cancelMcpAuthorization,
    },
    // アプリの接続。トークンの保存と、保存待ちの中止。
    "/api/connections": {
      GET: api.listConnections,
    },
    "/api/connections/:id": {
      DELETE: api.disconnectConnection,
    },
    "/api/connections/:id/token": {
      PUT: api.setConnectionToken,
    },
    "/api/connections/:id/wait": {
      DELETE: api.cancelConnectionWait,
    },
    // Discord の webhook（Tera ごとに 1 つ）。保存する前に、その URL の webhook を確かめる。
    "/api/discord": {
      GET: api.readDiscord,
    },
    "/api/discord/:teraId": {
      PUT: api.setDiscordWebhook,
      DELETE: api.clearDiscordWebhook,
    },
    "/api/discord/:teraId/wait": {
      DELETE: api.cancelDiscordWait,
    },
    // Web 検索のプロバイダ。保存前の確認は接続先へ 1 回検索を投げる。
    "/api/websearch": {
      GET: api.readWebSearch,
    },
    "/api/websearch/test": {
      POST: api.testWebSearchProvider,
    },
    "/api/websearch/providers": {
      POST: api.addWebSearchProvider,
    },
    "/api/websearch/providers/:id": {
      PATCH: api.updateWebSearchProvider,
      DELETE: api.removeWebSearchProvider,
    },
    "/api/websearch/default": {
      PUT: api.setDefaultWebSearchProvider,
    },
    "/api/container": {
      GET: api.readContainer,
    },
    "/api/container/start": {
      POST: api.startContainer,
    },
    "/api/container/reset": {
      POST: api.resetContainer,
    },
    // 画面の中継。noVNC の HTML と JS をコンテナから取ってきて返す。
    "/api/computer/screen/*": {
      GET: api.relayScreen,
    },
    // 画面の操作。ブラウザと、コンテナの中の x11vnc を繋ぐ。
    // 引き受け（画面を渡している間）の返事。
    "/api/computer/handover": {
      POST: api.answerHandover,
    },
    // コンピュータのコマンドへ渡す環境変数。値は返さず、名前だけを扱う。
    "/api/computer/env": {
      GET: api.listEnv,
    },
    // 待っている環境変数の入力。値はこの経路でだけ受け取り、モデルへは返さない。
    "/api/computer/env/answer": {
      POST: api.answerEnv,
    },
    "/api/computer/env/:name": {
      DELETE: api.deleteEnv,
    },
    "/api/computer/vnc": {
      GET: screen.upgrade,
    },
    // 認可のコールバックは、OAuth 側が組み立てる URL（OAUTH_CALLBACK_PATH）と同じパスに置く。
    [OAUTH_CALLBACK_PATH]: {
      GET: api.mcpOAuthCallback,
    },
  };
}
