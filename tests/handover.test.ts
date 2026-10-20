import { describe, expect, test } from "bun:test";
import { HANDOVER_DONE, createHandover } from "../src/server/computer/handover";

/** ユーザーへ画面を渡す待ちの確認。エージェントのツールと HTTP の両方から触られる。 */
describe("引き受けの待ち", () => {
  test("チャットに書いた文が、そのままツールの戻り値になる", async () => {
    const handover = createHandover();
    const controller = new AbortController();

    const waiting = handover.wait("t1", controller.signal);
    expect(handover.answer("t1", { kind: "text", text: "ログインできた。二段階認証も済んだ" })).toBe(true);
    expect(await waiting).toBe("ログインできた。二段階認証も済んだ");

    // 返したあとの待ちは残らない。
    expect(handover.answer("t1", { kind: "done" })).toBe(false);
  });

  test("「操作を完了した」は決まった文になる", async () => {
    const handover = createHandover();
    const controller = new AbortController();

    const waiting = handover.wait("t1", controller.signal);
    expect(handover.answer("t1", { kind: "done" })).toBe(true);

    expect(await waiting).toBe(HANDOVER_DONE);
  });

  test("待っていない Tera への返事は受け取らない", () => {
    const handover = createHandover();

    expect(handover.answer("t1", { kind: "done" })).toBe(false);
  });

  test("別の Tera の待ちは混ざらない", async () => {
    const handover = createHandover();
    const first = handover.wait("t1", new AbortController().signal);
    const second = handover.wait("t2", new AbortController().signal);

    expect(handover.answer("t2", { kind: "text", text: "t2 の返事" })).toBe(true);
    expect(await second).toBe("t2 の返事");

    // s1 の待ちは残っている。
    expect(handover.answer("t1", { kind: "text", text: "t1 の返事" })).toBe(true);
    expect(await first).toBe("t1 の返事");
  });

  test("ターンが止まったら、待たずに終わる", async () => {
    const handover = createHandover();
    const controller = new AbortController();

    const waiting = handover.wait("t1", controller.signal);
    controller.abort();

    expect(await waiting.catch((error: unknown) => (error as Error).message)).toContain("The turn ended");
    // 止まったあとの返事は受け取らない。
    expect(handover.answer("t1", { kind: "done" })).toBe(false);
  });

  test("すでに止まっているターンでは、待ちを作らずに終わる", async () => {
    const handover = createHandover();
    const controller = new AbortController();
    controller.abort();

    const waiting = handover.wait("t1", controller.signal);

    expect(await waiting.catch((error: unknown) => (error as Error).message)).toContain("The turn ended");
    expect(handover.answer("t1", { kind: "done" })).toBe(false);
  });
});
