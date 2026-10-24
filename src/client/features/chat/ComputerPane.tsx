import { IconSend, IconX } from "@tabler/icons-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { sendMessage } from "../../state/chat";
import { containerStatus, fetchVncToken } from "../../state/container";
import { envRequestActive } from "../../state/env-request";
import { chatError, clearChatError } from "../../state/failure";
import { t } from "../../i18n";
import { ErrorNotice } from "../../ui/ErrorNotice";
import {
  answerHandover,
  closeComputerPane,
  computerPaneOpen,
  computerViewOnly,
  handoverActive,
  handoverQuestion,
} from "../../state/handover";
import { EnvRequestPanel } from "./EnvRequestPanel";

/**
 * 右ペイン。いまはコンテナの画面を noVNC で映す。
 *
 * チャットとは別のカードとして浮かせて置く（角丸・枠・影を付ける）。
 * コンピュータ以外の中身をここへ足せるよう、見出しと本文はカードの中に閉じ込めておく。
 *
 * 開いている間だけ繋ぎ、閉じたら WebSocket も切る。
 * 操作できるのはエージェントから引き受けている間だけで、ふだんは見るだけ。
 * 画面の大きさは 1280x800 のまま動かさない（撮った画像と座標の対応を保つため）。
 */

/** noVNC の RFB。コンテナから配られるので、こちらは使う分だけの形を置く。 */
type RfbClient = {
  viewOnly: boolean;
  scaleViewport: boolean;
  background: string;
  disconnect(): void;
  addEventListener(type: string, listener: (event: Event) => void): void;
};

type RfbConstructor = new (
  target: Element,
  url: string,
  options?: { credentials?: { password?: string } },
) => RfbClient;

/** 接続の様子。画面が出るまでの間も何か出しておく（真っ黒なままだと壊れて見える）。 */
type ConnectionState = "connecting" | "connected" | "disconnected";

