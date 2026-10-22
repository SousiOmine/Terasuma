import { isEnvName, isReservedEnvName } from "../../shared/env";
import { describeError } from "../../shared/errors";
import type { SettingsStore } from "../data/settings";
import { SettingsWriteError } from "../errors";

/**
 * エージェントが秘密（API キーなど）を必要としたときの、チャットからの入力待ち。
 *
 * 流れは computer/handover.ts と同じで、ツールがここで待ち、HTTP からの返事で解ける。
 * 違うのは、受け取った値を設定ファイルへ書き込み、ツールの戻り値には値を含めないこと。
 * 値がモデルの文脈（ツールの引数・戻り値・履歴）に載る経路を作らないための分け方。
 *
 * 待ちは Tera ごとに 1 つだけ持つ。ターンの中で作られるので、停止やタブの切断で
 * signal が立ったらそこで終わる。
 */

/** 入力できる値の長さの上限（文字数）。鍵やトークンには十分で、壊れた入力は弾ける大きさ。 */
export const MAX_ENV_VALUE_CHARS = 16_384;

/** ツールから設定できない名前の理由。 */
export type EnvNameProblem = "invalid" | "reserved";

/** ツールから設定できない名前かどうか。使えるなら null。 */
export function envNameProblem(name: string): EnvNameProblem | null {
  if (!isEnvName(name)) return "invalid";
  if (isReservedEnvName(name)) return "reserved";
  return null;
}

/**
 * 入力された値を、保存できる形に整える（前後の空白を落とす）。
 * 受け付けられない場合は、画面へそのまま出せる理由を投げる。
 */
export function normalizeEnvValue(raw: string): string {
  const value = raw.trim();

  if (value.length === 0) throw new Error("値を入力してください");
  // NUL は podman exec の引数にできない（渡すとコマンドが起動しない）。
  if (value.includes("\0")) throw new Error("値に NUL 文字は使えません");
  if (value.length > MAX_ENV_VALUE_CHARS) {
    throw new Error(`値は ${MAX_ENV_VALUE_CHARS} 文字以下にしてください`);
  }
  return value;
}

/** ユーザーからの返し方。 */
export type EnvAnswer =
  /** 入力欄に値を入れて確定した。 */
  | { kind: "value"; name: string; value: string }
  /** 入力をやめた。 */
  | { kind: "cancel"; name: string };

/** 設定できたときにモデルへ返す文。値そのものは含めない。 */
export function envSetResultText(name: string): string {
  return [
    `The user entered a value for ${name}, and it is now set for every command you run in the computer.`,
    "You do not see the value and must not ask for it.",
    `Reference it through the environment (for example $${name} in bash) and do not print it.`,
  ].join(" ");
}

/** 入力をやめたときにモデルへ返す文。 */
export function envCancelledText(name: string): string {
  return `The user did not enter a value for ${name}. Do not ask again unless the user asks you to.`;
}

/** ターンが終わって、待ちを続けられなくなったときの理由。 */
const WAIT_ENDED = "The turn ended before the user entered the value";

export type EnvRequests = {
  /**
   * ユーザーの入力を待つ。入力されたら設定へ保存し、モデルへ返す文に解決する。
   * 取り消されたとき、保存できなかったとき、ターンが止まったときは拒否する。
   */
  wait(teraId: string, name: string, signal: AbortSignal): Promise<string>;
  /** 入力された値（または取り消し）。待っているものが無ければ false。 */
  answer(teraId: string, answer: EnvAnswer): boolean;
};

/** 待ち 1 つ分。終わらせ方は、値の受け取り・取り消し・中断の 3 つだけ。 */
type Pending = {
  /** 待っている変数名。届いた返事が別の呼び出しのものかを、これで見分ける。 */
  name: string;
  /** 値を受け取って保存する。保存できなければ例外にする（HTTP へも返す）。 */
  accept(value: string): void;
  /** 入力をやめた。 */
  cancel(): void;
};

export function createEnvRequests(options: { settings: SettingsStore }): EnvRequests {
  /** Tera の id → いま入力を待っている変数と、待ちを終わらせる口。 */
  const waiting = new Map<string, Pending>();

  return {
    wait(teraId, name, signal) {
      // ツールの引数は検証済みだが、直接呼ばれる経路もあるので、ここでも同じ規則で断る。
      const problem = envNameProblem(name);
      if (problem !== null) {
        return Promise.reject(
          new Error(
            problem === "reserved"
              ? `"${name}" is used by the computer itself; choose another environment variable name`
              : `"${name}" is not a valid environment variable name; use letters, digits and underscores`,
          ),
        );
      }

      // すでに止まったターンから呼ばれることがある（停止とツールの実行が競合した場合）。
      // ここで断らないと、誰も返事をしない待ちが残る。
      if (signal.aborted) return Promise.reject(new Error(WAIT_ENDED));

      return new Promise<string>((resolve, reject) => {
        const finish = (): void => {
          waiting.delete(teraId);
          signal.removeEventListener("abort", onAbort);
        };

        const onAbort = (): void => {
          finish();
          reject(new Error(WAIT_ENDED));
        };

        // 同じ Tera で二重に待つことはない（ターンは 1 つずつ進む）。
        waiting.set(teraId, {
          name,

          accept(value) {
            finish();
            try {
              options.settings.setEnv(name, value);
            } catch (error) {
              // モデルへは「保存できなかった」と伝え、HTTP へも同じ理由を返す。
              const failure = new SettingsWriteError(
                `環境変数 ${name} を保存できませんでした: ${describeError(error)}`,
                error,
              );
              reject(failure);
              throw failure;
            }
            resolve(envSetResultText(name));
          },

          cancel() {
            finish();
            reject(new Error(envCancelledText(name)));
          },
        });

        signal.addEventListener("abort", onAbort, { once: true });
      });
    },

    answer(teraId, answer) {
      const pending = waiting.get(teraId);
      // 名前が違う返事は、遅れて届いた別の呼び出しのもの。受け取らない。
      if (pending === undefined || pending.name !== answer.name) return false;

      // 受け付けられない値では待ちを消費しない（入力欄はそのままで、入れ直せる）。
      const value = answer.kind === "value" ? normalizeEnvValue(answer.value) : null;

      // 待ちを外してから保存する（返事が 2 度届いても、2 度保存しない）。
      waiting.delete(teraId);
      if (value === null) pending.cancel();
      else pending.accept(value);
      return true;
    },
  };
}
