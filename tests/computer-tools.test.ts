import { describe, expect, test } from "bun:test";
import { asSchema } from "ai";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageRef } from "../src/shared/types";
import { createComputerToolset, createComputerTools } from "../src/server/agent/tools/computer";
import { createContainerManager, type ContainerManager, type ShellResult } from "../src/server/computer/container";
import type { EnvRequests } from "../src/server/computer/env";
import { createHandover } from "../src/server/computer/handover";
import { createImageStore, type ImageStore } from "../src/server/computer/images";
import { createEnvRequestsStub, createPodmanStub, testPng, type PodmanStubBehaviour } from "./support";

/**
 * computer ツールセットを、podman を差し替えた状態で直接呼ぶ。
 * モデルへ渡る形（AI SDK 経由）は tests/engine-tools.test.ts で確かめる。
 * 画面の撮影と xdotool の呼び出しは差し替えて、組み立てた引数を見る。
 */

type ToolContext = {
  /** 呼び出すツール一式。 */
  tools: ReturnType<typeof createComputerTools>;
  /** xdotool に渡された引数。 */
  execCalls: string[][];
  /** exec に渡された中断の signal。 */
  execSignals: (AbortSignal | undefined)[];
  /** bash -lc に渡されたスクリプト。 */
  shellCalls: string[];
  /** shell に渡された中断の signal。 */
  shellSignals: (AbortSignal | undefined)[];
  /** 環境変数の入力待ちに渡された変数名。 */
  envWaits: string[];
  images: ImageStore;
  homeDir: string;
};

type ToolBehaviour = PodmanStubBehaviour & {
  /** xdotool の呼び出し（`podman exec`）の代わりに返す結果。 */
  execResult?: ShellResult;
  /** `bash -lc` の代わりに返す結果。 */
  shell?: ShellResult;
  /** 画面の撮影の代わりに返す PNG。 */
  screenshot?: Uint8Array;
};

const OK: ShellResult = { exitCode: 0, stdout: "", stderr: "", truncated: false, timedOut: false };

