import { useEffect, useRef, useState } from "preact/hooks";
import type { Session } from "../../shared/types";
import { t } from "../i18n";
import {
  activeSessionId,
  openSession,
  openSettings,
  removeSession,
  renameSession,
  sessions,
  startNewChat,
} from "../state";

export function Sidebar() {
  const items = sessions.value;

  return (
    <aside class="flex w-64 shrink-0 flex-col border-r border-neutral-200 bg-neutral-100/70 dark:border-neutral-800 dark:bg-neutral-900/40">
      <div class="flex h-12 shrink-0 items-center px-4">
        <span class="text-sm font-semibold tracking-wide">{t("app.name")}</span>
      </div>

      <div class="px-3 pb-2">
        <button
          type="button"
          onClick={startNewChat}
          class="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-left text-sm transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
        >
          ＋ {t("sidebar.new")}
        </button>
      </div>

      <nav class="min-h-0 flex-1 overflow-y-auto px-2">
        {items.length === 0 ? (
          <p class="px-2 py-3 text-xs text-neutral-500 dark:text-neutral-400">{t("sidebar.empty")}</p>
        ) : (
          <ul class="space-y-0.5 pb-2">
            {items.map((session) => (
              <li key={session.id}>
                <SessionRow session={session} />
              </li>
            ))}
          </ul>
        )}
      </nav>

      <SettingsButton />
    </aside>
  );
}

function SettingsButton() {
  return (
    <div class="shrink-0 border-t border-neutral-200 p-2 dark:border-neutral-800">
      <button
        type="button"
        onClick={openSettings}
        class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-neutral-600 transition hover:bg-neutral-200/60 dark:text-neutral-300 dark:hover:bg-neutral-800/60"
      >
        <GearIcon />
        {t("settings.title")}
      </button>
    </div>
  );
}

function GearIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      class="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2.4" />
      <path d="M8 1.6v1.9M8 12.5v1.9M1.6 8h1.9M12.5 8h1.9M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3" />
    </svg>
  );
}

/**
 * 削除と改名はこの行の中だけで完結させる。
 * window.confirm / prompt は埋め込み WebView の権限設定で使えないことがあるため、
 * ネイティブダイアログに依存しない。
 */
type RowMode = "idle" | "confirm-delete" | "rename";

function SessionRow({ session }: { session: Session }) {
  const [mode, setMode] = useState<RowMode>("idle");
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === "rename") inputRef.current?.select();
  }, [mode]);

  const title = session.title ?? t("sidebar.untitled");

  if (mode === "rename") {
    const commit = () => {
      const next = draft.trim();
      setMode("idle");
      if (next.length > 0 && next !== session.title) void renameSession(session.id, next);
    };

    return (
      <div class="flex items-center gap-1 px-2 py-1">
        <input
          ref={inputRef}
          value={draft}
          aria-label={t("sidebar.rename")}
          class="min-w-0 flex-1 rounded border border-neutral-300 bg-white px-1.5 py-1 text-sm outline-none dark:border-neutral-600 dark:bg-neutral-900"
          onInput={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setMode("idle");
            }
          }}
          // Enter 以外で抜けた場合は取り消す（意図しない改名を防ぐ）。
          onBlur={() => setMode("idle")}
        />
      </div>
    );
  }

  if (mode === "confirm-delete") {
    return (
      <div class="flex items-center gap-1 rounded-lg bg-red-50 px-2 py-1.5 text-sm dark:bg-red-950/40">
        <button
          type="button"
          class="min-w-0 flex-1 truncate text-left text-red-700 dark:text-red-300"
          onClick={() => void removeSession(session.id)}
        >
          {t("sidebar.confirmDelete")}
        </button>
        <button
          type="button"
          class="shrink-0 rounded px-1 text-xs text-neutral-500 transition hover:text-neutral-800 dark:hover:text-neutral-200"
          onClick={() => setMode("idle")}
        >
          {t("sidebar.cancel")}
        </button>
      </div>
    );
  }

  const active = activeSessionId.value === session.id;

  return (
    <div
      class={`group flex items-center gap-1 rounded-lg px-2 py-2 text-sm ${
        active
          ? "bg-white shadow-sm dark:bg-neutral-800"
          : "hover:bg-neutral-200/60 dark:hover:bg-neutral-800/50"
      }`}
    >
      <button
        type="button"
        class="min-w-0 flex-1 truncate text-left"
        title={`${title}\n${t("sidebar.renameHint")}`}
        onClick={() => void openSession(session.id)}
        onDblClick={() => {
          setDraft(session.title ?? "");
          setMode("rename");
        }}
      >
        {title}
      </button>
      <button
        type="button"
        class="shrink-0 rounded px-1 text-xs text-neutral-400 opacity-0 transition group-hover:opacity-100 hover:text-red-500 focus:opacity-100"
        title={t("sidebar.delete")}
        aria-label={t("sidebar.delete")}
        onClick={() => setMode("confirm-delete")}
      >
        ✕
      </button>
    </div>
  );
}
