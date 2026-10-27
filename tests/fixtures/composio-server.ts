import type { Server } from "bun";
import type { TokenConnectorProvider } from "../../src/server/connectors/providers";

/**
 * テストで使う Composio の API サーバー。
 *
 * `/api/v3.1/tools`（検索）と `/api/v3.1/tools/execute/<slug>`（実行）だけを持つ。
 * キーは x-api-key で受け取り、Bearer を併せて送られても受け付けない
 * （本物の Composio は複数の認証方式を同時に渡すと 401 で断る）。
 */
export type FakeComposioServer = {
  server: Server<undefined>;
  /** サーバーの origin。プロバイダ定義の URL を組み立てる。 */
  readonly origin: string;
  /** 受け付ける API キー。 */
  readonly apiKey: string;
  /** 受け取った要求の記録（検証用）。 */
  readonly requests: { method: string; path: string; body: string | null }[];
};

export function startFakeComposioServer(): FakeComposioServer {
  let origin = "";
  const apiKey = "ak_test_key";
  const requests: { method: string; path: string; body: string | null }[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/v3.1/")) return new Response("not found", { status: 404 });

      const body = request.method === "POST" ? await request.text() : null;

      // 本物と同じく、キーが違えば 401 の JSON を返す。
      if (request.headers.get("x-api-key") !== apiKey) {
        return Response.json(
          { error: { message: "Invalid API key", code: 801, slug: "APIKey_InvalidAPIKey", status: 401 } },
          { status: 401 },
        );
      }

      // 保存前の確認（GET /tools?limit=1）は、ツールの呼び出しと区別するため記録しない。
      if (url.pathname === "/api/v3.1/tools" && url.searchParams.get("limit") === "1") {
        return Response.json({ items: [], total_items: 0 });
      }

      requests.push({ method: request.method, path: url.pathname, body });

      if (url.pathname === "/api/v3.1/tools") {
        const query = url.searchParams.get("query") ?? "";
        if (query === "") return Response.json({ items: [], total_items: 0 });

        return Response.json({
          items: [
            {
              slug: "GITHUB_CREATE_ISSUE",
              name: "Create an issue",
              description: "Create an issue in a GitHub repository.",
              toolkit: { slug: "github", name: "GitHub" },
              input_parameters: {
                owner: { type: "string", description: "Repository owner", required: true },
                repo: { type: "string", description: "Repository name", required: true },
                title: { type: "string", description: "Issue title", required: true },
                body: { type: "string", description: "Issue body", required: false },
              },
            },
          ],
          total_items: 1,
        });
      }

      if (url.pathname === "/api/v3.1/tools/execute/GITHUB_CREATE_ISSUE" && request.method === "POST") {
        return Response.json({
          data: { number: 7, url: "https://example.test/issues/7" },
          error: null,
          successful: true,
        });
      }

      // 実行したが失敗した場合（HTTP は 200）。
      if (url.pathname === "/api/v3.1/tools/execute/GITHUB_BAD" && request.method === "POST") {
        return Response.json({ data: {}, error: "Repository not found", successful: false });
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/v3.1/tools/")) {
        return Response.json({
          slug: "GITHUB_CREATE_ISSUE",
          description: "Create an issue in a GitHub repository.",
          input_parameters: {},
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  origin = server.url.origin;

  return {
    server,
    get origin() {
      return origin;
    },
    apiKey,
    requests,
  };
}

/** テスト用の Composio コネクタ。宛先だけを偽サーバーへ向ける。 */
export function fakeComposioProvider(server: FakeComposioServer): TokenConnectorProvider {
  return {
    kind: "token",
    id: "composio",
    name: "Composio",
    description: "test composio",
    setupUrl: `${server.origin}/setup`,
    token: {
      label: "Project API key",
      description: "test key",
      placeholder: "ak_...",
    },
    permissions: [],
    needs: "a Composio project API key",
    env: [],
    usage: "Use app_composio_search, then app_composio_execute.",
    api: {
      baseUrl: `${server.origin}/api/v3.1`,
      headers: { Accept: "application/json" },
      auth: { header: "x-api-key", prefix: "" },
      verify: { path: "/tools?limit=1", field: null },
    },
  };
}