export function ComputerPane() {
  const open = computerPaneOpen.value;
  const status = containerStatus.value;
  const viewOnly = computerViewOnly.value;

  const active = handoverActive.value;
  const question = handoverQuestion.value;
  const targetRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef<RfbClient | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  /** 再接続の回数。変えると下の effect が片付けてから繋ぎ直す。 */
  const [attempt, setAttempt] = useState(0);
  /** 引き受け中に送る返事。全画面で開く狭い画面では、チャットの入力欄に触れない。 */
  const [answer, setAnswer] = useState("");
  const [sending, setSending] = useState(false);

  const running = status?.state === "running";

  useEffect(() => {
    if (!open || !running) return;

    const target = targetRef.current;
    if (target === null) return;

    let disposed = false;
    let client: RfbClient | null = null;
    setConnection("connecting");

    void (async () => {
      try {
        // noVNC はアプリのバンドルに同梱する（コンテナから配ると、コンテナの書き換えが
        // Terasuma のオリジンで実行されてしまう）。
        const [module, token] = await Promise.all([
          import("@novnc/novnc") as Promise<{ default: RfbConstructor }>,
          fetchVncToken(),
        ]);
        if (disposed) return;

        const protocol = location.protocol === "https:" ? "wss" : "ws";
        const url = `${protocol}://${location.host}/api/computer/vnc?token=${encodeURIComponent(token)}`;
        client = new module.default(target, url);
        client.viewOnly = computerViewOnly.value;
        client.scaleViewport = true;
        // 画面が入りきらない部分（接続中など）は、下のカードの背景をそのまま見せる。
        // 既定の黒を敷くと、画面が出るまでの間だけ黒い帯になる。
        client.background = "transparent";
        client.addEventListener("connect", () => {
          if (!disposed) setConnection("connected");
        });
        client.addEventListener("disconnect", () => {
          if (!disposed) setConnection("disconnected");
        });
        clientRef.current = client;
      } catch (error) {
        if (disposed) return;
        console.error(error);
        setConnection("disconnected");
      }
    })();

    return () => {
      disposed = true;
      clientRef.current = null;
      client?.disconnect();
    };
  }, [open, running, attempt]);

  // 操作できるかどうかは、繋ぎ直さずに切り替える（引き受けの開始と終了で切り替わる）。
  useEffect(() => {
    if (clientRef.current !== null) clientRef.current.viewOnly = viewOnly;
  }, [viewOnly]);

  const canAnswer = answer.trim().length > 0 && !sending;

  /**
   * 引き受けの返事を送る。
   * 引き受け中なので、sendMessage は新しい発言ではなくツールの戻り値として届ける。
   */
  const submitAnswer = async (): Promise<void> => {
    if (!canAnswer) return;

    const text = answer.trim();
    setAnswer("");
    setSending(true);
    try {
      await sendMessage(text, []);
    } finally {
      setSending(false);
    }
  };

  if (!open) return null;

  return (
    <aside class="tera-pane-in fixed inset-0 z-30 flex flex-col p-0 md:static md:z-auto md:w-[42%] md:min-w-80 md:shrink-0 md:p-3">
      <section class="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface md:rounded-[30px] md:border md:border-stroke md:shadow-[var(--app-shadow-panel)]">
        <header class="flex h-16 shrink-0 items-center gap-3 px-4">
          <h2 class="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em]">
            {t("chat.computer.title")}
          </h2>
          {active && (
            <span class="shrink-0 rounded-full bg-[var(--app-accent-soft)] px-2.5 py-1 text-[11px] font-medium text-[var(--app-accent-ink)]">
              {t("chat.computer.yourTurn")}
            </span>
          )}
          <button
            type="button"
            onClick={closeComputerPane}
            title={t("chat.computer.hide")}
            aria-label={t("chat.computer.hide")}
            class="-mr-2 flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-secondary transition hover:bg-soft hover:text-primary md:mr-0 md:h-auto md:w-auto md:p-1"
          >
            <IconX size={16} stroke={1.6} />
          </button>
        </header>

        {active && (
          <div class="tera-rise-in mx-3 mt-3 shrink-0 rounded-[16px] bg-[var(--app-accent-soft)] px-4 py-3">
            <p class="text-xs leading-relaxed whitespace-pre-wrap text-primary">
              {question ?? t("chat.computer.yourTurn")}
            </p>
            <button
              type="button"
              onClick={() => void answerHandover({ kind: "done" })}
              class="mt-2 rounded-full bg-[var(--app-accent-fill)] px-3 py-1.5 text-xs font-medium text-[var(--app-on-accent)] transition hover:bg-[var(--app-accent-hover)]"
            >
              {t("chat.computer.done")}
            </button>

            {/* 全画面で開く狭い画面ではチャットの入力欄に触れないので、ここでも返事を書けるようにする。 */}
            <form
              class="mt-3 md:hidden"
              onSubmit={(event) => {
                event.preventDefault();
                void submitAnswer();
              }}
            >
              <div class="flex items-center gap-1.5 rounded-full border border-stroke bg-surface px-2 py-2 shadow-[var(--app-shadow-2)] transition focus-within:border-[var(--app-accent)] focus-within:shadow-[0_0_0_4px_var(--app-ring)]">
                <input
                  type="text"
                  value={answer}
                  placeholder={t("chat.computer.answer")}
                  aria-label={t("chat.computer.answer")}
                  enterkeyhint="send"
                  class="min-w-0 flex-1 bg-transparent px-2 py-1 text-[15px] text-primary outline-none placeholder:text-tertiary"
                  onInput={(event) => setAnswer(event.currentTarget.value)}
                />
                <button
                  type="submit"
                  disabled={!canAnswer}
                  title={t("composer.send")}
                  aria-label={t("composer.send")}
                  class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--app-accent-fill)] text-[var(--app-on-accent)] transition hover:bg-[var(--app-accent-hover)] disabled:opacity-30"
                >
                  <IconSend size={16} stroke={1.8} />
                </button>
              </div>
            </form>

            {/* チャット側の失敗の表示は、全画面のペインに隠れる。狭い画面ではここにも出す。 */}
            {chatError.value !== null && (
              <div class="mt-2 md:hidden">
                <ErrorNotice
                  error={chatError.value}
                  action={
                    <button
                      type="button"
                      onClick={clearChatError}
                      class="shrink-0 text-xs opacity-70 transition hover:opacity-100"
                    >
                      {t("error.dismiss")}
                    </button>
                  }
                />
              </div>
            )}
          </div>
        )}

        {/* 狭い画面ではチャットの入力欄に触れないので、環境変数の入力欄もここに出す。 */}
        {envRequestActive.value && (
          <div class="mx-3 mt-3 shrink-0 md:hidden">
            <EnvRequestPanel />
          </div>
        )}

        {/* 画面を高さ方向の中央へ寄せる。周りはカードの背景のままにして、色を増やさない。 */}
        <div class="flex min-h-0 flex-1 overflow-hidden p-0 md:overflow-auto md:p-3">
          {running ? (
            <div class="relative m-auto h-full w-full md:h-auto md:aspect-[16/10]">
              <div ref={targetRef} class="h-full w-full" />
              {connection !== "connected" && (
                <div class="absolute inset-0 flex flex-col items-center justify-center text-xs text-secondary">
                  <p>{t(connection === "connecting" ? "chat.computer.connecting" : "chat.computer.disconnected")}</p>
                  {connection === "disconnected" && (
                    <button
                      type="button"
                      onClick={() => setAttempt((count) => count + 1)}
                      class="mt-3 rounded-full bg-[var(--app-accent-fill)] px-3 py-1.5 text-xs font-medium text-[var(--app-on-accent)] transition hover:bg-[var(--app-accent-hover)]"
                    >
                      {t("chat.computer.reconnect")}
                    </button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p class="m-auto text-sm text-secondary">{t("chat.computer.notRunning")}</p>
          )}
        </div>
      </section>
    </aside>
  );
}
