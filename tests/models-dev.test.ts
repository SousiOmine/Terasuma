import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CATALOG_FILE_NAME,
  CATALOG_TTL_MS,
  createCatalog,
  effortValues,
  parseCatalog,
} from "../src/server/provider/catalog";
import type { FetchLike } from "../src/server/http/client";

/** models.dev の応答の形（この実装が読む部分だけ）。 */
function fixture() {
  return {
    deepseek: {
      id: "deepseek",
      name: "DeepSeek",
      doc: "https://api-docs.deepseek.com",
      npm: "@ai-sdk/openai-compatible",
      api: "https://api.deepseek.com",
      models: {
        "deepseek-v4-pro": {
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          reasoning: true,
          reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
        },
        "deepseek-v3": { id: "deepseek-v3", name: "DeepSeek V3", status: "deprecated" },
      },
    },
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      npm: "@ai-sdk/anthropic",
      env: ["ANTHROPIC_API_KEY"],
      models: {
        "claude-sonnet-4-6": { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", reasoning: true },
      },
    },
    // 依存に無いパッケージで呼ぶプロバイダは、選ばせない。
    bedrock: {
      id: "bedrock",
      name: "Bedrock",
      npm: "@ai-sdk/amazon-bedrock",
      models: { something: { id: "something", name: "Something" } },
    },
    // OpenAI 互換でも、接続先が無ければ呼べない。
    "no-api": {
      id: "no-api",
      name: "No API",
      npm: "@ai-sdk/openai-compatible",
      models: { something: { id: "something", name: "Something" } },
    },
    // アカウント固有の値が埋め込まれた接続先は、こちらでは解決できない。
    placeholder: {
      id: "placeholder",
      name: "Placeholder",
      npm: "@ai-sdk/openai-compatible",
      api: "https://${ACCOUNT_ID}.example.test/v1",
      models: { something: { id: "something", name: "Something" } },
    },
  };
}

function stubFetch(handler: () => Response) {
  let calls = 0;
  const fetchImpl: FetchLike = async () => {
    calls += 1;
    return handler();
  };

  return {
    fetch: fetchImpl,
    get calls() {
      return calls;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "terasuma-catalog-"));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("カタログの読み取り", () => {
  test("プロバイダは名前順、モデルは id 順で読む", () => {
    const snapshot = parseCatalog(fixture(), 1_000);

    expect(snapshot.fetchedAt).toBe(1_000);
    expect(snapshot.providers.map((provider) => provider.id)).toEqual(["anthropic", "deepseek"]);
    expect(snapshot.models.get("deepseek")?.map((model) => model.id)).toEqual(["deepseek-v4-pro"]);
  });

  test("非推奨のモデルは選ばせない", () => {
    const snapshot = parseCatalog(fixture(), 1_000);
    expect(snapshot.models.get("deepseek")?.some((model) => model.id === "deepseek-v3")).toBe(false);
  });

  test("依存に無いパッケージのプロバイダは落とす", () => {
    const snapshot = parseCatalog(fixture(), 1_000);
    expect(snapshot.providers.some((provider) => provider.id === "bedrock")).toBe(false);
    expect(snapshot.models.get("bedrock")).toBeUndefined();
  });

  test("接続先が分からない OpenAI 互換のプロバイダは落とす", () => {
    const snapshot = parseCatalog(fixture(), 1_000);
    expect(snapshot.providers.some((provider) => provider.id === "no-api")).toBe(false);
  });

  test("環境変数入りの接続先は、解決できないので落とす", () => {
    const snapshot = parseCatalog(fixture(), 1_000);
    expect(snapshot.providers.some((provider) => provider.id === "placeholder")).toBe(false);
  });

  test("どのパッケージで呼ぶかも読む", () => {
    const snapshot = parseCatalog(fixture(), 1_000);
    expect(snapshot.providers.find((provider) => provider.id === "deepseek")?.npm).toBe("@ai-sdk/openai-compatible");
    expect(snapshot.providers.find((provider) => provider.id === "anthropic")?.npm).toBe("@ai-sdk/anthropic");
  });

  test("思考強度の指定を読む", () => {
    const snapshot = parseCatalog(fixture(), 1_000);
    const model = snapshot.models.get("deepseek")?.[0] ?? null;

    expect(effortValues(model)).toEqual(["low", "high", "max"]);
    expect(effortValues(null)).toEqual([]);
  });

  test("オブジェクトでなければ失敗する", () => {
    expect(() => parseCatalog([], 1_000)).toThrow(/オブジェクト/);
  });
});

describe("カタログの取得とキャッシュ", () => {
  test("取得は 1 度だけ行い、2 回目はメモリのものを使う", async () => {
    await withTempDir(async (dir) => {
      const stub = stubFetch(() => jsonResponse(fixture()));
      const catalog = createCatalog({ cachePath: join(dir, CATALOG_FILE_NAME), fetchImpl: stub.fetch });

      const first = await catalog.load();
      const second = await catalog.load();

      expect(stub.calls).toBe(1);
      expect(second).toBe(first);
    });
  });

  test("取得した内容はディスクにも残り、取れないときはそれを使う", async () => {
    await withTempDir(async (dir) => {
      const cachePath = join(dir, CATALOG_FILE_NAME);
      const stub = stubFetch(() => jsonResponse(fixture()));
      await createCatalog({ cachePath, fetchImpl: stub.fetch, now: () => 1_000 }).load();

      const offline: FetchLike = async () => {
        throw new Error("offline");
      };
      const catalog = createCatalog({
        cachePath,
        fetchImpl: offline,
        now: () => 1_000 + CATALOG_TTL_MS + 1,
      });
      const snapshot = await catalog.load({ fresh: true });

      expect(snapshot.fetchedAt).toBe(1_000);
      expect(snapshot.providers).toHaveLength(2);
    });
  });

  test("TTL を過ぎたら取り直す", async () => {
    await withTempDir(async (dir) => {
      let now = 1_000;
      const stub = stubFetch(() => jsonResponse(fixture()));
      const catalog = createCatalog({
        cachePath: join(dir, CATALOG_FILE_NAME),
        fetchImpl: stub.fetch,
        now: () => now,
      });

      await catalog.load();
      await catalog.load({ fresh: true });
      expect(stub.calls).toBe(1);

      now += CATALOG_TTL_MS + 1;
      await catalog.load({ fresh: true });
      expect(stub.calls).toBe(2);
    });
  });

  test("取得もできずキャッシュも無ければ失敗する", async () => {
    await withTempDir(async (dir) => {
      const offline: FetchLike = async () => {
        throw new Error("offline");
      };
      const catalog = createCatalog({ cachePath: join(dir, CATALOG_FILE_NAME), fetchImpl: offline });

      await expect(catalog.load()).rejects.toThrow(/カタログ/);
    });
  });
});
