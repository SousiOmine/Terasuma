import { describe, expect, test } from "bun:test";
import { MAX_IDENTITY_CHARS } from "../src/server/agent/identity";
import { createIdentityTools } from "../src/server/agent/tools/identity";
import { DEFAULT_TERA_ID, DEFAULT_TERA_IDENTITY, type Store } from "../src/server/data/store";
import { makeStore } from "./support";

/**
 * identity ツール。
 * モデルを介さずに直接呼び、書いた版と system プロンプト用の版の扱いを確かめる。
 */

function identityTool(store: Store) {
  const definition = createIdentityTools({ store, teraId: DEFAULT_TERA_ID }).identity;
  if (definition === undefined) throw new Error("identity ツールが無い");
  return definition;
}

async function call(store: Store, input: { action: "read" | "write"; content?: string }): Promise<string> {
  const definition = identityTool(store);
  if (definition.execute === undefined) throw new Error("identity ツールの実行が無い");
  return (await definition.execute(input as never, { toolCallId: "call-1" } as never)) as string;
}

describe("identity ツール", () => {
  test("既定の役割は、そのまま system プロンプトの版として読める", async () => {
    const store = makeStore();
    const text = await call(store, { action: "read" });

    expect(text).toContain("this is the version in your system prompt");
    expect(text).toContain(DEFAULT_TERA_IDENTITY);
  });

  test("書いただけでは system プロンプトの版は変わらず、読み直すと 2 つに分かれる", async () => {
    const store = makeStore();
    const written = await call(store, { action: "write", content: "  # Role\n新しい役割  " });

    expect(written).toContain("The system prompt still has the previous version");
    // 前後の空白は落として保存する。
    expect(store.readIdentity(DEFAULT_TERA_ID).content).toBe("# Role\n新しい役割");
    expect(store.readIdentity(DEFAULT_TERA_ID).applied).toBe(DEFAULT_TERA_IDENTITY);

    const text = await call(store, { action: "read" });
    expect(text).toContain("not in your system prompt yet");
    expect(text).toContain("# Role\n新しい役割");
    expect(text).toContain(DEFAULT_TERA_IDENTITY);
  });

  test("切り替えたあとは、1 つの版として読める", async () => {
    const store = makeStore();
    await call(store, { action: "write", content: "# Role\n新しい役割" });
    store.applyIdentity(DEFAULT_TERA_ID);

    const text = await call(store, { action: "read" });
    expect(text).toContain("this is the version in your system prompt");
    expect(text).not.toContain("not in your system prompt yet");
    expect(text).toContain("# Role\n新しい役割");
  });

  test("空文字で消せる。切り替えたあとは、まだ無いことを返す", async () => {
    const store = makeStore();
    const cleared = await call(store, { action: "write", content: "   " });

    expect(cleared).toContain("Your identity was cleared");
    expect(store.readIdentity(DEFAULT_TERA_ID).content).toBe("");
    // 切り替えるまでは、前の版が system プロンプトに残る。
    expect(store.readIdentity(DEFAULT_TERA_ID).applied).toBe(DEFAULT_TERA_IDENTITY);

    store.applyIdentity(DEFAULT_TERA_ID);
    expect(await call(store, { action: "read" })).toContain("You have no identity yet.");
  });

  test("長すぎる identity は、上限を添えて断る", async () => {
    const store = makeStore();

    await expect(call(store, { action: "write", content: "a".repeat(MAX_IDENTITY_CHARS + 1) })).rejects.toThrow(
      String(MAX_IDENTITY_CHARS),
    );
  });

  test("write に content が無ければ、消す方法を添えて断る", async () => {
    const store = makeStore();

    await expect(call(store, { action: "write" })).rejects.toThrow('action "write" needs content');
  });
});
