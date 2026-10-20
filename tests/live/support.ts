/**
 * 実際のプロバイダに繋いで動かす確認（"*.live.ts"）の土台。
 *
 * `bun test` は "*.live.ts" を拾わないので、このファイルも普段は読まれない。
 * 確認は `bun run test:live` で動かす。
 *
 * モデルとプロバイダは本物の config.json から読む（画面から設定したものと同じ 1 か所）。
 * テスト専用のキーの置き場を作ると、どちらの設定が効いているのか分からなくなる。
 * 会話はメモリ上の DB に保存するので、端末に残っている会話には触れない。
 */
import { expect } from "bun:test";
import { join } from "node:path";
import { loadConfig } from "../../src/config";
import { createCodingToolset } from "../../src/server/coding";
import { createComputerToolset } from "../../src/server/computer";
import { createContainerManager, type ContainerManager } from "../../src/server/container";
import { createEngine, resolveModel } from "../../src/server/engine";
import { createHandover } from "../../src/server/handover";
import { createImageStore } from "../../src/server/images";
import { createMcpManager } from "../../src/server/mcp";
import { OAUTH_CALLBACK_PATH } from "../../src/server/mcp-oauth";
import { createCompaction, type Compaction } from "../../src/server/compaction";
import { CATALOG_FILE_NAME, createCatalog, modelContextTokens } from "../../src/server/models-dev";
import { startServer } from "../../src/server/server";
import { createSettingsStore } from "../../src/server/settings";
import { createStore, type Store } from "../../src/server/store";
import type { ReplyLanguage } from "../../src/shared/language";
import { decodeChatEvents } from "../../src/shared/sse";
import type { ChatEvent, ChatMessage, TokenUsage } from "../../src/shared/types";

/** Containerfile と entry.sh の置き場。src から見たときと同じ場所を指す。 */
const CONTAINER_DIR = join(import.meta.dir, "..", "..", "container");

/** 1 ターンの待ち時間。モデルの応答とツールの実行を含むので、既定の 5 秒では足りない。 */
export const TURN_TIMEOUT_MS = 180_000;

/** コンテナを起こすところから始める確認の待ち時間。イメージを作る場合も見込む。 */
export const CONTAINER_TIMEOUT_MS = 600_000;

export type LiveHarness = {
  /** 実際に呼ぶモデル。設定から解決した結果。 */
  model: string;
  /** データディレクトリ。撮った画像はこの下の images/ に置かれる。 */
  dataDir: string;
  /** コンテナ。デスクトップを触る確認で、アプリの起動時と同じように先に起こす。 */
  container: ContainerManager;
  /** 本番と同じストア。長い履歴や要約を直に置いて確かめるときに使う。 */
  store: Store;
  /** 過去の対話の圧縮。閾値をまたぐ確認で、更新を待つために使う。 */
  compaction: Compaction;
  /** 端末のツール（read / write / edit / bash）の基準ディレクトリ。 */
  workspace: string;
  send(teraId: string, content: string, language?: ReplyLanguage): Promise<ChatEvent[]>;
  /** その Tera の履歴（古い順）。 */
  messages(teraId: string): Promise<ChatMessage[]>;
};

/**
 * 本番と同じ組み立てでサーバを起こし、確認が終わったら畳む。
 *
 * 差し替えるのは待ち受けポート（OS に選ばせる）と、端末のツールの基準ディレクトリだけ。
 * エンジンも MCP もコンテナも本物を使う。
 * 何かを差し替えると、確かめているのがアプリなのか差し替えなのか分からなくなる。
 */
export type LiveServerOptions = {
  /** 端末のツールの基準ディレクトリ。省くと、テストを動かしているディレクトリ。 */
  cwd?: string;
};

