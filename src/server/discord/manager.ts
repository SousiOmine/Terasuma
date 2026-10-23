import { rmSync } from "node:fs";
import { join } from "node:path";
import type { DiscordWebhookTeraView, DiscordWebhooksView } from "../../shared/api/discord";
import type { TeraDirectory } from "../data/store";
import { readPrivateJson, writePrivateJson } from "../data/secret-file";
import type { FetchLike } from "../http/client";
import { createPendingRegistry } from "../wait/pending";
import {
  parseWebhookUrl,
  sendWebhookMessage,
  verifyWebhook,
  type SentWebhookMessage,
  type WebhookMessage,
} from "./webhook";

/**
 * Discord の webhook（Tera ごとに 1 つ）。
 *
 * webhook を持つのは Tera なので、保存先も Tera ごとのファイルにする（0700 / 0600）。
 * URL は秘密なので、設定ファイル（config.json）や SQLite には置かない。
 *
 * 保存は「確かめてから書く」。受け付けられない URL を黙って保存すると、
 * 次の送信で初めて気づくことになる。保存できたら、待っているツールを解く。
 * 待ちは Tera ごとにまとめ、ターンが止まったら signal で外す。
 */

/** 保存する webhook。 */
export type StoredWebhook = {
  /** 正規化した webhook URL。 */
  url: string;
  /** Discord 側で付けた webhook の名前。分からなければ null。 */
  name: string | null;
  /** 送信先のチャンネル ID。分からなければ null。 */
  channelId: string | null;
  /** 確かめて保存した時刻。epoch ミリ秒。 */
  savedAt: number;
};

/** 読み出した結果。未設定と、読めなかった理由を区別する。 */
type WebhookState =
  | { kind: "none" }
  | { kind: "webhook"; webhook: StoredWebhook }
  | { kind: "unreadable"; detail: string };

/** webhook の保存を待っているツール 1 つ。 */
type Waiter = {
  resolve(text: string): void;
  reject(error: unknown): void;
};

export type DiscordWebhooks = {
  /** 設定画面に出す、Tera ごとの状態。 */
  view(): DiscordWebhooksView;
  /** 保存する。保存する前に webhook を確かめる。保存できたら、待っているツールを解く。 */
  set(teraId: string, url: string): Promise<DiscordWebhooksView>;
  /** 保存されている webhook を消す。待っているツールは失敗させる。 */
  clear(teraId: string): DiscordWebhooksView;
  /**
   * ツール用。接続済みなら使い方の文を返し、未接続なら保存されるまで待つ。
   * ターンが止まったら signal で待ちを外す。
   */
  wait(teraId: string, signal: AbortSignal): Promise<string>;
  /** 待っているツールを、取り消しの理由で失敗させる。 */
  cancelWait(teraId: string): void;
  /** メッセージを送る。未接続・読めないときは例外。ターンが止まったら signal で打ち切る。 */
  send(teraId: string, message: WebhookMessage, signal?: AbortSignal): Promise<SentWebhookMessage>;
  /** 待っているツールを止める。 */
  close(): void;
};

export type DiscordWebhooksOptions = {
  /** Tera の一覧と名前。 */
  store: TeraDirectory;
  /** webhook を置くデータディレクトリ。 */
  dataDir: string;
  /** 差し替えたいときだけ渡す（テスト用）。 */
  fetch?: FetchLike;
};

/** webhook を置くディレクトリの名前。 */
const DIR_NAME = "discord";

/** webhook の作り方を説明するページ。 */
const SETUP_URL = "https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks";

/** ターンが終わって、待ちを続けられなくなったときの理由。 */
const WAIT_ENDED = "The turn ended before the webhook URL was saved.";

