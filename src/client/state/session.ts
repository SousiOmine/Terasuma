import { computed, signal } from "@preact/signals";
import type { Tera } from "../../shared/api/message";
import * as api from "../lib/api";
import { createResource } from "./resource";

/**
 * 会話の持ち主（Tera）と、いま開いている Tera。
 * チャットと引き受けの両方が参照するので、どちらからも独立したモジュールに置く。
 */

/**
 * 画面に並べる Tera（既定の Tera と、エージェントが作った Tera）。
 * 状態は data と同じで、まだ読めていなければ null。
 * null を空の一覧として扱うと、読み込みの前に「Tera がありません」を出してしまう。
 */
const terasResource = createResource(api.listTeras);
export const teras = computed<readonly Tera[]>(() => terasResource.data.value ?? []);
/** 一覧をまだ読めていないか、読めなかったかを見分けるための口。 */
export const isLoadingTeras = terasResource.loading;
export const terasLoadError = terasResource.error;

export const activeTeraId = signal<string | null>(null);

/** 一覧をまだ読めていないときは null になる。 */
export const activeTera = computed(() => teras.value.find((tera) => tera.id === activeTeraId.value) ?? null);

/** 一覧をサーバから読み直す。 */
export async function refreshTeras(): Promise<void> {
  await terasResource.refresh();
}

/** 起動時に読む（まだ読めていなければ）。 */
export async function loadTeras(): Promise<void> {
  await terasResource.load();
}

/** 消したあとの一覧を、サーバが返した値で置き換える（読み直しの往復を省く）。 */
export function setTeras(next: readonly Tera[]): void {
  terasResource.data.value = next;
}
