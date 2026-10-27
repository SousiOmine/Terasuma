import { locale, setLocale } from "../i18n";
import { openTera } from "./chat";
import { loadContainer, showContainerError } from "./container";
import { showChatError } from "./failure";
import { loadModelSettings } from "./model";
import { loadTeras, teras } from "./session";

/**
 * 画面を開いたときの読み込み。
 * チャットを使い始めるのに必要なものから順に読み、失敗しても入力できる画面は出す。
 */
export async function bootstrap(): Promise<void> {
  setLocale(locale.value);

  // コンテナの状態は、チャット画面の案内（podman が無い場合）に使う。
  // 読めなくてもチャットは使えるので、待たずに進め、失敗は設定画面のエラーに残す。
  void loadContainer().catch(showContainerError);

  try {
    // モデル設定は、チャット画面の「使うモデルがありません」の案内にも使う。
    await loadModelSettings();
    // 起動時はまだ読んでいないので load で足りる（読み直しは Tera を消したときなどに使う）。
    await loadTeras();

    // いまは 1 体だけなので、開く Tera は一覧の先頭で決まる。
    const first = teras.value[0];
    if (first !== undefined) await openTera(first.id);
  } catch (error) {
    // サーバに繋がらない場合も、入力できる画面は出す（送信時にあらためて失敗を伝える）。
    showChatError(error);
  }
}
