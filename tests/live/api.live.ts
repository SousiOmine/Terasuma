/**
 * 実際のプロバイダへ繋いで動かす確認。`bun run test:live` で動かす。
 *
 * ファイル名を "*.live.ts" にしてあるので、`bun test` の探索には載らない。
 * ネットワークと API キーが要り、通信費もわずかにかかるため、既定のテストからは外している。
 */
import { expect, test } from "bun:test";
import { DEFAULT_TERA_ID } from "../../src/server/store";
import {
  CONTAINER_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
  expectTurnSucceeded,
  joinedDeltas,
  preview,
  report,
  toolCall,
  toolResultFor,
  withLiveServer,
} from "./support";

// 会話は Tera ごとに 1 本なので、どの確認も既定の Tera（起動時に用意される 1 体）へ送る。

test(
  "既定のモデルと 1 ターンやり取りできる",
  async () => {
    await withLiveServer(async (harness) => {
      const first = await harness.send(DEFAULT_TERA_ID, "「テラス」とだけ返してください。");
      expect(first[0]?.type).toBe("user-message");
      expect(first[1]?.type).toBe("assistant-start");

      const done = expectTurnSucceeded(first);
      const text = joinedDeltas(first);
      expect(text.length, "本文が空だった").toBeGreaterThan(0);
      expect(done.content, "流れてきた本文と保存された本文が食い違っている").toBe(text);
      expect(done.usage, "トークン数が報告されなかった").not.toBeNull();
      expect(done.usage?.inputTokens ?? 0, "入力トークンが 0 だった").toBeGreaterThan(0);
      expect(done.usage?.outputTokens ?? 0, "出力トークンが 0 だった").toBeGreaterThan(0);
      report("1 ターン目", done);

      // 2 ターン目は、1 ターン目の履歴をそのまま積んで送る。
      // 保存済みの履歴がプロバイダに通るかどうかは、ここでしか分からない。
      const second = await harness.send(DEFAULT_TERA_ID, "いま何と答えましたか。一言で。");
      const secondDone = expectTurnSucceeded(second);
      expect(joinedDeltas(second).length, "2 ターン目の本文が空だった").toBeGreaterThan(0);
      report("2 ターン目", secondDone);

      const saved = await harness.messages(DEFAULT_TERA_ID);
      expect(saved.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(saved[1]?.content).toBe(done.content);
      expect(saved[3]?.content).toBe(secondDone.content);
    });
  },
  TURN_TIMEOUT_MS,
);

test(
  "モデルがコンテナのシェルを呼び、その結果を答える",
  async () => {
    await withLiveServer(async (harness) => {
      // アプリの起動時と同じように、先にコンテナを起こしておく。
      const status = await harness.container.start();
      expect(status.state, `コンテナを起こせなかった: ${status.detail ?? ""}`).toBe("running");

      const events = await harness.send(
        DEFAULT_TERA_ID,
        "computer_shell ツールで `echo terasuma-live-ok` を実行し、その標準出力だけをそのまま返してください。",
      );
      const done = expectTurnSucceeded(events);
      report("応答", done);

      const call = toolCall(events, "computer", "shell");
      const result = toolResultFor(events, call.part.id);
      console.log(`  呼び出し: ${preview(JSON.stringify(call.part.args), 120)}`);
      console.log(`  結果: ${preview(result.part.output, 120)}`);

      expect(result.part.failed, `シェルの実行に失敗した: ${result.part.output}`).toBe(false);
      expect(result.part.output, "実行結果に印が無い").toContain("terasuma-live-ok");

      // モデルは結果を読んでから本文を書く。ここまで来ていれば、1 ターンの中で往復できている。
      expect(done.content.length, "ツールを使った後の本文が空だった").toBeGreaterThan(0);

      // 呼び出しと結果は、本文と同じメッセージの一部として残る。
      const parts = (await harness.messages(DEFAULT_TERA_ID))[1]?.parts ?? [];
      const savedCall = parts.findIndex((part) => part.type === "tool-call" && part.id === call.part.id);
      const savedResult = parts.findIndex((part) => part.type === "tool-result" && part.id === call.part.id);
      expect(savedCall, "呼び出しが保存されていない").toBeGreaterThanOrEqual(0);
      expect(savedResult, "結果が呼び出しの後に保存されていない").toBeGreaterThan(savedCall);
    });
  },
  CONTAINER_TIMEOUT_MS,
);
