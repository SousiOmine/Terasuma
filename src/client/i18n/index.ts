import { signal } from "@preact/signals";
import { REPLY_LANGUAGES, type ReplyLanguage } from "../../shared/language";
import { en, type MessageKey } from "./en";
import { ja } from "./ja";

export type { MessageKey };
export type Locale = ReplyLanguage;

export const LOCALES: readonly Locale[] = REPLY_LANGUAGES;

const dictionaries: Record<Locale, Record<MessageKey, string>> = { ja, en };
const STORAGE_KEY = "terasuma.locale";
const DEFAULT_LOCALE: Locale = "ja";

function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

function readStoredLocale(): Locale | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored !== null && isLocale(stored) ? stored : null;
  } catch {
    // プライベートモードなど localStorage が使えない環境。言語の記憶だけ諦めて続行する。
    return null;
  }
}

/** 保存された選択 → ブラウザの言語 → 日本語、の順で決める。 */
function detectLocale(): Locale {
  const stored = readStoredLocale();
  if (stored !== null) return stored;

  const candidates = typeof navigator === "undefined" ? [] : (navigator.languages ?? [navigator.language]);
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const tag = candidate.toLowerCase();
    if (tag.startsWith("ja")) return "ja";
    if (tag.startsWith("en")) return "en";
  }

  return DEFAULT_LOCALE;
}

export const locale = signal<Locale>(detectLocale());

export function setLocale(next: Locale): void {
  locale.value = next;

  if (typeof document !== "undefined") {
    document.documentElement.lang = next;
  }
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // 保存できなくても表示の切り替え自体は成立する。
  }
}

/** 文言に埋め込む値（件数など）。 */
export type MessageParams = Record<string, string | number>;

/**
 * その文言が要求する差し込みの名前。
 * 辞書（en）の文面から `{name}` を抜き出して型にするので、足りない名前・余計な名前は型エラーになる。
 */
export type ParamsOf<K extends MessageKey> = keyof {
  [P in (typeof en)[K] extends `${string}{${infer Name}}${infer Rest}`
    ? Name | keyof { [Q in Rest extends `${string}{${infer More}}${string}` ? More : never]: true }
    : never]: true;
};

/** 差し込みを持つキーかどうか（持たないキーに params を渡せないようにする）。 */
type HasParams<K extends MessageKey> = ParamsOf<K> extends never ? false : true;

/** 差し込みを持つキーの params は必須、持たないキーは渡せない。 */
export type TranslationArgs<K extends MessageKey> = HasParams<K> extends true
  ? [params: Record<ParamsOf<K>, string | number>]
  : [params?: undefined];

/**
 * 現在のロケールで文言を引く。ロケール signal を読むので、切り替えると再描画される。
 * "{count}" のような差し込みは params で置き換える。語順は辞書側で決められる。
 */
export function t<K extends MessageKey>(key: K, ...args: TranslationArgs<K>): string {
  const template = dictionaries[locale.value][key];
  const params = args[0] as MessageParams | undefined;
  if (params === undefined) return template;

  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
