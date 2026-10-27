import { describe, expect, test } from "bun:test";
import { posix } from "node:path";
import { WORKDIR_IN_CONTAINER } from "../src/server/computer/contract";
import { createConnectors, type ConnectorScriptResult } from "../src/server/connectors/manager";
import type { PiRuntime } from "../src/server/connectors/pi";
import type { ConnectorsView } from "../src/shared/api/settings";
import { type ServerHarness, withServer } from "./harness";
import {
  fakeProgramProvider,
  fakeProvider,
  startFakeConnectorServer,
  type FakeConnectorServer,
} from "./fixtures/connector-server";

/**
 * コネクタの HTTP API。
 * トークンは偽の API サーバーで検証する。
 * Discord は Tera ごとの webhook なので、ここではなく tests/discord-api.test.ts が確かめる。
 */

type Run = (harness: ServerHarness, server: FakeConnectorServer) => Promise<void>;

/** 偽の接続先を宛先にしたコネクタマネージャで、サーバを起こす。 */
async function withConnectorServer(run: Run): Promise<void> {
  const server = startFakeConnectorServer();
  try {
    await withServer((harness) => run(harness, server), {
      connectors: ({ dir }) => createConnectors({ dataDir: dir, providers: [fakeProvider(server)] }),
    });
  } finally {
    await server.server.stop(true);
  }
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

const AGENT_DIR = posix.join(WORKDIR_IN_CONTAINER, ".pi", "agent");
const AUTH_PATH = posix.join(AGENT_DIR, "auth.json");
const SETTINGS_PATH = posix.join(AGENT_DIR, "settings.json");

type FakePiRuntime = {
  runtime: PiRuntime;
  files: Map<string, string>;
  writes: { path: string; text: string }[];
};

function ok(stdout = ""): ConnectorScriptResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

function successCheck(): ConnectorScriptResult {
  return ok(
    `${JSON.stringify({
      type: "message_end",
      message: { stopReason: "stop", content: [{ type: "text", text: "OK" }] },
    })}\n`,
  );
}

/** コンピュータの読み書きと実行を、メモリ上で真似る。 */
function fakePiRuntime(check: ConnectorScriptResult = successCheck()): FakePiRuntime {
  const files = new Map<string, string>();
  const writes: { path: string; text: string }[] = [];

  const runtime: PiRuntime = {
    async run(script) {
      if (script === "pi --version") return ok("1.3.0\n");
      if (script.startsWith("chmod ")) return ok();
      return check;
    },
    async readText(path) {
      return files.get(path) ?? null;
    },
    async writeText(path, text) {
      writes.push({ path, text });
      files.set(path, text);
    },
  };

  return { runtime, files, writes };
}

/** program コネクタと偽のコンピュータで、サーバを起こす。 */
async function withProgramConnectorServer(
  fake: FakePiRuntime,
  request: (harness: ServerHarness) => Promise<void>,
): Promise<void> {
  await withServer(request, {
    connectors: ({ dir }) =>
      createConnectors({ dataDir: dir, providers: [fakeProgramProvider()], runtime: () => fake.runtime }),
  });
}

/** 一覧を読む。 */
async function connectors(harness: ServerHarness): Promise<ConnectorsView> {
  const response = await harness.request("/api/connectors");
  expect(response.status).toBe(200);
  return (await response.json()) as ConnectorsView;
}

describe("コネクタの API", () => {
  test("一覧は未設定の状態を返す", async () => {
    await withConnectorServer(async (harness) => {
      const view = await connectors(harness);

      expect(view.providers).toHaveLength(1);
      expect(view.providers[0]).toMatchObject({
        id: "github",
        name: "GitHub",
        account: null,
        detail: null,
      });
      expect(view.providers[0]?.env).toEqual(["GH_TOKEN", "GITHUB_TOKEN"]);
      expect(view.providers[0]?.token?.label).toBe("Personal Access Token");
    });
  });

  test("トークンを保存すると、接続済みとして返す", async () => {
    await withConnectorServer(async (harness, server) => {
      const response = await harness.request(
        "/api/connectors/github/token",
        jsonRequest("PUT", { token: `  ${server.accessToken}  ` }),
      );

      expect(response.status).toBe(200);
      const provider = ((await response.json()) as ConnectorsView).providers[0];
      expect(provider).toMatchObject({
        connected: true,
        account: server.account,
      });
    });
  });

  test("受け付けられないトークンは 400", async () => {
    await withConnectorServer(async (harness) => {
      const response = await harness.request("/api/connectors/github/token", jsonRequest("PUT", { token: "wrong" }));

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("invalid_request");
    });
  });

  test("空のトークンは 400", async () => {
    await withConnectorServer(async (harness) => {
      const response = await harness.request("/api/connectors/github/token", jsonRequest("PUT", { token: "  " }));

      expect(response.status).toBe(400);
    });
  });

  test("保存したトークンを切断すると消える", async () => {
    await withConnectorServer(async (harness, server) => {
      await harness.request("/api/connectors/github/token", jsonRequest("PUT", { token: server.accessToken }));

      const removed = await harness.request("/api/connectors/github", { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect(((await removed.json()) as ConnectorsView).providers[0]?.account).toBeNull();
    });
  });

  test("知らないコネクタは 404", async () => {
    await withConnectorServer(async (harness) => {
      const response = await harness.request("/api/connectors/unknown/token", jsonRequest("PUT", { token: "x" }));

      expect(response.status).toBe(404);
      expect(((await response.json()) as { code: string }).code).toBe("connector_not_found");
    });
  });

  test("コネクタの待ちを中止できる", async () => {
    await withConnectorServer(async (harness) => {
      const response = await harness.request("/api/connectors/github/wait", { method: "DELETE" });

      expect(response.status).toBe(200);
      expect(((await response.json()) as ConnectorsView).providers[0]?.connected).toBe(false);
    });
  });

  test("本文の設定を書いて接続すると、状態つきで接続済みになる", async () => {
    const fake = fakePiRuntime();
    await withProgramConnectorServer(fake, async (harness) => {
      const response = await harness.request(
        "/api/connectors/pi/connect",
        jsonRequest("POST", { provider: "anthropic", apiKey: "  sk-test  ", model: "" }),
      );

      expect(response.status).toBe(200);
      const provider = ((await response.json()) as ConnectorsView).providers[0];
      expect(provider).toMatchObject({
        kind: "program",
        connected: true,
        token: null,
        status: "pi 1.3.0 (anthropic/claude-sonnet-4-5)",
      });
      expect(provider?.setup?.provider.value).toBe("anthropic");
      expect(provider?.setup?.model.value).toBe("claude-sonnet-4-5");

      expect(JSON.parse(fake.files.get(AUTH_PATH) ?? "{}")).toEqual({
        anthropic: { type: "api_key", key: "sk-test" },
      });
      expect(JSON.parse(fake.files.get(SETTINGS_PATH) ?? "{}")).toMatchObject({
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-5",
      });
    });
  });

  test("設定を書いても確かめられなければ 400 で、記録を残さない", async () => {
    const fake = fakePiRuntime(
      ok(
        `${JSON.stringify({
          type: "message_end",
          message: { stopReason: "error", errorMessage: "401 unauthorized" },
        })}\n`,
      ),
    );
    await withProgramConnectorServer(fake, async (harness) => {
      const response = await harness.request(
        "/api/connectors/pi/connect",
        jsonRequest("POST", { provider: "anthropic", apiKey: "sk-test" }),
      );

      expect(response.status).toBe(400);
      const body = (await response.json()) as { code: string; detail: string };
      expect(body.code).toBe("invalid_request");
      expect(body.detail).toContain("401 unauthorized");

      const view = await connectors(harness);
      expect(view.providers[0]?.connected).toBe(false);
    });
  });

  test("本文なしなら、いまの設定を確かめるだけ", async () => {
    const fake = fakePiRuntime();
    fake.files.set(
      SETTINGS_PATH,
      `${JSON.stringify({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5" })}\n`,
    );

    await withProgramConnectorServer(fake, async (harness) => {
      const response = await harness.request("/api/connectors/pi/connect", { method: "POST" });

      expect(response.status).toBe(200);
      const provider = ((await response.json()) as ConnectorsView).providers[0];
      expect(provider).toMatchObject({
        connected: true,
        status: "pi 1.3.0 (anthropic/claude-sonnet-4-5)",
      });
      expect(fake.writes).toEqual([]);
    });
  });

  test("program コネクタにトークンは保存できない（400）", async () => {
    await withProgramConnectorServer(fakePiRuntime(), async (harness) => {
      const response = await harness.request("/api/connectors/pi/token", jsonRequest("PUT", { token: "x" }));

      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe("invalid_request");
    });
  });
});
