import { afterEach, describe, expect, test } from "bun:test";
import { resolveTheme, setTheme, THEME_STORAGE_KEY } from "../../src/client/theme";

type GlobalKey = "window" | "document" | "localStorage";

/** テストの間だけグローバルを差し替え、終わったら元へ戻す。 */
function setGlobal(key: GlobalKey, value: unknown): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  return () => {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  };
}

function createStorage(initial: Record<string, string>): Storage {
  const values = new Map(Object.entries(initial));

  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
    clear() {
      values.clear();
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    get length() {
      return values.size;
    },
  };
}

type FakeMeta = {
  content: string;
  setAttribute(name: string, value: string): void;
};

type FakeDocument = {
  documentElement: { dataset: Record<string, string> };
  querySelector(selector: string): FakeMeta | null;
};

function createDocument(withMeta: boolean): { document: FakeDocument; meta: FakeMeta } {
  const meta: FakeMeta = {
    content: "",
    setAttribute(name, value) {
      if (name === "content") meta.content = value;
    },
  };

  return {
    document: {
      documentElement: { dataset: {} },
      querySelector(selector) {
        return withMeta && selector === 'meta[name="theme-color"]' ? meta : null;
      },
    },
    meta,
  };
}

type MatchMediaControl = {
  query: MediaQueryList;
  setMatches(value: boolean): void;
};

function createMatchMedia(initial: boolean): MatchMediaControl {
  let matches = initial;
  const listeners = new Set<() => void>();

  const query = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener(type: string, listener: () => void) {
      if (type === "change") listeners.add(listener);
    },
    removeEventListener(type: string, listener: () => void) {
      if (type === "change") listeners.delete(listener);
    },
    addListener(listener: () => void) {
      listeners.add(listener);
    },
    removeListener(listener: () => void) {
      listeners.delete(listener);
    },
    dispatchEvent() {
      return true;
    },
  };

  return {
    query: query as unknown as MediaQueryList,
    setMatches(value) {
      matches = value;
      for (const listener of listeners) listener();
    },
  };
}

let restoreEnvironment: (() => void) | null = null;

type Environment = {
  document: FakeDocument;
  meta: FakeMeta;
  media: MatchMediaControl;
  storage: Storage;
};

function installEnvironment(options: { matches?: boolean; stored?: Record<string, string>; withMeta?: boolean } = {}) {
  const { document, meta } = createDocument(options.withMeta ?? false);
  const media = createMatchMedia(options.matches ?? false);
  const storage = createStorage(options.stored ?? {});

  const restoreWindow = setGlobal("window", { matchMedia: () => media.query });
  const restoreDocument = setGlobal("document", document);
  const restoreStorage = setGlobal("localStorage", storage);

  restoreEnvironment = () => {
    restoreStorage();
    restoreDocument();
    restoreWindow();
  };

  return { document, meta, media, storage } satisfies Environment;
}

afterEach(() => {
  restoreEnvironment?.();
  restoreEnvironment = null;
});

describe("画面の配色", () => {
  test("明示した配色はそのまま返す", () => {
    setTheme("auto");

    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  test("auto は OS の設定を読む", () => {
    const environment = installEnvironment({ matches: true });
    setTheme("auto");

    expect(resolveTheme("auto")).toBe("dark");

    environment.media.setMatches(false);
    expect(resolveTheme("auto")).toBe("light");
  });

  test("選んだ配色を画面へ当て、保存する", () => {
    const environment = installEnvironment();
    setTheme("auto");

    setTheme("dark");

    expect(environment.document.documentElement.dataset.theme).toBe("dark");
    expect(environment.storage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  test("OS の設定が変わったとき、auto のときだけ追従する", async () => {
    const environment = installEnvironment({ matches: false });

    // 起動時の 1 回だけを試すので、このテスト専用にモジュールを読み直す。
    const modulePath = "../../src/client/theme?start-sync-test";
    const fresh = (await import(modulePath)) as typeof import("../../src/client/theme");

    fresh.setTheme("light");
    fresh.startThemeSync();

    // 明示した配色は、OS の設定が変わっても動かない。
    environment.media.setMatches(true);
    expect(environment.document.documentElement.dataset.theme).toBe("light");

    fresh.setTheme("dark");
    environment.media.setMatches(false);
    expect(environment.document.documentElement.dataset.theme).toBe("dark");

    // auto は OS の設定に合わせて当て直す。
    fresh.setTheme("auto");
    expect(environment.document.documentElement.dataset.theme).toBe("light");

    environment.media.setMatches(true);
    expect(environment.document.documentElement.dataset.theme).toBe("dark");
  });

  test("保存されている値が壊れているときは auto として扱う", async () => {
    installEnvironment({ matches: false, stored: { [THEME_STORAGE_KEY]: "blue" } });

    // モジュールの初期化時に保存値を読むので、壊れた値の環境で読み直す。
    const modulePath = "../../src/client/theme?broken-stored-value";
    const fresh = (await import(modulePath)) as typeof import("../../src/client/theme");

    expect(fresh.theme.value).toBe("auto");
  });

  test("枠の色も配色に合わせて変える", () => {
    const environment = installEnvironment({ withMeta: true });
    setTheme("auto");

    setTheme("dark");
    expect(environment.meta.content).toBe("#0c0c11");

    setTheme("light");
    expect(environment.meta.content).toBe("#f4f4f7");
  });
});
