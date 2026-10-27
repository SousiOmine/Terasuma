import { IconCheck, IconCopy } from "@tabler/icons-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../i18n";
import { copyText } from "../lib/clipboard";

type CopyState = "idle" | "copied" | "failed";

/** 本文をクリップボードへ写す、アイコンだけの丸ボタン。 */
export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | null>(null);
  const label = state === "copied" ? t("chat.copy.done") : state === "failed" ? t("chat.copy.failed") : t("chat.copy");

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const handleClick = async (): Promise<void> => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }

    const copied = await copyText(text);
    setState(copied ? "copied" : "failed");
    timer.current = window.setTimeout(() => {
      setState("idle");
      timer.current = null;
    }, 1200);
  };

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      title={label}
      aria-label={label}
      class={`relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-tertiary transition hover:bg-soft hover:text-primary active:scale-95 ${
        state === "copied" ? "text-[var(--app-success)]" : state === "failed" ? "text-[var(--app-danger)]" : ""
      }`}
    >
      {state === "copied" ? <IconCheck size={13} stroke={1.7} /> : <IconCopy size={13} stroke={1.7} />}
      <span class="sr-only" aria-live="polite">
        {state === "idle" ? "" : label}
      </span>
    </button>
  );
}
