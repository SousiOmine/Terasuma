import { SettingsWriteError } from "../../errors";
import { describeError } from "../../../shared/errors";

/**
 * 設定を書き換えて、書き換えた後の全体を返す関数を作る。
 *
 * モデル・MCP・Web 検索の設定画面は、どれも「書き換える → 変えた後の全体を返す」という形になる。
 * 書けなかった理由（置き場所の権限が無い、起動中に手で壊されたなど）は、そのまま画面に出せる形にする。
 */
export function settingsWriter(view: () => Response): (change: () => void) => Response {
  return (change) => {
    try {
      change();
    } catch (error) {
      throw new SettingsWriteError(describeError(error), error);
    }
    return view();
  };
}
