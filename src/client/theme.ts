import { effect, signal } from "@preact/signals";

/** 利用者が選んだ配色。auto は OS の設定に従う。 */
export type Theme = "light" | "dark" | "auto";

/** 実際に画面へ当てる配色。 */
export type ResolvedTheme = "light" | "dark";

/** 選択肢の並び（設定画面の順）。 */
export const THEMES: readonly Theme[] = ["auto", "light", "dark"];

/** 保存に使うキー。index.html の初期化スクリプトと同じ文字列にすること。 */
export const THEME_STORAGE_KEY = "terasuma.theme";

const DEFAULT_THEME: Theme = "auto";

/** 枠（theme-color）の色。styles.css の --app-canvas と同じ値。 */
const CANVAS: Record<ResolvedTheme, string> = { light: "#f4f4f7", dark: "#0c0c11" };

function isTheme(value: string): value is Theme {
  return (THEMES as readonly string[]).includes(value);
}

function prefersDark(): boolean {
  // window.matchMedia が無い環境（テスト・SSR）は明るい扱いにする
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function readStoredTheme(): Theme | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return stored !== null && isTheme(stored) ? stored : null;
  } catch {
    // プライベートモードなど localStorage が使えない環境。色の記憶だけ諦めて続行する。
    return null;
  }
}

function detectTheme(): Theme {
  // 保存された選択 → 無ければ auto
  return readStoredTheme() ?? DEFAULT_THEME;
}

/** 選んだ配色。設定画面の Segmented はこれを読む。 */
export const theme = signal<Theme>(detectTheme());

/** auto のときだけ OS の設定を読む。 */
export function resolveTheme(value: Theme): ResolvedTheme {
  if (value === "auto") return prefersDark() ? "dark" : "light";
  return value;
}

/**
 * 画面に当てる。html の data-theme と、ブラウザの枠の色（theme-color）を変える。
 * color-scheme は styles.css の :root[data-theme="dark"] が持つので、ここでは触らない。
 */
export function applyTheme(value: Theme): ResolvedTheme {
  const resolved = resolveTheme(value);

  if (typeof document !== "undefined") {
    document.documentElement.dataset.theme = resolved;

    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta !== null) meta.setAttribute("content", CANVAS[resolved]);
  }

  return resolved;
}

/** 選んで保存し、その場で当てる。 */
export function setTheme(next: Theme): void {
  theme.value = next;
  applyTheme(next);

  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // 保存できなくても表示の切り替え自体は成立する。
  }
}

/**
 * 起動時に 1 回だけ呼ぶ。
 * 選んだ配色の変化に追従し、auto のときは OS の設定の変化にも追従する。
 */
export function startThemeSync(): void {
  effect(() => {
    applyTheme(theme.value);
  });

  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (theme.value === "auto") applyTheme(theme.value);
  });
}
