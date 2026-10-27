import { ApiError } from "../lib/http";
import { activeTeraId } from "./session";
import { interpretEvent } from "./chat-events";
import { beginConnectorRequest, endConnectorRequest } from "./connector-request";
import { beginEnvRequest, endEnvRequest } from "./env-request";
import { showChatError } from "./failure";
import { beginHandover, endHandover } from "./handover";
import type { ChatEvent, ChatMessageView, MessagePart } from "../../shared/api/message";
import type { Signal } from "@preact/signals";

/**
 * 1 つのイベント（送信の応答と、ほかの画面からの購読で同じ形）を、画面の状態へ反映する。
 *
 * 「どの合図が、どの表示を動かすか」だけを持つ。ターンの開始や停止の手順は chat.ts が持つ。
 * 反映に使う signal は呼び出し側から受け取る（このモジュールが状態の持ち主にならない）。
 */

/** いま届いているターン。 */
export type LiveTurn = {
  id: string;
  createdAt: number;
  /**
   * この応答に予約された連番。開始の合図（assistant-start）を受け取っていれば入る。
   * 途中から購読したときなど、合図が無いまま部分だけが届くと null になる。
   */
  seq: number | null;
  parts: readonly MessagePart[];
};

export type ChatState = {
  readonly liveTurn: Signal<LiveTurn | null>;
  /** 保存済みの発言を、seq の順に並ぶ位置へ入れる。 */
  upsert(message: ChatMessageView): void;
  /** 伸びている応答を、保存済みの発言として確定させる（連番が分かるときだけ）。 */
  settle(teraId: string): void;
  /** 新しい Tera を作る呼び出しの id（結果が届いたら一覧を読み直す）。 */
  readonly teraCreateCalls: Set<string>;
  /** 新しい Tera ができたときに一覧を読み直す。 */
  refreshTeras: () => Promise<void>;
};

/** イベントを状態へ反映する。解釈は chat-events.ts が持つ。 */
export function applyEvent(state: ChatState, event: ChatEvent, teraId: string): void {
  const effect = interpretEvent(event);
  if (effect === null) return;

  switch (effect.kind) {
    case "message":
      // 保存された内容で置き換わるので、いま伸びていたターンは畳む。
      if (effect.message.role === "assistant" && state.liveTurn.value?.id === effect.message.id)
        state.liveTurn.value = null;
      state.upsert(effect.message);
      break;
    case "assistant-start":
      // ステップが変わった。いまの吹き出しを確定させ、次の吹き出しを開く。
      state.settle(teraId);
      state.liveTurn.value = { id: effect.id, createdAt: effect.createdAt, seq: effect.seq, parts: [] };
      break;
    case "assistant-part": {
      const live = state.liveTurn.value;
      // 応答の途中から購読したときなど、開始の合図が無いまま部分が届くことがある。
      // その場合は捨てずに新しいターンとして開く（黙って消すと、本文が欠けて見える）。
      if (live === null) {
        state.liveTurn.value = { id: effect.id, createdAt: effect.part.at, seq: null, parts: [effect.part] };
        break;
      }
      state.liveTurn.value = { ...live, parts: [...live.parts, effect.part] };
      break;
    }
    case "chat-ui": {
      // カードの材料（ツール呼び出し）は、そのままターンの記録に積む。
      // 画面はここからマークアップを解釈して描く（保存する形は増やさない）。
      const live = state.liveTurn.value;
      if (live === null) {
        state.liveTurn.value = { id: effect.id, createdAt: Date.now(), seq: null, parts: [effect.part] };
        break;
      }
      state.liveTurn.value = { ...live, parts: [...live.parts, effect.part] };
      break;
    }
    case "handover-start":
      beginHandover(effect.callId, effect.question);
      break;
    case "env-request-start":
      beginEnvRequest(effect.callId, effect.name, effect.description);
      break;
    case "connector-request-start":
      // Discord は Tera ごとの webhook なので、カードを出した時点の Tera を覚えておく。
      beginConnectorRequest(effect.callId, effect.provider, effect.reason, activeTeraId.value);
      break;
    case "tera-create-call":
      // 結果が成功で届いたときに、一覧を読み直す。
      state.teraCreateCalls.add(effect.callId);
      break;
    case "tool-result": {
      // 画面の引き受けは、成功したときだけ終える（失敗した呼び出しでは待ちが続いている）。
      if (!effect.failed) endHandover(effect.callId);
      // 環境変数の入力は、取り消しや失敗でも終える（入力を待ち続けない）。
      endEnvRequest(effect.callId);
      // 認証カードは、成功なら畳み、失敗は理由を残して導線を消さない。
      endConnectorRequest(effect.callId, effect.failed);
      // 新しい Tera ができたら、サイドバーへ出す（一覧を読み直す）。
      if (state.teraCreateCalls.delete(effect.callId) && !effect.failed) void state.refreshTeras().catch(showChatError);
      break;
    }
    case "error":
      showChatError(new ApiError(effect.code, effect.detail));
      break;
  }
}
