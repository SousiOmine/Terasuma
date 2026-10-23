import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE_NAME } from "../src/config";
import type { FileSettings } from "../src/server/data/settings";
import type {
  CommandBytesResult,
  CommandByteRunner,
  CommandResult,
  CommandRunner,
} from "../src/server/computer/command";
import { ContainerError, type ContainerManager } from "../src/server/computer/container";
import type {
  AttachmentToolsetProvider,
  CodingToolsetProvider,
  ComputerToolsetProvider,
  HistoryToolsetProvider,
  TeraToolsetProvider,
  WebSearchToolsetProvider,
} from "../src/server/agent/contracts";
import type { EnvRequests } from "../src/server/computer/env";
import type { LoadedSkill, Skill, SkillFileStore } from "../src/server/agent/skill-types";
import type { ImageStore } from "../src/server/computer/images";
import type { McpManager } from "../src/server/mcp/manager";
import type { ConnectorToolsetProvider } from "../src/server/connectors/tools";
import type { ConnectorsManager } from "../src/server/connectors/manager";
import type { DiscordToolsetProvider } from "../src/server/discord/tools";
import type { WebSearchManager } from "../src/server/websearch-manager";
import { createSettingsStore, type SettingsStore } from "../src/server/data/settings";
import { createStore, type Store, type TeraIdentity } from "../src/server/data/store";
import { createCompaction, type Compaction } from "../src/server/agent/compaction";
import type { IdentityStore } from "../src/server/agent/identity";
import type { ContainerStatusView } from "../src/shared/api/settings";

/** 時刻を固定したストア。updated_at の比較を決定的にするため。 */
export function makeStore() {
  let tick = 1_000;
  return createStore(":memory:", { now: () => (tick += 1) });
}

/**
 * MCP を使わないテストのための差し替え。
 * 接続も子プロセスも持たず、常に「まだ何も確かめていない」状態を返す。
 */
export function createMcpStub(): McpManager {
  const unknown = { state: "unknown", tools: [], detail: null } as const;

  return {
    status: () => unknown,
    check: async () => unknown,
    test: async () => ({ ...unknown, authorizationUrl: null }),
    toolset: async () => ({}),
    authorize: async () => ({ url: null }),
    cancelAuthorization: () => undefined,
    completeAuthorization: async () => ({ serverId: "stub" }),
    close: async () => undefined,
  };
}

/**
 * 環境変数の入力を待たないテストのための差し替え。
 * 待ちに入っても何も起きず、返事も受け取らない（チャットの入力欄を使わないテスト用）。
 */
export function createEnvRequestsStub(): EnvRequests {
  return {
    async wait(_teraId, name) {
      return `The user set ${name}.`;
    },
    answer() {
      return false;
    },
  };
}

/**
 * コンテナを使わないテストのための差し替え。
 * podman を呼ばず、常に「podman が無い」状態を返す。
 * vncPort を渡すと「動いている」状態になり、画面の中継のテストに使える。
 */
export function createContainerStub(options: { vncPort?: number } = {}): ContainerManager {
  const view: ContainerStatusView =
    options.vncPort === undefined
      ? { state: "podman_missing", vncPort: null, detail: null }
      : { state: "running", vncPort: options.vncPort, detail: null };

  return {
    status: async () => view,
    start: async () => view,
    reset: async () => view,
    shell: async () => {
      throw new ContainerError("container_not_running", "テスト用の差し替えでは実行できません");
    },
    exec: async () => {
      throw new ContainerError("container_not_running", "テスト用の差し替えでは実行できません");
    },
    readFile: async () => {
      throw new ContainerError("container_not_running", "テスト用の差し替えでは読めません");
    },
    writeFile: async () => {
      throw new ContainerError("container_not_running", "テスト用の差し替えでは書けません");
    },
    screenshot: async () => {
      throw new ContainerError("container_not_running", "テスト用の差し替えでは実行できません");
    },
  };
}

/** 画像を扱わないテストのための差し替え。 */
export function createImageStub(): ImageStore {
  return {
    save: () => {
      throw new Error("テスト用の差し替えでは画像を保存できません");
    },
    read: () => null,
    readByName: () => null,
  };
}

