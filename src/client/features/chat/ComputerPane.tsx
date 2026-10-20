import { IconX } from "@tabler/icons-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { containerStatus } from "../../state/container";
import { t } from "../../i18n";
import {
  answerHandover,
  closeComputerPane,
  computerPaneOpen,
  computerViewOnly,
  handoverActive,
  handoverQuestion,
} from "../../state/handover";

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

/** noVNC の入り口。実行時にコンテナから読む（バンドラに解決させない）。 */
const NOVNC_MODULE_URL = "/api/computer/screen/core/rfb.js";

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

  const running = status?.state === "running";

  useEffect(() => {
    if (!open || !running) return;

    const target = targetRef.current;
    if (target === null) return;

    let disposed = false;
    let client: RfbClient | null = null;
    setConnection("connecting");

    void (async () => {
      const module = (await import(/* @vite-ignore */ NOVNC_MODULE_URL)) as { default: RfbConstructor };
      if (disposed) return;

      const protocol = location.protocol === "https:" ? "wss" : "ws";
      client = new module.default(target, `${protocol}://${location.host}/api/computer/vnc`);
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
    })();

    return () => {
      disposed = true;
      clientRef.current = null;
      client?.disconnect();
    };
  }, [open, running]);

  // 操作できるかどうかは、繋ぎ直さずに切り替える（引き受けの開始と終了で切り替わる）。
  useEffect(() => {
    if (clientRef.current !== null) clientRef.current.viewOnly = viewOnly;
  }, [viewOnly]);

  if (!open) return null;

  return (
    <aside class="flex w-[42%] min-w-80 shrink-0 flex-col p-3">
      <section class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <header class="flex h-12 shrink-0 items-center gap-2 border-b border-neutral-200 px-4 dark:border-neutral-800">
          <h2 class="min-w-0 flex-1 truncate text-sm font-medium">{t("chat.computer.title")}</h2>
          {active && (
            <span class="shrink-0 rounded-md bg-amber-100 px-2 py-0.5 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {t("chat.computer.yourTurn")}
            </span>
          )}
          <button
            type="button"
            onClick={closeComputerPane}
            title={t("chat.computer.hide")}
            aria-label={t("chat.computer.hide")}
            class="shrink-0 rounded-lg p-1 text-neutral-500 transition hover:bg-neutral-200/70 dark:text-neutral-400 dark:hover:bg-neutral-800"
          >
            <IconX size={16} stroke={1.6} />
          </button>
        </header>

        {active && (
          <div class="shrink-0 border-b border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-900/60 dark:bg-amber-950/40">
            <p class="text-xs leading-relaxed whitespace-pre-wrap text-amber-900 dark:text-amber-200">
              {question ?? t("chat.computer.yourTurn")}
            </p>
            <button
              type="button"
              onClick={() => void answerHandover({ kind: "done" })}
              class="mt-2 rounded-lg bg-neutral-900 px-2.5 py-1 text-xs text-white transition hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              {t("chat.computer.done")}
            </button>
          </div>
        )}

        {/* 画面を高さ方向の中央へ寄せる。周りはカードの背景のままにして、色を増やさない。 */}
        <div class="flex min-h-0 flex-1 overflow-auto p-3">
          {running ? (
            <div class="relative m-auto w-full">
              <div ref={targetRef} class="aspect-[16/10] w-full" />
              {connection !== "connected" && (
                <p class="absolute inset-0 flex items-center justify-center text-xs text-neutral-500 dark:text-neutral-400">
                  {t(connection === "connecting" ? "chat.computer.connecting" : "chat.computer.disconnected")}
                </p>
              )}
            </div>
          ) : (
            <p class="m-auto text-sm text-neutral-500 dark:text-neutral-400">{t("chat.computer.notRunning")}</p>
          )}
        </div>
      </section>
    </aside>
  );
}
