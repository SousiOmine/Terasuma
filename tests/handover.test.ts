import { describe, expect, test } from "bun:test";
import { HANDOVER_DONE, createHandover } from "../src/server/handover";

/** ユーザーへ画面を渡す待ちの確認。エージェントのツールと HTTP の両方から触られる。 */
describe("引き受けの待ち", () => {
  test("チャットに書いた文が、そのままツールの戻り値になる", async () => {
    const handover = createHandover();
    const controller = new AbortController();

    const waiting = handover.wait("s1", controller.signal);
    expect(handover.pending("s1")).toBe(true);

    expect(handover.answer("s1", { kind: "text", text: "ログインできた。二段階認証も済んだ" })).toBe(true);
    expect(await waiting).toBe("ログインできた。二段階認証も済んだ");
    expect(handover.pending("s1")).toBe(false);
  });

  test("「操作を完了した」は決まった文になる", async () => {
    const handover = createHandover();
    const controller = new AbortController();

    const waiting = handover.wait("s1", controller.signal);
    handover.answer("s1", { kind: "done" });

    expect(await waiting).toBe(HANDOVER_DONE);
  });

  test("待っていないセッションへの返事は受け取らない", () => {
    const handover = createHandover();

    expect(handover.answer("s1", { kind: "done" })).toBe(false);
    expect(handover.pending("s1")).toBe(false);
  });

  test("別のセッションの待ちは混ざらない", async () => {
    const handover = createHandover();
    const first = handover.wait("s1", new AbortController().signal);
    const second = handover.wait("s2", new AbortController().signal);

    handover.answer("s2", { kind: "text", text: "s2 の返事" });
    expect(await second).toBe("s2 の返事");
    expect(handover.pending("s1")).toBe(true);

    handover.answer("s1", { kind: "text", text: "s1 の返事" });
    expect(await first).toBe("s1 の返事");
  });

  test("ターンが止まったら、待たずに終わる", async () => {
    const handover = createHandover();
    const controller = new AbortController();

    const waiting = handover.wait("s1", controller.signal);
    controller.abort();

    expect(await waiting.catch((error: unknown) => (error as Error).message)).toContain("ターンが終わりました");
    expect(handover.pending("s1")).toBe(false);
  });

  test("待ちを片付けると、完了として終わる", async () => {
    const handover = createHandover();
    const waiting = handover.wait("s1", new AbortController().signal);

    handover.cancel("s1");
    expect(await waiting).toBe(HANDOVER_DONE);
  });
});
