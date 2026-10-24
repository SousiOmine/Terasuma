import { resolveModel } from "../../provider/routing";
import { saveUploads } from "../../computer/uploads";
import { ensureTeraWorkspace, removeTeraWorkspace } from "../../computer/workspaces";
import { createConversationBroadcast } from "../../agent/broadcast";
import { toMessageView } from "../../agent/message-view";
import { createTurns } from "../../agent/turns";
import { AppError, ConflictError, ValidationError } from "../../errors";
import type { ConversationEvent } from "../../../shared/api/events";
import { encodeChatEvent, encodeConversationEvent } from "../../../shared/sse";
import { readRetryForm, readSteerForm, readTurnForm } from "../body";
import { json, noContent } from "../respond";
import { createSseResponse } from "../sse";
import { type ApiDeps, type ApiRequest, requireClientId, requireTera } from "./shared";

/** 履歴を 1 回に返す上限。画面はこれより小さい 20 件ずつ読む。 */
const MAX_MESSAGE_PAGE = 100;

/** 履歴の読み出し。ページの指定は問い合わせから読む。 */
type MessagesRequest = ApiRequest<{ id: string }> & { url: string };

/**
 * Tera（会話の持ち主）と、その 1 本の履歴。
 */
export function terasHandlers(
  deps: Pick<ApiDeps, "store" | "engine" | "settings" | "container" | "catalog" | "compaction" | "discord" | "dataDir">,
) {
  const { store, settings, container, compaction, discord, dataDir } = deps;

  // 同じ Tera でターンが重なると、履歴の並びと引き受けの待ちが壊れる。
  // 「実行中かどうか」はターンの側が持つ（HTTP 層へ Set を渡さない）。
  const turns = createTurns(deps);
  // 同じ Tera を開いているほかの画面への配り口。送った画面自身には配らない。
  const broadcast = createConversationBroadcast();

  return {
    /** 画面に並べる Tera の一覧。既定の Tera と、エージェントが作った Tera。 */
    listTeras(): Response {
      return json({ teras: store.listTeras() });
    },

    /**
     * Tera を消す。履歴・identity・Discord の webhook・作業フォルダも一緒に消す。
     *
     * 応答を生成しているターンがある間は消さない（消えた保存先へ書き足そうとするため）。
     * 最後の 1 体を消したときは、既定の Tera を作り直す（画面の一覧を空にしない）。
     * 戻り値は消したあとの一覧で、画面はそれをそのまま置き換えられる。
     */
    async deleteTera(req: ApiRequest<{ id: string }>): Promise<Response> {
      const teraId = req.params.id;
      requireTera(store, teraId);

      // 停止を押したターンも、終わるまで履歴を書き足す。登録があるうちは消さない。
      if (turns.hasTurn(teraId)) {
        throw new ConflictError("turn_in_progress", "この Tera は応答を生成しているため削除できません");
      }

      // 走っている畳みを止めてから消す（同じ id を作り直した先へ、古い要約を書かせない）。
      await compaction.cancel(teraId);

      // webhook の置き場は Tera の一覧から作るので、行を消す前に消す。
      discord.clear(teraId);
      // 履歴・identity は行と一緒に消える。作業フォルダ（アップロードを含む）はここで消す。
      removeTeraWorkspace(dataDir, teraId);
      store.deleteTera(teraId);

      // 最後の 1 体だったときは、既定の Tera が作り直されている。その作業フォルダも用意する。
      const recreated = store.ensureAtLeastOneTera();
      if (recreated !== null) ensureTeraWorkspace(dataDir, recreated.id);

      return json({ teras: store.listTeras() });
    },

    /**
     * 履歴を 1 ページ返す。
     * limit は必須、before は「この seq より前」を表す（省略すると最新から）。
     * 画面に使わないツールの記録は落とし、件数だけでなく 1 件あたりの重さも抑える。
     */
    listMessages(req: MessagesRequest): Response {
      requireTera(store, req.params.id);

      const params = new URL(req.url).searchParams;
      const page = store.listMessagesPage(req.params.id, {
        limit: readPageLimit(params),
        before: readPageBefore(params),
      });

      return json({ messages: page.messages.map(toMessageView), hasMore: page.hasMore });
    },

    /**
     * その Tera を開いている画面の購読。ほかの画面で起きたターンの出来事を、そのまま流す。
     *
     * 最初に sync（最新の連番と、ターンが走っているか）を 1 つ流す。購読を張るまでの間に
     * 起きたことは、画面がその値を見て履歴を取り直す。状態を読むのと購読を始めるのを
     * 同じ区切りで行うので、その間の出来事を取りこぼさない。
     */
    subscribeEvents(req: ApiRequest<{ id: string }>): Response {
      const teraId = req.params.id;
      requireTera(store, teraId);
      const clientId = requireClientId(req.headers);

      const sync: ConversationEvent = {
        type: "sync",
        lastSeq: store.lastSeq(teraId),
        turnRunning: turns.isRunning(teraId),
      };
      const subscription = broadcast.subscribe(teraId, clientId, req.signal);
      return createSseResponse(startWith(sync, subscription), encodeConversationEvent);
    },

    /**
     * ユーザー発言を保存し、そのターンの応答を SSE で流す。
     * 会話は Tera ごとに 1 本なので、履歴はこの Tera に追記されていく。
     * 同じ出来事は、この Tera を開いているほかの画面にも配る（送った画面には配らない）。
     */
    async sendMessage(req: ApiRequest<{ id: string }>): Promise<Response> {
      // 無い Tera へ大きなファイルを送られたとき、本文を読む前に断る。
      requireTera(store, req.params.id);
      const clientId = requireClientId(req.headers);

      const form = await readTurnForm(req);
      if (form.content.length === 0 && form.files.length === 0) {
        throw new ValidationError("content or files must be provided");
      }

      // モデルを呼べない状態なら、ターンを始めずに理由を返す。
      // 呼び出しの中で初めて失敗すると、画面には「モデルから応答を得られませんでした」としか出せない。
      // ファイルを置く前に確かめて、無駄なファイルを残さない。
      const resolution = resolveModel(settings.read(), deps.catalog.snapshot());
      if (!resolution.ok) throw new AppError("model_not_configured", 400, resolution.detail);

      const uploaded = await saveUploads(container, req.params.id, form.files, req.signal);
      const attachments = uploaded.length === 0 ? null : uploaded;

      const events = turns.begin(req.params.id, {
        content: form.content,
        attachments,
        language: form.language,
      });
      if (events === null) {
        throw new ConflictError("turn_in_progress", "この Tera はほかで応答を生成しています");
      }
      return createSseResponse(broadcast.relay(req.params.id, events, clientId), encodeChatEvent, {
        continueOnCancel: true,
      });
    },

    /**
     * 最後のユーザー発言へ、ユーザー発言を増やさずにもう一度答える。
     * 画面が応答の終わりを受け取れなかったときのやり直しに使う。
     */
    async retryTurn(req: ApiRequest<{ id: string }>): Promise<Response> {
      const teraId = req.params.id;
      requireTera(store, teraId);
      const clientId = requireClientId(req.headers);

      const form = await readRetryForm(req);

      // モデルを呼べない状態なら、ターンを始めずに理由を返す（送信と同じ）。
      const resolution = resolveModel(settings.read(), deps.catalog.snapshot());
      if (!resolution.ok) throw new AppError("model_not_configured", 400, resolution.detail);

      // 最後のユーザー発言を探す。無ければ、答える先が無い。
      const page = store.listMessagesPage(teraId, { limit: 50, before: null });
      const last = [...page.messages].reverse().find((message) => message.role === "user");
      if (last === undefined) throw new ValidationError("there is no user message to retry");

      const events = turns.begin(
        teraId,
        { content: last.content, attachments: last.attachments, language: form.language },
        { startUserMessage: false },
      );
      if (events === null) {
        throw new ConflictError("turn_in_progress", "この Tera はほかで応答を生成しています");
      }
      return createSseResponse(broadcast.relay(teraId, events, clientId), encodeChatEvent, {
        continueOnCancel: true,
      });
    },

    /**
     * 応答を生成しているターンの途中へ、利用者の発言を足す。
     * 発言は通常の送信と同じく保存され、次のモデル呼び出しの直前に文脈の末尾へ入る。
     * ターンが動いていなければ 409 turn_not_running（画面は新しいターンとして送り直す）。
     */
    async steerTurn(req: ApiRequest<{ id: string }>): Promise<Response> {
      requireTera(store, req.params.id);
      const clientId = requireClientId(req.headers);

      // 足す先が無ければ、ファイルを置く前に断る（置いても誰も読まない）。
      if (!turns.isRunning(req.params.id)) throw noTurnError();

      const form = await readSteerForm(req);
      if (form.content.length === 0 && form.files.length === 0) {
        throw new ValidationError("content or files must be provided");
      }

      const uploaded = await saveUploads(container, req.params.id, form.files, req.signal);
      const attachments = uploaded.length === 0 ? null : uploaded;

      const message = turns.steer(req.params.id, { content: form.content, attachments });
      // 本文を読んでいる間にターンが終わった。画面は新しいターンとして送り直せる。
      if (message === null) throw noTurnError();

      // 足した発言は、この Tera を開いているほかの画面にも出す（送った画面には出さない）。
      broadcast.publish(req.params.id, { type: "user-message", message: toMessageView(message) }, clientId);
      return json({ message });
    },

    /**
     * 走っているターンを止める。止めたターンは、それまでに書いた本文や添付を保存して
     * assistant-done で終わる（SSE は閉じない。画面はそのまま結果を受け取れる）。
     * すでに終わっていても、止めるものが無いだけで成功にする（連打しても害が無い）。
     */
    stopTurn(req: ApiRequest<{ id: string }>): Response {
      requireTera(store, req.params.id);
      turns.stop(req.params.id);
      return noContent();
    },
  };
}

/** ターンが動いていないときの失敗。 */
function noTurnError(): AppError {
  return new ConflictError("turn_not_running", "この Tera は応答を生成していません");
}

/** 最初の 1 つ（いまの状態）を流してから、あとに続くイベントを流す。 */
async function* startWith(
  head: ConversationEvent,
  rest: AsyncIterable<ConversationEvent>,
): AsyncGenerator<ConversationEvent> {
  yield head;
  yield* rest;
}

/** 1 ページの件数。省略は受け付けない（読む量を呼ぶ側に決めさせる）。 */
function readPageLimit(params: URLSearchParams): number {
  const raw = params.get("limit");
  if (raw === null) throw new ValidationError("limit を指定してください");

  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_MESSAGE_PAGE) {
    throw new ValidationError(`limit は 1 から ${MAX_MESSAGE_PAGE} の整数で指定してください`);
  }
  return limit;
}

/** この seq より前を読む。省略すると最新から。 */
function readPageBefore(params: URLSearchParams): number | null {
  const raw = params.get("before");
  if (raw === null) return null;

  const before = Number(raw);
  if (!Number.isInteger(before) || before < 1) {
    throw new ValidationError("before は 1 以上の整数で指定してください");
  }
  return before;
}
