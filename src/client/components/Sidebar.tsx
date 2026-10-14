import { IconDots, IconPlus, IconSettings, IconTrash } from "@tabler/icons-preact";
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
          class="flex w-full items-center gap-2 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-left text-sm transition hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
        >
          <IconPlus size={16} stroke={1.6} class="shrink-0" />
          {t("sidebar.new")}
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
        <IconSettings size={16} stroke={1.6} class="shrink-0" />
        {t("settings.title")}
      </button>
    </div>
  );
}

type SessionRowProps = {
  session: Session;
  /** この行のメニューが開いているか。 */
  menuOpen: boolean;
  onOpenMenu: (session: Session, button: HTMLButtonElement) => void;
};

function SessionRow({ session, menuOpen, onOpenMenu }: SessionRowProps) {
  const title = session.title ?? t("sidebar.untitled");
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
        title={title}
        onClick={() => void openSession(session.id)}
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
        <IconDots size={16} stroke={1.6} />
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
          class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-600 transition hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          onClick={() => {
            onClose();
            requestDeleteSession(session.id);
          }}
        >
          <IconTrash size={16} stroke={1.6} class="shrink-0" />
          {t("sidebar.delete")}
        </button>
      </div>
    </>
  );
}
