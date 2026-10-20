import { computed, signal } from "@preact/signals";
import type { Tera } from "../../shared/types";
import * as api from "../lib/api";

/**
 * 会話の持ち主（Tera）と、いま開いている Tera。
 * チャットと引き受けの両方が参照するので、どちらからも独立したモジュールに置く。
 */

/** 画面に並べる Tera。いまは既定の 1 体だけ。 */
export const teras = signal<readonly Tera[]>([]);
export const activeTeraId = signal<string | null>(null);

/** 一覧をまだ読めていないときは null になる。 */
export const activeTera = computed(() => teras.value.find((tera) => tera.id === activeTeraId.value) ?? null);

/** 一覧をサーバから読み直す。 */
export async function refreshTeras(): Promise<void> {
  teras.value = await api.listTeras();
}
