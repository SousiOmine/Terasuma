import { useEffect, useRef, useState } from "preact/hooks";
import type { Session } from "../../shared/types";
import { t } from "../i18n";
import {
  activeSessionId,
  cancelDeleteSession,
  confirmDeleteSession,
  openSession,
  openSettings,
  pendingDeleteSession,
  renameSession,
  requestDeleteSession,
  sessions,
  startNewChat,
} from "../state";
import { ConfirmDialog } from "./ConfirmDialog";

export function Sidebar() {
  const items = sessions.value;
  const [menu, setMenu] = useState<OpenMenu | null>(null);

  /** 半端に見えている行でもメニューが画面内に収まるよう、先にボタンを表示域へ入れてから位置を測る。 */
  const openMenu = (session: Session, button: HTMLButtonElement) => {
    button.scrollIntoView({ block: "nearest" });
    setMenu({ session, button });
  };

  /** メニューを閉じ、フォーカスを開いたボタンへ戻す。 */
  const closeMenu = () => {
    const button = menu?.button;
    setMenu(null);
    button?.focus();
  };

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
                <SessionRow
                  session={session}
                  menuOpen={menu?.session.id === session.id}
                  onOpenMenu={openMenu}
                />
              </li>
            ))}
          </ul>
        )}
      </nav>

      <SettingsButton />

      {menu !== null && <SessionMenu session={menu.session} button={menu.button} onClose={closeMenu} />}
    </aside>
  );
}

/** 会話の削除は取り消せないため、画面の中央にダイアログを出して確認する。 */
export function DeleteSessionDialog() {
  const session = pendingDeleteSession.value;
  if (session === null) return null;

  return (
    <ConfirmDialog
      title={t("sidebar.deleteTitle")}
      subject={session.title ?? t("sidebar.untitled")}
      message={t("sidebar.deleteMessage")}
      confirmLabel={t("sidebar.confirmDelete")}
      cancelLabel={t("sidebar.cancel")}
      danger
      onConfirm={() => void confirmDeleteSession()}
      onCancel={cancelDeleteSession}
    />
  );
}

function SettingsButton() {
  return (
    <div class="shrink-0 border-t border-neutral-200 p-2 dark:border-neutral-800">
      <button
        type="button"
        onClick={() => openSettings()}
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

function MoreIcon() {
  return (
    <svg viewBox="0 0 16 16" class="size-4 shrink-0" fill="currentColor" aria-hidden="true">
      <circle cx="3.4" cy="8" r="1.3" />
      <circle cx="8" cy="8" r="1.3" />
      <circle cx="12.6" cy="8" r="1.3" />
    </svg>
  );
}

/**
 * 改名は行の中だけで完結させる。
 * window.prompt は埋め込み WebView の権限設定で使えないことがあるため、ネイティブダイアログに依存しない。
 */
type SessionRowProps = {
  session: Session;
  /** この行のメニューが開いているか。 */
  menuOpen: boolean;
  onOpenMenu: (session: Session, button: HTMLButtonElement) => void;
};

function SessionRow({ session, menuOpen, onOpenMenu }: SessionRowProps) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const title = session.title ?? t("sidebar.untitled");

  if (renaming) {
    const commit = () => {
      const next = draft.trim();
      setRenaming(false);
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
              setRenaming(false);
            }
          }}
          // Enter 以外で抜けた場合は取り消す（意図しない改名を防ぐ）。
          onBlur={() => setRenaming(false)}
        />
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
          setRenaming(true);
        }}
      >
        {title}
      </button>
      <button
        type="button"
        class={`shrink-0 rounded px-1 py-0.5 text-neutral-400 transition hover:text-neutral-700 focus:opacity-100 group-hover:opacity-100 dark:hover:text-neutral-200 ${
          menuOpen ? "opacity-100" : "opacity-0"
        }`}
        title={t("sidebar.menu")}
        aria-label={t("sidebar.menu")}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onClick={(event) => onOpenMenu(session, event.currentTarget)}
      >
        <MoreIcon />
      </button>
    </div>
  );
}

/** メニューを開いた状態。位置決めと、閉じたときのフォーカス戻しにボタンを使う。 */
type OpenMenu = {
  session: Session;
  button: HTMLButtonElement;
};

/** ボタンとメニューの間隔。一覧の下端にボタンがあっても、設定ボタンの分だけ下に余地がある。 */
const MENU_GAP = 4;

type SessionMenuProps = {
  session: Session;
  button: HTMLButtonElement;
  onClose: () => void;
};

/**
 * 会話ごとの操作メニュー。
 * 行の中に置くと一覧のスクロールで切れるため、画面座標で位置を決めて前面に出す。
 */
function SessionMenu({ session, button, onClose }: SessionMenuProps) {
  const itemRef = useRef<HTMLButtonElement>(null);
  const anchor = button.getBoundingClientRect();

  useEffect(() => {
    // 開いた直後は項目へフォーカスを移し、キー操作をここで受ける。
    itemRef.current?.focus();
  }, []);

  return (
    <>
      {/* 外側のクリックで閉じる。 */}
      <div class="fixed inset-0 z-30" aria-hidden="true" onClick={onClose} />

      <div
        role="menu"
        aria-label={t("sidebar.menu")}
        class="fixed z-40 min-w-28 rounded-lg border border-neutral-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-800"
        style={{ top: `${anchor.bottom + MENU_GAP}px`, right: `${window.innerWidth - anchor.right}px` }}
        onKeyDown={(event) => {
          // Tab で背景へ抜けると、メニューが残ったまま後ろの要素を操作できてしまう。
          if (event.key === "Escape" || event.key === "Tab") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <button
          ref={itemRef}
          type="button"
          role="menuitem"
          class="block w-full px-3 py-1.5 text-left text-sm text-red-600 transition hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          onClick={() => {
            onClose();
            requestDeleteSession(session.id);
          }}
        >
          {t("sidebar.delete")}
        </button>
      </div>
    </>
  );
}