/** コンテナのツールを渡さないテストのための差し替え。 */
export function createComputerStub(): ComputerToolsetProvider {
  return { toolset: async () => ({}) };
}

/** 添付のツールを渡さないテストのための差し替え。 */
export function createAttachmentsStub(): AttachmentToolsetProvider {
  return { toolset: () => ({}) };
}

/** 履歴検索のツールを渡さないテストのための差し替え。 */
export function createHistoryStub(): HistoryToolsetProvider {
  return { toolset: () => ({}) };
}

/** ファイルを使わないテストのための、スキルの置き場。 */
export function createSkillFileStoreStub(initial: readonly Skill[] = []): SkillFileStore {
  const skills = new Map(initial.map((skill) => [skill.name, skill]));

  const loaded = (skill: Skill): LoadedSkill => ({
    ...skill,
    dir: `/home/agent/.agents/skills/${skill.name}`,
    resources: [],
    resourcesTruncated: false,
  });

  return {
    scan: () => ({ skills: [...skills.values()], problems: [] }),
    get: (name) => {
      const skill = skills.get(name);
      return skill === undefined ? null : loaded(skill);
    },
    create: (input) => {
      if (skills.has(input.name)) throw new Error(`A skill named "${input.name}" already exists.`);
      const skill = { name: input.name, description: input.description, content: input.content };
      skills.set(skill.name, skill);
      return loaded(skill);
    },
    update: (name, patch) => {
      const skill = skills.get(name);
      if (skill === undefined) throw new Error(`No skill named "${name}" was created.`);
      const next = {
        ...skill,
        ...(patch.description === undefined ? {} : { description: patch.description }),
        ...(patch.content === undefined ? {} : { content: patch.content }),
      };
      skills.set(name, next);
      return loaded(next);
    },
    delete: (name) => skills.delete(name),
  };
}

/**
 * identity を持たないテストのための差し替え（エンジン用）。
 * applied を渡すと、その版が system プロンプトに載る。
 */
export function createIdentityStoreStub(initial: TeraIdentity = { content: "", applied: "" }): IdentityStore {
  const identity: TeraIdentity = { ...initial };

  return {
    readIdentity: () => ({ ...identity }),
    writeIdentity: (_teraId, content) => {
      identity.content = content;
      return { ...identity };
    },
  };
}

/** Web 検索のツールを渡さないテストのための差し替え（エンジン用）。 */
export function createWebSearchToolsStub(): WebSearchToolsetProvider {
  return { toolset: () => ({}) };
}

/** コネクタのツールを渡さないテストのための差し替え（エンジン用）。 */
export function createConnectorToolsStub(): ConnectorToolsetProvider {
  return { toolset: () => ({}) };
}

/** Discord のツールを渡さないテストのための差し替え（エンジン用）。 */
export function createDiscordToolsStub(): DiscordToolsetProvider {
  return { toolset: () => ({}) };
}

/** 新しい Tera を作るツールを渡さないテストのための差し替え（エンジン用）。 */
export function createTeraToolsStub(): TeraToolsetProvider {
  return { toolset: () => ({}) };
}

/**
 * 接続を持たないテストのための差し替え。
 * ツール名を数えるだけの用途（プロバイダを引こうとすると失敗する）。
 */
export function createConnectorsStub(): ConnectorsManager {
  const empty = { providers: [] };
  return {
    view: () => empty,
    provider() {
      throw new Error("No connector providers in this stub");
    },
    ids: () => [],
    setToken: async () => empty,
    cancelWait: () => undefined,
    disconnect: () => empty,
    wait: async () => "",
    token: () => null,
    env: () => ({}),
    close: () => undefined,
  };
}

/**
 * Web 検索を使わないテストのための差し替え。
 * 既定のプロバイダを持たず、接続確認は常に成功として返す。
 */
export function createWebSearchStub(): WebSearchManager {
  return {
    provider: () => null,
    test: async () => ({ ok: true, detail: null, results: 0 }),
  };
}

/** 端末のツールを渡さないテストのための差し替え。 */
/** コンテナのファイルとシェルを渡さないテストのための差し替え。 */
export function createCodingStub(): CodingToolsetProvider {
  return { toolset: () => ({}) };
}