export async function withLiveServer(
  run: (harness: LiveHarness) => Promise<void>,
  options: LiveServerOptions = {},
): Promise<void> {
  const config = { ...loadConfig(), port: 0 };

  // mock は API を呼ばないので、動かしても「繋がった」ことにはならない。黙って通さない。
  if (config.engine !== "mastra") {
    throw new Error(`engine が ${config.engine} です。実際の API へ繋ぐ確認は engine: "mastra" のときだけ動きます`);
  }

  const settings = createSettingsStore(config.configPath);
  const resolution = resolveModel(settings.read());
  if (!resolution.ok) throw new Error(`モデルを解決できません: ${resolution.detail}`);

  // 何を確かめているのかが出力だけで分かるように、読んだ設定と解決したモデルを出す。
  console.log(`  設定: ${config.configPath}`);
  console.log(`  モデル: ${resolution.model.id}`);

  const store = createStore(":memory:");
  const images = createImageStore(config.dataDir);
  const container = createContainerManager({ dataDir: config.dataDir, containerDir: CONTAINER_DIR });
  const handover = createHandover();
  const computer = createComputerToolset({ container, images, handover });

  // 相対パスと bash の作業ディレクトリ。アプリの起動時と同じく、起動したディレクトリを使う。
  const workspace = options.cwd ?? process.cwd();
  const coding = createCodingToolset({ cwd: workspace });

  // OAuth の戻り先は、待ち受けているポートが決まってから決まる（index.ts と同じ）。
  let boundPort: number | null = null;
  const mcp = createMcpManager({
    settings,
    dataDir: config.dataDir,
    callbackUrl: () =>
      boundPort === null ? null : new URL(`http://${config.host}:${boundPort}${OAUTH_CALLBACK_PATH}`),
  });

  const engine = createEngine({ config, settings, mcp, computer, coding, images });

  // 畳むかどうかはモデルの文脈長から決める（index.ts と同じ組み立て）。
  const catalog = createCatalog({ cachePath: join(config.dataDir, CATALOG_FILE_NAME) });
  const compaction = createCompaction({
    store,
    engine,
    log: (message) => console.log(message),
    contextLimit: () => modelContextTokens(catalog.snapshot(), settings.read().model),
  });

  const { server } = startServer({ config, store, engine, compaction, catalog, settings, mcp, container, handover });
  boundPort = server.port ?? null;

  try {
    const base = server.url;
    await run({
      model: resolution.model.id,
      dataDir: config.dataDir,
      container,
      store,
      compaction,
      workspace,
      async send(teraId, content, language = "ja") {
        const response = await fetch(new URL(`/api/teras/${teraId}/messages`, base), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, language }),
        });
        expect(response.status, "送信が失敗した").toBe(200);

        const decoded = decodeChatEvents(await response.text());
        expect(decoded.rest).toBe("");
        return decoded.events;
      },
      async messages(teraId) {
        const response = await fetch(new URL(`/api/teras/${teraId}/messages`, base));
        return ((await response.json()) as { messages: ChatMessage[] }).messages;
      },
    });
  } finally {
    await server.stop(true);
    await mcp.close();
    compaction.close();
    store.close();
  }
}

export function joinedDeltas(events: ChatEvent[]): string {
  return events
    .filter((event): event is Extract<ChatEvent, { type: "text-delta" }> => event.type === "text-delta")
    .map((event) => event.delta)
    .join("");
}

/**
 * ターンが最後まで通ったことを確かめ、保存された assistant の本文を返す。
 * 失敗はストリームの最後のイベントとして届くので、理由をそのままテストの出力に出す。
 */
export function expectTurnSucceeded(events: ChatEvent[]): ChatMessage {
  const last = events.at(-1);
  if (last?.type === "error") {
    throw new Error(`ターンが失敗した（${last.code}）: ${last.detail ?? "(理由なし)"}`);
  }
  if (last?.type !== "assistant-done") {
    throw new Error(`最後のイベントが assistant-done ではない: ${last?.type ?? "(イベントなし)"}`);
  }
  return last.message;
}

/** 本文を 1 行に畳んで短く見せる。長い応答で出力が埋まらないようにする。 */
export function preview(content: string, width = 100): string {
  const line = content.replace(/\s+/g, " ").trim();
  return line.length <= width ? line : `${line.slice(0, width)}…`;
}

/**
 * 応答の中身と消費したトークンを出力に残す。
 * 実際に何が返ってきたかと、キャッシュが当たったかどうかが、走らせただけで分かるようにする。
 */
export function report(label: string, message: ChatMessage): void {
  console.log(`  ${label}: 「${preview(message.content)}」`);

  const usage: TokenUsage | null = message.usage;
  if (usage === null) {
    console.log(`  ${label}: トークン数は報告されなかった`);
    return;
  }
  console.log(
    `  ${label}: 入力 ${usage.inputTokens}（うちキャッシュ ${usage.cachedInputTokens}）／出力 ${usage.outputTokens}`,
  );
}

/** 呼ばれたツールを、呼ばれた順に並べる。 */
export function toolSequence(events: ChatEvent[]): string {
  const names = events
    .filter((event): event is Extract<ChatEvent, { type: "tool-call" }> => event.type === "tool-call")
    .map((event) =>
      event.part.server.length === 0 ? event.part.tool : `${event.part.server}_${event.part.tool}`,
    );
  return names.length === 0 ? "(ツールは呼ばれていない)" : names.join(" → ");
}

/** ツールの呼び出しを取り出す。呼ばれていなければ、呼ばれた一覧を添えて落とす。 */
export function toolCall(
  events: ChatEvent[],
  server: string,
  tool: string,
): Extract<ChatEvent, { type: "tool-call" }> {
  const call = events.find(
    (event): event is Extract<ChatEvent, { type: "tool-call" }> =>
      event.type === "tool-call" && event.part.server === server && event.part.tool === tool,
  );
  if (call === undefined) {
    throw new Error(`${server}_${tool} が呼ばれなかった（呼ばれたツール: ${toolSequence(events)}）`);
  }
  return call;
}

/** 呼び出し 1 つに対する結果を取り出す。返っていなければ、その旨で落とす。 */
export function toolResultFor(events: ChatEvent[], id: string): Extract<ChatEvent, { type: "tool-result" }> {
  const result = events.find(
    (event): event is Extract<ChatEvent, { type: "tool-result" }> => event.type === "tool-result" && event.part.id === id,
  );
  if (result === undefined) throw new Error(`ツールの結果が返らなかった（呼び出し ${id}）`);
  return result;
}
