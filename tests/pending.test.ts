import { describe, expect, test } from "bun:test";
import { createPendingRegistry } from "../src/server/wait/pending";

describe("待ちの置き場", () => {
  test("登録した待ちを、取り出して listener ごと外す", () => {
    const registry = createPendingRegistry<string, string>();
    const controller = new AbortController();
    let aborted = false;

    const entry = registry.register("t1", "value", controller.signal, () => {
      aborted = true;
    });

    expect(entry?.pending).toBe("value");
    expect(registry.first("t1")).toBe(entry);

    expect(registry.takeAll("t1")).toEqual([entry as never]);
    expect(registry.first("t1")).toBeNull();
    expect(registry.keys()).toEqual([]);

    // 取り出した後に中断しても、待ちの側へは知らせない。
    controller.abort();
    expect(aborted).toBe(false);
  });

  test("中断で外れ、知らせる", () => {
    const registry = createPendingRegistry<string, string>();
    const controller = new AbortController();
    let aborted = 0;

    registry.register("t1", "value", controller.signal, () => {
      aborted += 1;
    });

    controller.abort();

    expect(aborted).toBe(1);
    expect(registry.first("t1")).toBeNull();
    expect(registry.keys()).toEqual([]);
  });

  test("中断済みの signal では登録しない", () => {
    const registry = createPendingRegistry<string, string>();
    const controller = new AbortController();
    controller.abort();

    expect(registry.register("t1", "value", controller.signal, () => undefined)).toBeNull();
    expect(registry.keys()).toEqual([]);
  });

  test("1 つだけ待つときは、同じキーの 2 つ目を断る", () => {
    const registry = createPendingRegistry<string, string>();
    const controller = new AbortController();

    expect(registry.register("t1", "a", controller.signal, () => undefined)).not.toBeNull();
    expect(registry.register("t1", "b", controller.signal, () => undefined)).toBeNull();
    expect(registry.first("t1")?.pending).toBe("a");
  });

  test("複数待てる指定では、同じキーに積める", () => {
    const registry = createPendingRegistry<string, string>({ multiple: true });
    const controller = new AbortController();

    registry.register("t1", "a", controller.signal, () => undefined);
    registry.register("t1", "b", controller.signal, () => undefined);

    expect(registry.takeAll("t1").map((entry) => entry.pending)).toEqual(["a", "b"]);
  });
});