/**
 * サーバを起こすだけのテストのための圧縮。ストアは本物を使い、要約の呼び出しだけを持たない。
 * 閾値（文脈長から余白を引いた線）に届かない履歴しかしないテストでは、走らない。
 * 文脈の組み立て（要約 + まだ畳んでいない履歴）は本番と同じものを通す。
 */
export function createCompactionStub(store: Store): Compaction {
  return createCompaction({
    store,
    engine: {
      complete: () => {
        throw new Error("テスト用の差し替えでは要約を作れません");
      },
    },
    log: () => undefined,
    // 文脈長が分からないモデルの見積もり（12.8 万トークン）で動かす。
    contextLimit: () => null,
  });
}

/** podman を差し替えるときに決める初期状態。 */
export type PodmanStubBehaviour = {
  /** podman が入っているかどうか。 */
  podman?: boolean;
  image?: boolean;
  container?: boolean;
  running?: boolean;
  /** `podman port` が返す行。動いているときの既定は "127.0.0.1:45678"。 */
  port?: string;
  /** build / run / start / rm / screenshot のどれかを失敗させる。 */
  fail?: "build" | "run" | "start" | "rm" | "screenshot";
  /** 画面の撮影が返す PNG。省くと 2x2 の PNG。 */
  screenshot?: Uint8Array;
  /** `podman exec` の結果。 */
  exec?: { code: number; stdout: string; stderr: string; truncated?: boolean; timedOut?: boolean };
};

/**
 * podman の応答を差し替える。
 * 状態はコマンドで変わる（build すればイメージができ、stop すれば止まる）ので、
 * 呼び出し側は実際の podman と同じ順番で状態が動くことを確かめられる。
 */
export function createPodmanStub(initial: PodmanStubBehaviour = {}): {
  run: CommandRunner;
  /** 画面の撮影のように、バイト列を返す呼び出し。 */
  runBytes: CommandByteRunner;
  calls: string[][];
  /** 各呼び出しに渡された標準入力。 */
  inputs: (string | Uint8Array | undefined)[];
} {
  const { podman = true, port = "127.0.0.1:45678" } = initial;
  const calls: string[][] = [];
  const inputs: (string | Uint8Array | undefined)[] = [];

  const state = {
    image: initial.image ?? true,
    container: initial.container ?? true,
    running: initial.running ?? true,
  };

  const result = (code: number, stdout = "", stderr = ""): CommandResult => ({
    code,
    stdout,
    stderr,
    truncated: false,
    timedOut: false,
  });

  const run: CommandRunner = async (cmd, options) => {
    calls.push([...cmd]);
    inputs.push(options.stdin);
    const [command, sub] = cmd;
    if (command !== "podman") return result(127, "", `unknown command: ${command}`);

    switch (sub) {
      case "--version":
        return podman ? result(0, "podman version 4.9.3\n") : result(127, "", "podman: command not found");

      case "image":
        return state.image ? result(0) : result(1, "", "no such image");

      case "container":
        return state.container ? result(0) : result(1, "", "no such container");

      case "inspect":
        if (!state.container) return result(125, "", "no such container");
        return result(0, state.running ? "running\n" : "exited\n");

      case "port":
        return state.running ? result(0, `${port}\n`) : result(125, "", "container is not running");

      case "build":
        if (initial.fail === "build") return result(125, "", "ミラーに届きません");
        state.image = true;
        return result(0, "Successfully tagged");

      case "run":
        if (initial.fail === "run") return result(125, "", "名前が使われています");
        state.container = true;
        state.running = true;
        return result(0, "container-id\n");

      case "start":
        if (initial.fail === "start") return result(125, "", "起動できません");
        state.running = true;
        return result(0, "terasuma\n");

      case "rm":
        if (initial.fail === "rm") return result(125, "", "消せません");
        state.container = false;
        state.running = false;
        return result(0, "terasuma\n");

      case "exec": {
        // 起動時の契約確認（DISPLAY・uid・gid・作業ディレクトリ）が通る既定値。
        const exec = initial.exec ?? { code: 0, stdout: ":99\n1000\n1000\n/home/agent\nok", stderr: "" };
        return {
          code: exec.code,
          stdout: exec.stdout,
          stderr: exec.stderr,
          truncated: exec.truncated ?? false,
          timedOut: exec.timedOut ?? false,
        };
      }

      default:
        return result(125, "", `unhandled: ${cmd.join(" ")}`);
    }
  };

  const runBytes: CommandByteRunner = async (cmd) => {
    calls.push([...cmd]);

    const bytes = (value: Partial<CommandBytesResult> = {}): CommandBytesResult => ({
      code: 0,
      stdout: new Uint8Array(),
      stderr: "",
      timedOut: false,
      truncated: false,
      ...value,
    });

    const [command, sub] = cmd;
    if (command !== "podman") return bytes({ code: 127, stderr: `unknown command: ${command}` });
    if (sub !== "exec") return bytes({ code: 125, stderr: `unhandled: ${cmd.join(" ")}` });
    if (initial.fail === "screenshot") return bytes({ code: 1, stderr: "scrot: failed" });

    return bytes({ stdout: initial.screenshot ?? testPng(2, 2) });
  };

  return { run, runBytes, calls, inputs };
}

