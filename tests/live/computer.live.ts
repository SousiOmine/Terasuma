/**
 * 実際のモデルに、コンテナのデスクトップを操作させる確認。`bun run test:live` で動かす。
 *
 * 撮った画像をモデルへ渡す経路は、ここでしか通らない。コンテナのツールは撮った画像を
 * tool の結果として返せない（OpenAI 互換のプロバイダは本文の画像を文字列へ潰す）ため、
 * Terasuma は結果の直後に user メッセージとして画像を足している。画面に出ている文字を
 * 答えさせることで、その画像をモデルが実際に見ているところまで確かめる。
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { DEFAULT_TERA_ID } from "../../src/server/data/store";
import type { MessagePart } from "../../src/shared/types";
import {
  CONTAINER_TIMEOUT_MS,
  expectTurnSucceeded,
  report,
  visibleText,
  toolCall,
  toolResultFor,
  toolSequence,
  withLiveServer,
} from "./support";

/**
 * 画面に出す印。
 * モデルが画像を実際に見ていれば、この数字が答えに入る（本文からは知りようがない）。
 */
const MARKER = "TERASUMA 7391";

/** モデルに読み取らせる数字の部分。 */
const MARKER_DIGITS = "7391";

/** モデルに開かせるページ。文字を大きくして、読み取れたかどうかを確かめやすくする。 */
const PAGE_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${MARKER}</title>
<style>
body { margin: 0; height: 100vh; display: flex; align-items: center; justify-content: center; background: #1e3a8a; color: #fde047; font-family: system-ui, sans-serif; }
h1 { font-size: 72px; letter-spacing: .08em; }
</style></head>
<body><h1>${MARKER}</h1></body></html>`;

/** コンテナのホーム（/home/agent）に置くファイル名。 */
const PAGE_NAME = "terasuma-live.html";

test(
  "モデルがコンテナのデスクトップを操作し、画面の文字を読める",
  async () => {
    await withLiveServer(async (harness) => {
      // アプリの起動時と同じように、先にコンテナを起こしておく。
      const status = await harness.container.start();
      expect(status.state, `コンテナを起こせなかった: ${status.detail ?? ""}`).toBe("running");

      // 開かせるページを、アプリと同じ経路（コンテナの中でコマンドを動かす）で用意する。
      const written = await harness.container.shell(`cat > ${PAGE_NAME} <<'HTML'\n${PAGE_HTML}\nHTML\n`, {
        timeoutMs: 15_000,
      });
      expect(written.exitCode, `ページを置けなかった: ${written.stderr}`).toBe(0);

      const events = await harness.send(
        DEFAULT_TERA_ID,
        [
          "コンピュータ（Debian のデスクトップ）を操作してください。",
          `1. computer_open ツールで chromium を起動し、引数に file:///home/agent/${PAGE_NAME} を渡して表示させてください。`,
          "2. computer_wait ツールで 3 秒待ってください。",
          "3. computer_screenshot ツールで画面を撮ってください。",
          "4. 画面に出ている文字を、そのまま答えてください。",
        ].join("\n"),
      );

      const done = expectTurnSucceeded(events);
      console.log(`  ツール: ${toolSequence(events)}`);
      report("応答", done);

      // アプリのツールで操作していること（シェルから直接起動したのでは確かめたことにならない）。
      toolCall(events, "computer", "open");

      const shot = toolCall(events, "computer", "screenshot");
      const result = toolResultFor(events, shot.part.id);
      expect(result.part.failed, `画面を撮れなかった: ${result.part.output}`).toBe(false);

      // 撮った画像は保存され、参照が残っている（履歴から読み直してモデルへ渡せる）。
      const image = result.part.images?.[0];
      if (image === undefined) throw new Error(`撮った画像の参照が残っていない: ${result.part.output}`);
      console.log(
        `  画面: ${join(harness.dataDir, "images", `${image.sha256}.png`)}（${image.width}x${image.height}）`,
      );

      const parts = (await harness.messages(DEFAULT_TERA_ID))[1]?.parts ?? [];
      const saved = parts.find(
        (part): part is Extract<MessagePart, { type: "tool-result" }> =>
          part.type === "tool-result" && part.id === shot.part.id,
      );
      expect(saved?.images, "保存された履歴に画像の参照が無い").toBeDefined();

      // ここが本題。画像を渡せていなければ、モデルはこの数字を書けない。
      expect(visibleText(events), "モデルが画面の文字を読めていない").toContain(MARKER_DIGITS);
    });
  },
  CONTAINER_TIMEOUT_MS,
);
