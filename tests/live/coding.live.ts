/**
 * 実際のプロバイダへ繋ぎ、モデルにコンテナの read / write / edit / bash を使わせる確認。
 * `bun test tests/live/coding.live.ts` で動かす（`bun run test:live` にも含まれる）。
 *
 * コンピュータの /home/agent にファイルを作らせて、モデルが本当に
 * そのファイルを書き換えられるかどうかを、コンテナの中身でも確かめる。
 * モデルの応答だけを信じない（「書きました」と言って書いていない場合を見逃さない）。
 */
import { expect, test } from "bun:test";
import { WORKDIR_IN_CONTAINER, type ContainerManager } from "../../src/server/computer/container";
import { DEFAULT_TERA_ID } from "../../src/server/data/store";
import {
  CONTAINER_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
  expectTurnSucceeded,
  preview,
  report,
  sentText,
  toolCall,
  toolResultFor,
  withLiveServer,
} from "./support";

/** コンテナの中のファイルを文字列で読む。 */
async function readInContainer(container: ContainerManager, path: string): Promise<string> {
  return Buffer.from(await container.readFile(path)).toString("utf-8");
}

test(
  "モデルがコンテナのファイルを書き、読み、編集し、bash で確かめられる",
  async () => {
    const path = `${WORKDIR_IN_CONTAINER}/terasuma-live-coding-${crypto.randomUUID()}.txt`;

    await withLiveServer(async (harness) => {
      // coding ツールはコンテナの中で動くので、先に起こしておく（アプリの起動時と同じ）。
      const status = await harness.container.start();
      expect(status.state, `コンテナを起こせなかった: ${status.detail ?? ""}`).toBe("running");

      try {
        // 1. write: ファイルを作らせる。
        const writeEvents = await harness.send(
          DEFAULT_TERA_ID,
          [
            "write ツールを使って、次のファイルを書いてください。",
            `path: ${path}`,
            "content: hello from terasuma",
            "書き終えたら「書きました」とだけ返してください。",
          ].join("\n"),
        );
        const writeDone = expectTurnSucceeded(writeEvents);
        report("write の応答", writeDone);

        const writeCall = toolCall(writeEvents, "", "write");
        console.log(`  write の引数: ${preview(JSON.stringify(writeCall.part.args), 160)}`);
        const writeResult = toolResultFor(writeEvents, writeCall.part.id);
        expect(writeResult.part.failed, `write が失敗した: ${writeResult.part.output}`).toBe(false);
        expect(await readInContainer(harness.container, path), "write の結果がコンテナに残っていない").toBe(
          "hello from terasuma",
        );

        // 2. read: 書いた内容を読ませる。
        const readEvents = await harness.send(
          DEFAULT_TERA_ID,
          `read ツールで ${path} を読み、内容をそのまま返してください。`,
        );
        const readDone = expectTurnSucceeded(readEvents);
        report("read の応答", readDone);

        const readCall = toolCall(readEvents, "", "read");
        const readResult = toolResultFor(readEvents, readCall.part.id);
        expect(readResult.part.failed, `read が失敗した: ${readResult.part.output}`).toBe(false);
        expect(readResult.part.output).toContain("hello from terasuma");
        expect(sentText(readEvents), "read の結果が本文に反映されていない").toContain("hello from terasuma");

        // 3. edit: 一意な文字列を置き換えさせる。
        const editEvents = await harness.send(
          DEFAULT_TERA_ID,
          [
            "edit ツールを使って、次のファイルを編集してください。",
            `path: ${path}`,
            "oldText: hello from terasuma",
            "newText: goodbye from terasuma",
            "編集し終えたら「編集しました」とだけ返してください。",
          ].join("\n"),
        );
        const editDone = expectTurnSucceeded(editEvents);
        report("edit の応答", editDone);

        const editCall = toolCall(editEvents, "", "edit");
        const editResult = toolResultFor(editEvents, editCall.part.id);
        expect(editResult.part.failed, `edit が失敗した: ${editResult.part.output}`).toBe(false);
        expect(await readInContainer(harness.container, path), "edit の結果がコンテナに残っていない").toBe(
          "goodbye from terasuma",
        );

        // 4. bash: コンテナのシェルから、書き換わったファイルを読ませる。
        const bashEvents = await harness.send(
          DEFAULT_TERA_ID,
          `bash ツールで \`cat ${path}\` を実行し、標準出力だけをそのまま返してください。`,
        );
        const bashDone = expectTurnSucceeded(bashEvents);
        report("bash の応答", bashDone);

        const bashCall = toolCall(bashEvents, "", "bash");
        const bashResult = toolResultFor(bashEvents, bashCall.part.id);
        expect(bashResult.part.failed, `bash が失敗した: ${bashResult.part.output}`).toBe(false);
        expect(bashResult.part.output).toContain("goodbye from terasuma");
        expect(sentText(bashEvents), "bash の結果が本文に反映されていない").toContain("goodbye from terasuma");
      } finally {
        // 作ったファイルをコンテナに残さない。
        await harness.container.shell(`rm -f '${path}'`, { timeoutMs: 10_000 });
      }
    });
  },
  TURN_TIMEOUT_MS * 2 + CONTAINER_TIMEOUT_MS,
);