/** 一時ディレクトリに本物の設定ファイルを作り、そこを指すストアを渡す。 */
export async function withTempSettings<T>(
  content: FileSettings | null,
  run: (store: SettingsStore, path: string) => Promise<T>,
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "terasuma-settings-"));
  const path = join(dir, CONFIG_FILE_NAME);

  try {
    if (content !== null) writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`, "utf8");
    return await run(createSettingsStore(path), path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 幅と高さだけを持つ最小の PNG を組み立てる。
 * 大きさの読み取りは IHDR しか見ないので、CRC などは付けない。
 */
export function testPng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);

  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13); // IHDR チャンクの長さ
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/**
 * 幅と高さだけを持つ最小の JPEG（SOI + SOF0）。
 * 大きさの読み取りは SOF の寸法しか見ないので、画像データは付けない。
 */
export function testJpeg(width: number, height: number): Uint8Array {
  return new Uint8Array([
    0xff,
    0xd8, // SOI
    0xff,
    0xc0,
    0x00,
    0x11, // SOF0（長さ 17）
    0x08, // 精度
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03, // 成分数
    0x01,
    0x22,
    0x00,
    0x02,
    0x11,
    0x01,
    0x03,
    0x11,
    0x01,
  ]);
}

/** 幅と高さだけを持つ最小の GIF（GIF89a）。 */
export function testGif(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(10);
  bytes.set(new TextEncoder().encode("GIF89a"), 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

/** WebP のヘッダー（RIFF + WEBP + VP8X チャンク）だけを持つ最小の WebP。 */
export function testWebp(width: number, height: number): Uint8Array {
  const payload = new Uint8Array(10);
  const canvasWidth = width - 1;
  const canvasHeight = height - 1;
  payload[4] = canvasWidth & 0xff;
  payload[5] = (canvasWidth >> 8) & 0xff;
  payload[6] = (canvasWidth >> 16) & 0xff;
  payload[7] = canvasHeight & 0xff;
  payload[8] = (canvasHeight >> 8) & 0xff;
  payload[9] = (canvasHeight >> 16) & 0xff;

  const bytes = new Uint8Array(12 + 8 + payload.length);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 4 + 8 + payload.length, true);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  bytes.set(new TextEncoder().encode("VP8X"), 12);
  view.setUint32(16, payload.length, true);
  bytes.set(payload, 20);
  return bytes;
}

/** テストで使う設定。プロバイダ 1 件が設定済みで、既定のモデルも決まっている状態。 */
export const TEST_SETTINGS: FileSettings = {
  model: "deepseek/deepseek-flash",
  providers: { deepseek: { apiKey: "test-key" } },
};

/**
 * テストから会話の要求を送るときの、画面（タブ）の id。
 * 購読へ自分の出来事を配らないための識別なので、購読を確かめないテストでは同じ値で足りる。
 */
export const TEST_CLIENT = "test-client";
