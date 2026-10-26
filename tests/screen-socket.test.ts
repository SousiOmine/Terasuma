import { describe, expect, test } from "bun:test";
import net from "node:net";
import type { ContainerManager } from "../src/server/computer/container";
import { portOf, withServer } from "./harness";
import { createContainerStub } from "./support";

/**
 * 画面の WebSocket の門。
 *
 * WebSocket はブラウザが独自ヘッダを付けられず、CORS の制約も受けない。
 * 起動ごとのトークンを知っている画面だけが中継を開けることを確かめる。
 */

/** 画面のトークンを取る。 */
async function tokenOf(request: (path: string) => Promise<Response>): Promise<string> {
  const response = await request("/api/computer/vnc-token");
  expect(response.status).toBe(200);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return ((await response.json()) as { token: string }).token;
}

/** 生のハンドシェイクを送り、応答の 1 行目を返す。 */
function handshake(port: number, path: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";

    socket.once("connect", () => {
      const extra = Object.entries(headers)
        .map(([name, value]) => `${name}: ${value}\r\n`)
        .join("");
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\n" +
          "Connection: Upgrade\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n" +
          "Sec-WebSocket-Version: 13\r\n" +
          extra +
          "\r\n",
      );
    });
    socket.once("data", (chunk) => {
      data += chunk.toString("utf8");
      socket.destroy();
      resolve(data.split("\r\n")[0] ?? "");
    });
    socket.once("error", () => resolve("(connection error)"));
    setTimeout(() => {
      socket.destroy();
      resolve(data.split("\r\n")[0] ?? "(no response)");
    }, 1_000);
  });
}

async function withScreenServer<T>(
  container: ContainerManager,
  run: (request: (path: string) => Promise<Response>, port: number) => Promise<T>,
): Promise<T> {
  return withServer(({ request, server }) => run((path) => request(path), server.port ?? portOf(server)), {
    container,
  });
}

describe("画面の WebSocket", () => {
  test("トークンが無ければ開けない", async () => {
    await withScreenServer(createContainerStub({ vncPort: 1 }), async (_request, port) => {
      expect(await handshake(port, "/api/computer/vnc")).toContain("401");
    });
  });

  test("違うトークンでも開けない", async () => {
    await withScreenServer(createContainerStub({ vncPort: 1 }), async (request, port) => {
      await tokenOf(request); // トークンが発行されていることは前提にする。
      expect(await handshake(port, "/api/computer/vnc?token=wrong")).toContain("401");
    });
  });

  test("正しいトークンなら、コンテナが動いていなくても門は通る", async () => {
    await withScreenServer(createContainerStub(), async (request, port) => {
      const token = await tokenOf(request);
      // トークンを確かめた後、コンテナの状態で断る（401 ではない）。
      expect(await handshake(port, `/api/computer/vnc?token=${encodeURIComponent(token)}`)).toContain("409");
    });
  });

  test("正しいトークンと動いているコンテナなら、WebSocket に切り替わる", async () => {
    await withScreenServer(createContainerStub({ vncPort: 1 }), async (request, port) => {
      const token = await tokenOf(request);
      expect(await handshake(port, `/api/computer/vnc?token=${encodeURIComponent(token)}`)).toContain("101");
    });
  });

  test("subprotocol で正しいトークンを渡しても、WebSocket に切り替わる", async () => {
    await withScreenServer(createContainerStub({ vncPort: 1 }), async (request, port) => {
      const token = await tokenOf(request);
      expect(
        await handshake(port, "/api/computer/vnc", { "Sec-WebSocket-Protocol": `terasuma.vnc.${token}` }),
      ).toContain("101");
    });
  });

  test("subprotocol のトークンが違えば開けない", async () => {
    await withScreenServer(createContainerStub({ vncPort: 1 }), async (_request, port) => {
      expect(await handshake(port, "/api/computer/vnc", { "Sec-WebSocket-Protocol": "terasuma.vnc.wrong" })).toContain(
        "401",
      );
    });
  });
});
