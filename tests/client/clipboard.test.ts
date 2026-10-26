import { describe, expect, test } from "bun:test";
import { copyText } from "../../src/client/lib/clipboard";

type GlobalKey = "navigator" | "document";

/** テストの間だけグローバルを差し替え、終わったら元へ戻す。 */
function setGlobal(key: GlobalKey, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  return () => {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  };
}

type FakeTextarea = {
  value: string;
  readOnly: boolean;
  style: { position: string; top: string; left: string; opacity: string };
  select(): void;
  remove(): void;
};

type FakeCalls = {
  appendChild: number;
  select: number;
  remove: number;
  execCommand: string[];
};

function createDocument(result: boolean): { document: Document; textarea: FakeTextarea; calls: FakeCalls } {
  const calls: FakeCalls = { appendChild: 0, select: 0, remove: 0, execCommand: [] };
  const textarea: FakeTextarea = {
    value: "",
    readOnly: false,
    style: { position: "", top: "", left: "", opacity: "" },
    select() {
      calls.select += 1;
    },
    remove() {
      calls.remove += 1;
    },
  };

  const fake = {
    createElement(tag: string) {
      expect(tag).toBe("textarea");
      return textarea;
    },
    body: {
      appendChild(node: unknown) {
        expect(node).toBe(textarea);
        calls.appendChild += 1;
      },
    },
    execCommand(command: string) {
      calls.execCommand.push(command);
      return result;
    },
  };

  return { document: fake as unknown as Document, textarea, calls };
}

describe("クリップボードへ写す", () => {
  test("writeText があればそれを使う", async () => {
    const copied: string[] = [];
    const restore = setGlobal("navigator", {
      clipboard: {
        writeText: async (value: string) => {
          copied.push(value);
        },
      },
    });

    try {
      expect(await copyText("こんにちは")).toBe(true);
      expect(copied).toEqual(["こんにちは"]);
    } finally {
      restore();
    }
  });

  test("writeText が投げたら代替に進み、execCommand の結果を返す", async () => {
    const fake = createDocument(true);
    const restoreNavigator = setGlobal("navigator", {
      clipboard: {
        writeText: async () => {
          throw new Error("not allowed");
        },
      },
    });
    const restoreDocument = setGlobal("document", fake.document);

    try {
      expect(await copyText("代替")).toBe(true);
      expect(fake.textarea.value).toBe("代替");
      expect(fake.textarea.readOnly).toBe(true);
      expect(fake.textarea.style).toEqual({ position: "fixed", top: "0", left: "0", opacity: "0" });
      expect(fake.calls.appendChild).toBe(1);
      expect(fake.calls.select).toBe(1);
      expect(fake.calls.execCommand).toEqual(["copy"]);
    } finally {
      restoreDocument();
      restoreNavigator();
    }
  });

  test("execCommand が false なら false", async () => {
    const fake = createDocument(false);
    const restoreNavigator = setGlobal("navigator", {});
    const restoreDocument = setGlobal("document", fake.document);

    try {
      expect(await copyText("写らない")).toBe(false);
    } finally {
      restoreDocument();
      restoreNavigator();
    }
  });

  test("navigator も document も無ければ false", async () => {
    const restoreNavigator = setGlobal("navigator", undefined);
    const restoreDocument = setGlobal("document", undefined);

    try {
      expect(await copyText("どこにも無い")).toBe(false);
    } finally {
      restoreDocument();
      restoreNavigator();
    }
  });

  test("代替のあとは必ず remove する", async () => {
    const fake = createDocument(false);
    const restoreNavigator = setGlobal("navigator", {});
    const restoreDocument = setGlobal("document", fake.document);

    try {
      await copyText("後片付け");
      expect(fake.calls.remove).toBe(1);
    } finally {
      restoreDocument();
      restoreNavigator();
    }
  });
});