async function withTools<T>(behaviour: ToolBehaviour, run: (context: ToolContext) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "terasuma-computer-"));
  const stub = createPodmanStub(behaviour);
  const base = createContainerManager({
    dataDir: dir,
    containerDir: join(dir, "container-files"),
    env: () => ({}),
    command: stub.run,
  });

  const execCalls: string[][] = [];
  const execSignals: (AbortSignal | undefined)[] = [];
  const shellCalls: string[] = [];
  const shellSignals: (AbortSignal | undefined)[] = [];

  const container: ContainerManager = {
    ...base,
    exec: async (args, options) => {
      execCalls.push([...args]);
      execSignals.push(options.signal);
      return behaviour.execResult ?? OK;
    },
    shell: async (script, options) => {
      shellCalls.push(script);
      shellSignals.push(options.signal);
      return behaviour.shell ?? OK;
    },
    screenshot: async () => behaviour.screenshot ?? testPng(1280, 800),
  };

  const images = createImageStore(dir);
  const envWaits: string[] = [];
  const env: EnvRequests = {
    async wait(_teraId, name) {
      envWaits.push(name);
      return `The user set ${name}.`;
    },
    answer() {
      return false;
    },
  };
  const tools = createComputerTools({ container, images, handover: createHandover(), env, teraId: "t1" });

  try {
    return await run({
      tools,
      execCalls,
      execSignals,
      shellCalls,
      shellSignals,
      envWaits,
      images,
      homeDir: join(dir, "container", "home"),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** ツールをモデルを介さずにそのまま呼ぶ。 */
async function callTool(
  tools: ToolContext["tools"],
  name: string,
  input: unknown,
  context: { abortSignal?: AbortSignal } = {},
): Promise<unknown> {
  const tool = tools[name];
  if (tool?.execute === undefined) throw new Error(`${name} が無い`);
  return tool.execute(input as never, context as never);
}

/** ツール名の一覧を作るときの土台。 */
function toolsetFor(behaviour: ToolBehaviour) {
  const dir = mkdtempSync(join(tmpdir(), "terasuma-computer-"));
  const stub = createPodmanStub(behaviour);
  const container = createContainerManager({
    dataDir: dir,
    containerDir: join(dir, "container-files"),
    env: () => ({}),
    command: stub.run,
  });

  return {
    provider: createComputerToolset({
      container,
      images: createImageStore(dir),
      handover: createHandover(),
      env: createEnvRequestsStub(),
    }),
    dir,
  };
}

describe("computer ツールセット", () => {
  test("ツール名は computer_ で始まる（MCP と同じ名前空間に並ぶ）", async () => {
    await withTools({}, async ({ tools }) => {
      const names = Object.keys(tools);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(name).toMatch(/^computer_/);

      // 画面を見てから操作するための一式が揃っていること。
      expect(names).toContain("computer_screenshot");
      expect(names).toContain("computer_click");
      expect(names).toContain("computer_open");
    });
  });

  test("podman が無い端末では、ツールを 1 つも渡さない", async () => {
    const { provider, dir } = toolsetFor({ podman: false });
    try {
      expect(await provider.toolset({ teraId: "t1" })).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("コンテナが止まっているだけなら、ツールは渡す（理由を伝えられるように）", async () => {
    const { provider, dir } = toolsetFor({ running: false });
    try {
      expect(Object.keys(await provider.toolset({ teraId: "t1" }))).toContain("computer_screenshot");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("画面の撮影", () => {
  test("撮った画像を保存して、大きさを返す", async () => {
    await withTools({}, async ({ tools, images }) => {
      const output = (await callTool(tools, "computer_screenshot", {})) as { text: string; images: ImageRef[] };

      expect(output.text).toBe("The screen is 1280x800 pixels.");
      expect(output.images).toHaveLength(1);
      expect(images.read(output.images[0]!)).toEqual(testPng(1280, 800));
    });
  });

  test("画像の参照は、保存した実体を指す", async () => {
    await withTools({}, async ({ tools }) => {
      const output = (await callTool(tools, "computer_screenshot", {})) as { text: string; images: ImageRef[] };
      const image = output.images[0];
      if (image === undefined) throw new Error("画像の参照が無い");

      expect(image.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(image.mime).toBe("image/png");
      expect(image.width).toBe(1280);
      expect(image.height).toBe(800);
    });
  });
});

describe("画面の操作", () => {
  test("クリックは座標へ移動してから押す", async () => {
    await withTools({}, async ({ tools, execCalls }) => {
      expect(await callTool(tools, "computer_click", { x: 100, y: 200 })).toBe("clicked left 1 time(s) at 100,200");
      expect(execCalls).toEqual([
        ["xdotool", "mousemove", "100", "200"],
        ["xdotool", "click", "--repeat", "1", "1"],
      ]);
    });
  });

  test("右クリックと連打もそのまま渡す", async () => {
    await withTools({}, async ({ tools, execCalls }) => {
      await callTool(tools, "computer_click", { x: 5, y: 6, button: "right", count: 2 });
      expect(execCalls[1]).toEqual(["xdotool", "click", "--repeat", "2", "3"]);
    });
  });

  test("ホイールは向きごとの番号で回す", async () => {
    await withTools({}, async ({ tools, execCalls }) => {
      await callTool(tools, "computer_scroll", { x: 10, y: 20, direction: "down" });
      expect(execCalls).toEqual([
        ["xdotool", "mousemove", "10", "20"],
        ["xdotool", "click", "--repeat", "3", "5"],
      ]);
    });
  });

  test("打ち込む文字はシェルを介さずそのまま渡す", async () => {
    await withTools({}, async ({ tools, execCalls }) => {
      await callTool(tools, "computer_type", { text: "こんにちは 世界; rm -rf /" });
      expect(execCalls).toEqual([["xdotool", "type", "--delay", "20", "--", "こんにちは 世界; rm -rf /"]]);
    });
  });

  test("キーは組み合わせごと渡す", async () => {
    await withTools({}, async ({ tools, execCalls }) => {
      await callTool(tools, "computer_key", { key: "ctrl+c" });
      expect(execCalls).toEqual([["xdotool", "key", "--", "ctrl+c"]]);
    });
  });

  test("ウィンドウ一覧は、入力先が分かる形に整える", async () => {
    await withTools(
      {
        shell: {
          exitCode: 0,
          stdout: [
            "active|12345|xterm|WINDOW=12345 X=0 Y=0 WIDTH=1280 HEIGHT=800 SCREEN=0",
            "window|67890|Chromium|WINDOW=67890 X=10 Y=20 WIDTH=800 HEIGHT=600 SCREEN=0",
          ].join("\n"),
          stderr: "",
          truncated: false,
          timedOut: false,
        },
      },
      async ({ tools }) => {
        expect(await callTool(tools, "computer_windows", {})).toBe(
          "* 12345 xterm at 0,0 size 1280x800\n  67890 Chromium at 10,20 size 800x600",
        );
      },
    );
  });

  test("ウィンドウが無ければ、そう返す", async () => {
    await withTools({}, async ({ tools }) => {
      expect(await callTool(tools, "computer_windows", {})).toBe("no visible windows");
    });
  });

  test("アプリの起動は、引数を引用してから切り離して走らせる", async () => {
    await withTools({}, async ({ tools, shellCalls }) => {
      expect(await callTool(tools, "computer_open", { command: "xterm", args: ["-e", "echo こんにちは; ls"] })).toBe(
        "started xterm",
      );

      expect(shellCalls).toHaveLength(1);
      expect(shellCalls[0]).toBe("nohup 'xterm' '-e' 'echo こんにちは; ls' >/dev/null 2>&1 &");
    });
  });

  test("待つのは指定した秒数だけ", async () => {
    await withTools({}, async ({ tools }) => {
      const started = Date.now();
      expect(await callTool(tools, "computer_wait", { seconds: 0.05 })).toBe("waited 0.05 second(s)");
      expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    });
  });

  test("xdotool が失敗したら、理由をそのまま投げる", async () => {
    await withTools(
      { execResult: { exitCode: 1, stdout: "", stderr: "window not found", truncated: false, timedOut: false } },
      async ({ tools }) => {
        const failure = await callTool(tools, "computer_click", { x: 1, y: 2 }).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe("window not found");
      },
    );
  });
});

describe("ターンの中断", () => {
  test("止まったターンでは、待つのをやめる", async () => {
    await withTools({}, async ({ tools }) => {
      const controller = new AbortController();
      const waiting = callTool(tools, "computer_wait", { seconds: 30 }, { abortSignal: controller.signal });
      controller.abort();

      await expect(waiting).rejects.toThrow("Stopped waiting");
    });
  });

  test("コンテナの操作には、ターンの中断がそのまま渡る", async () => {
    await withTools({}, async ({ tools, execSignals, shellSignals }) => {
      const controller = new AbortController();

      await callTool(tools, "computer_click", { x: 10, y: 20 }, { abortSignal: controller.signal });
      await callTool(tools, "computer_open", { command: "xterm" }, { abortSignal: controller.signal });

      expect(execSignals.at(-1)).toBe(controller.signal);
      expect(shellSignals.at(-1)).toBe(controller.signal);
    });
  });

  test("computer_ask_user の質問は空を許さない", async () => {
    await withTools({}, async ({ tools }) => {
      const schema = asSchema(tools["computer_ask_user"]?.inputSchema);
      if (schema.validate === undefined) throw new Error("computer_ask_user の検証が無い");

      // 空の質問だと、画面には帯も「操作を完了した」も出せない。
      const empty = await schema.validate({ question: "" });
      const filled = await schema.validate({ question: "ログインしてください" });

      expect(empty.success).toBe(false);
      expect(filled.success).toBe(true);
    });
  });

  test("computer_set_env の名前と説明は受け付けられる形に限る", async () => {
    await withTools({}, async ({ tools }) => {
      const schema = asSchema(tools["computer_set_env"]?.inputSchema);
      if (schema.validate === undefined) throw new Error("computer_set_env の検証が無い");

      expect(await schema.validate({ name: "GITHUB_TOKEN", description: "リポジトリを読むため" })).toMatchObject({
        success: true,
      });
      // 空・シェルで読めない名前・小文字始まりでない名前は通さない。
      expect(await schema.validate({ name: "", description: "x" })).toMatchObject({ success: false });
      expect(await schema.validate({ name: "1BAD", description: "x" })).toMatchObject({ success: false });
      expect(await schema.validate({ name: "GITHUB-TOKEN", description: "x" })).toMatchObject({ success: false });
      // コンピュータ自身が使う名前は、コマンドの動きを壊すのでツールからは設定できない。
      expect(await schema.validate({ name: "PATH", description: "x" })).toMatchObject({ success: false });
      // 何に使うかを書けないと、画面に理由を出せない。
      expect(await schema.validate({ name: "GITHUB_TOKEN", description: "" })).toMatchObject({ success: false });
    });
  });

  test("computer_set_env は変数名だけを待ちへ渡し、値は扱わない", async () => {
    await withTools({}, async ({ tools, envWaits }) => {
      const controller = new AbortController();
      const output = await callTool(
        tools,
        "computer_set_env",
        { name: "GITHUB_TOKEN", description: "リポジトリを読むため" },
        { abortSignal: controller.signal },
      );

      expect(envWaits).toEqual(["GITHUB_TOKEN"]);
      expect(output).toBe("The user set GITHUB_TOKEN.");
      // 説明文は画面へ流れるだけで、ツールの戻り値（モデルの文脈）には現れない。
      expect(String(output)).not.toContain("リポジトリ");
    });
  });

  test("computer_set_env は中断を受け取れないと待たない", async () => {
    await withTools({}, async ({ tools }) => {
      await expect(callTool(tools, "computer_set_env", { name: "GITHUB_TOKEN", description: "x" })).rejects.toThrow(
        /abort signal/,
      );
    });
  });
});