export function createDiscordWebhooks(options: DiscordWebhooksOptions): DiscordWebhooks {
  const fetchImpl = options.fetch ?? fetch;

  /** webhook の保存を待っているツール（Tera id → 待ち）。同じ Tera を複数のツールが待てる。 */
  const pending = createPendingRegistry<string, Waiter>({ multiple: true });

  function pathOf(teraId: string): string {
    // 置き場は Tera の一覧にある id だけから作る（URL から来た文字列を、そのままファイル名にしない）。
    if (options.store.getTera(teraId) === null) {
      throw new Error(`Tera ${JSON.stringify(teraId)} is not known`);
    }
    return join(options.dataDir, DIR_NAME, `${teraId}.json`);
  }

  function load(teraId: string): WebhookState {
    const path = pathOf(teraId);
    const content = readPrivateJson(path);

    if (content.kind === "missing") return { kind: "none" };
    if (content.kind === "unreadable") return { kind: "unreadable", detail: content.detail };

    const webhook = storedWebhookOf(content.value);
    if (webhook === null) {
      return { kind: "unreadable", detail: `${path} の内容が Discord の webhook として読めません` };
    }
    return { kind: "webhook", webhook };
  }

  /** ツールへ返す、接続できたときの文。URL そのものは含めない。 */
  function connectedText(webhook: StoredWebhook): string {
    const target = webhook.channelId === null ? "the saved channel" : `channel ${webhook.channelId}`;

    return [
      `Discord is connected for this Tera: messages go to ${target}.`,
      "Find discord_send with tool_search and call it to post (the discord skill describes the limits).",
      "A webhook can only post; mentions do not notify anyone.",
    ].join(" ");
  }

  function resolveWaiters(teraId: string, text: string): void {
    for (const entry of pending.takeAll(teraId)) entry.pending.resolve(text);
  }

  function rejectWaiters(teraId: string, error: unknown): void {
    for (const entry of pending.takeAll(teraId)) entry.pending.reject(error);
  }

  /** webhook が保存されるまで待つ。ターンの中断で待ちを外す。 */
  function waitForWebhook(teraId: string, signal: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const entry = pending.register(teraId, { resolve, reject }, signal, () => reject(new Error(WAIT_ENDED)));
      if (entry === null) reject(new Error(WAIT_ENDED));
    });
  }

  function view(): DiscordWebhooksView {
    return {
      setupUrl: SETUP_URL,
      teras: options.store.listTeras().map((tera): DiscordWebhookTeraView => {
        const state = load(tera.id);

        return {
          teraId: tera.id,
          teraName: tera.name,
          connected: state.kind === "webhook",
          webhookName: state.kind === "webhook" ? state.webhook.name : null,
          channelId: state.kind === "webhook" ? state.webhook.channelId : null,
          detail: state.kind === "unreadable" ? state.detail : null,
        };
      }),
    };
  }

  return {
    view,

    async set(teraId, url) {
      // ファイルの置き場を先に決める（id が不正なら、通信する前に断る）。
      const path = pathOf(teraId);

      // 間違った URL を保存すると、次の送信で初めて失敗する。ここで確かめる。
      const webhook = parseWebhookUrl(url);
      const info = await verifyWebhook(webhook, fetchImpl);

      const stored: StoredWebhook = {
        url: webhook,
        name: info.name,
        channelId: info.channelId,
        savedAt: Date.now(),
      };
      writePrivateJson(path, stored, { createDirectory: true });
      resolveWaiters(teraId, connectedText(stored));
      return view();
    },

    clear(teraId) {
      rejectWaiters(teraId, new Error("The Discord webhook was removed."));
      rmSync(pathOf(teraId), { force: true });
      return view();
    },

    async wait(teraId, signal) {
      const state = load(teraId);

      if (state.kind === "unreadable") {
        throw new Error(
          `The saved Discord webhook could not be read (${state.detail}). Ask the user to save the URL again.`,
        );
      }
      if (state.kind === "webhook") return connectedText(state.webhook);

      return waitForWebhook(teraId, signal);
    },

    cancelWait(teraId) {
      rejectWaiters(teraId, new Error("The user cancelled the Discord webhook request."));
    },

    async send(teraId, message, signal) {
      const state = load(teraId);

      if (state.kind === "unreadable") {
        throw new Error(
          `The saved Discord webhook could not be read (${state.detail}). Ask the user to save the URL again.`,
        );
      }
      if (state.kind === "none") {
        throw new Error(
          "Discord is not connected for this Tera. Call discord_connect and let the user paste the webhook URL.",
        );
      }

      return sendWebhookMessage(state.webhook.url, message, fetchImpl, signal);
    },

    close() {
      for (const teraId of [...pending.keys()]) {
        rejectWaiters(teraId, new Error("Terasuma is shutting down; the Discord webhook request was cancelled."));
      }
    },
  };
}

/** 保存した形として読めるかどうか。壊れた値・別の用途の値を webhook として使わない。 */
function storedWebhookOf(value: unknown): StoredWebhook | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const url = record["url"];
  if (typeof url !== "string") return null;

  // 手で書き換えられた値でも、送信先として使える URL だけを受け付ける。
  let normalized: string;
  try {
    normalized = parseWebhookUrl(url);
  } catch {
    return null;
  }

  const name = record["name"];
  const channelId = record["channelId"];
  const savedAt = record["savedAt"];

  return {
    url: normalized,
    name: typeof name === "string" && name.length > 0 ? name : null,
    channelId: typeof channelId === "string" && channelId.length > 0 ? channelId : null,
    savedAt: typeof savedAt === "number" && Number.isFinite(savedAt) ? savedAt : 0,
  };
}
