/**
 * 実際のプロバイダへ繋いで動かす確認。`bun run test:live` で動かす。
 *
 * ファイル名を "*.live.ts" にしてあるので、`bun test` の探索には載らない。
 * ネットワークと API キーが要り、通信費もわずかにかかるため、既定のテストからは外している。
 */
import { expect, test } from "bun:test";
import { DEFAULT_TERA_ID } from "../../src/server/data/store";
import type { MessagePart } from "../../src/shared/types";
import {
  CONTAINER_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
  expectTurnSucceeded,
  messageText,
  preview,
  report,
  sentText,
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
      const text = sentText(first);
      expect(text.length, "本文が空だった").toBeGreaterThan(0);
      expect(messageText(done), "流れてきた本文と保存された本文が食い違っている").toBe(text);
      expect(done.usage, "トークン数が報告されなかった").not.toBeNull();
      expect(done.usage?.inputTokens ?? 0, "入力トークンが 0 だった").toBeGreaterThan(0);
      expect(done.usage?.outputTokens ?? 0, "出力トークンが 0 だった").toBeGreaterThan(0);
      report("1 ターン目", done);

      // 2 ターン目は、1 ターン目の履歴をそのまま積んで送る。
      // 保存済みの履歴がプロバイダに通るかどうかは、ここでしか分からない。
      const second = await harness.send(DEFAULT_TERA_ID, "いま何と答えましたか。一言で。");
      const secondDone = expectTurnSucceeded(second);
      expect(sentText(second).length, "2 ターン目の本文が空だった").toBeGreaterThan(0);
      report("2 ターン目", secondDone);

      const saved = await harness.messages(DEFAULT_TERA_ID);
      expect(saved.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
      expect(saved[1]?.content).toBe("");
      expect(saved[3]?.content).toBe("");
      expect(saved[1] === undefined ? "" : messageText(saved[1])).toBe(text);
      expect(saved[3] === undefined ? "" : messageText(saved[3])).toBe(sentText(second));
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
        "bash ツールで `echo terasuma-live-ok` を実行し、その標準出力だけをそのまま返してください。",
      );
      const done = expectTurnSucceeded(events);
      report("応答", done);

      const call = toolCall(events, "", "bash");
      const result = toolResultFor(events, call.part.id);
      console.log(`  呼び出し: ${preview(JSON.stringify(call.part.args), 120)}`);
      console.log(`  結果: ${preview(result.part.output, 120)}`);

      expect(result.part.failed, `シェルの実行に失敗した: ${result.part.output}`).toBe(false);
      expect(result.part.output, "実行結果に印が無い").toContain("terasuma-live-ok");

      // モデルは結果を読んでから本文を書く。ここまで来ていれば、1 ターンの中で往復できている。
      expect(sentText(events).length, "ツールを使った後の本文が空だった").toBeGreaterThan(0);

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

test(
  "畳んだ要約がモデルへ渡る",
  async () => {
    await withLiveServer(async (harness) => {
      // 要約は閾値に届くまで会話しないと作られないので、
      // ここでは作られたあとの状態を直接置いて、渡り方だけを確かめる。
      harness.store.writeCompaction(DEFAULT_TERA_ID, {
        summary: ["## Goal", "ユーザーの名前は「そら」で、京都に住んでいる。"].join("\n"),
        throughSeq: 0,
        tokensBefore: 0,
        createdAt: Date.now(),
      });

      const events = await harness.send(DEFAULT_TERA_ID, "私の名前と、住んでいる場所を一言で。");
      const done = expectTurnSucceeded(events);
      report("応答", done);

      // 要約は先頭の user メッセージとして渡す。プロバイダがこの並びを受け付けるかは、ここでしか分からない。
      const text = messageText(done);
      expect(text, "畳んだ要約がモデルへ渡っていない").toContain("そら");
      expect(text).toContain("京都");
    });
  },
  TURN_TIMEOUT_MS,
);

test(
  "長い履歴が、実際のモデルで定型の要約に畳まれる",
  async () => {
    await withLiveServer(async (harness) => {
      // 1 件あたり 1,000 トークンほど（半角 4 文字で 1 トークン）の履歴を 60 件置く。
      // 画面から作ると 30 往復かかるので、履歴は直に置く（最後はアシスタントの発言にして、畳める形にする）。
      for (let index = 1; index <= 60; index += 1) {
        const content = `記録 ${index}: ${"terasuma compaction check ".repeat(150)}`;
        const role = index % 2 === 1 ? "user" : "assistant";
        const parts: MessagePart[] | null = role === "assistant" ? [{ type: "text", text: content }] : null;
        harness.store.appendMessage({
          id: `seed-${index}`,
          teraId: DEFAULT_TERA_ID,
          role,
          content: role === "user" ? content : "",
          parts,
        });
      }

      // 要約はツールを使わない 1 回の生成で行う。ここが通らないと文脈は畳まれないので、
      // 実際のモデルが指示どおりの定型を返すかどうかを、ここで確かめる。
      await harness.compaction.update(DEFAULT_TERA_ID, { force: true });
      const state = harness.store.readCompaction(DEFAULT_TERA_ID);

      console.log(`  要約: throughSeq=${state.throughSeq} / ${state.summary.length} 文字`);
      console.log(`  要約: ${preview(state.summary, 160)}`);

      expect(state.throughSeq, "要約が進んでいない").toBeGreaterThan(0);
      expect(state.summary, "定型の見出しが無い").toContain("## Goal");
      // 畳んだ分は生の履歴から外れる。
      expect(harness.store.listMessagesSince(DEFAULT_TERA_ID, state.throughSeq).length).toBeLessThan(60);
    });
  },
  TURN_TIMEOUT_MS,
);
