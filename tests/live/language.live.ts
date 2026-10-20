/**
 * 返事の言語が、画面の言語設定に従うことを実際のプロバイダで確かめる。
 * `bun test ./tests/live/language.live.ts` で動かす。
 *
 * ユーザーの発言は日本語のままにし、設定だけを英語にする。
 * 「ユーザーが書いた言語」ではなく「設定した言語」で返すことを見る。
 */
import { expect, test } from "bun:test";
import { DEFAULT_TERA_ID } from "../../src/server/store";
import { TURN_TIMEOUT_MS, expectTurnSucceeded, joinedDeltas, report, withLiveServer } from "./support";

/** ひらがな・カタカナ・漢字が 1 文字でも含まれているか。 */
const JAPANESE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/;

test(
  "日本語の質問でも、設定が英語なら英語で返す",
  async () => {
    await withLiveServer(async (harness) => {
      const events = await harness.send(
        DEFAULT_TERA_ID,
        "日本の首都はどこですか。都市名をひとつだけ答えてください。",
        "en",
      );
      const done = expectTurnSucceeded(events);
      report("応答", done);

      const text = joinedDeltas(events);
      expect(text.length, "本文が空だった").toBeGreaterThan(0);
      expect(text, "設定が英語なのに日本語で返している").not.toMatch(JAPANESE);
      expect(text, "英語の本文になっていない").toMatch(/[A-Za-z]/);
    });
  },
  TURN_TIMEOUT_MS,
);
