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

/** 現在のロケールで文言を引く。ロケール signal を読むので、切り替えると再描画される。 */
export function t(key: MessageKey): string {
  return dictionaries[locale.value][key];
}
