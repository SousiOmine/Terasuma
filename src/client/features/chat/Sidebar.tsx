import { IconRepeat, IconSettings, IconTrash, IconX } from "@tabler/icons-preact";
import { useEffect, useState } from "preact/hooks";
import type { Tera } from "../../../shared/api/message";
import { useDeleteTarget } from "../../hooks/useDeleteTarget";
import { t } from "../../i18n";
import { openTera } from "../../state/chat";
import { focusTeraId, openSettings } from "../../state/route";
import { activeTeraId, teras } from "../../state/session";
import { clearTeraError, removeTera, showTeraError, teraError } from "../../state/teras";
import { closeSidebar, sidebarOpen } from "../../state/sidebar";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { ContextMenu } from "../../ui/ContextMenu";
import { ErrorNotice } from "../../ui/ErrorNotice";
import { ChatAvatar } from "./ChatAvatar";

/**
 * Tera の一覧。会話は Tera ごとに 1 本なので、並ぶのは会話ではなく Tera。
 * 増やすのはエージェントの仕事（tera_create）なので、ここに作るボタンは置いていない。
 * 消すのはユーザーが決めるので、各行のボタンと、行の右クリックのメニューから消せる
 * （設定 > Tera にも同じ導線がある）。右クリックのメニューからは、その Tera の
 * ルーチンの管理（設定 > Tera のカード）も開ける。
 *
 * md 未満では、チャットに重ねて開くドロワーになる。
 * 開閉の状態は state/sidebar.ts が持ち、ヘッダーのメニューボタンから切り替える。
 */
export function Sidebar() {
  const items = teras.value;
  const open = sidebarOpen.value;
  const error = teraError.value;
  /** 消す対象。確認してから、履歴・webhook・作業フォルダごと消える。 */
  const deleting = useDeleteTarget<Tera>();
  /** 右クリックで開いているメニュー。どの行を右クリックしたかも持つ。 */
  const [menu, setMenu] = useState<{ point: { x: number; y: number }; tera: Tera } | null>(null);

  // 開いている間は Escape でも閉じられるようにする（ダイアログと同じ操作感にする）。
  // 削除の確認や右クリックのメニューを出している間は閉じない（Escape はそちらを閉じる操作になる）。
  useEffect(() => {
    if (!open || deleting.target !== null || menu !== null) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSidebar();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, deleting.target, menu]);

  return (
    <>
      {/* ドロワーの外側。タップで閉じる。 */}
      {open && (
        <div
          class="tera-fade-in fixed inset-0 z-40 bg-black/35 backdrop-blur-sm md:hidden"
          aria-hidden="true"
          onClick={closeSidebar}
        />
      )}

      <aside
        class={`fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] shrink-0 flex-col rounded-r-[28px] bg-surface transition-[transform,visibility] duration-200 md:visible md:static md:z-auto md:w-[248px] md:max-w-none md:translate-x-0 md:rounded-none md:bg-transparent md:pt-2 ${
          open ? "visible translate-x-0 shadow-[var(--app-shadow-16)] md:shadow-none" : "invisible -translate-x-full"
        }`}
      >
        <div class="flex h-16 shrink-0 items-center gap-2.5 px-4">
          <ChatAvatar size={30} />
          <span class="min-w-0 flex-1 truncate text-[15px] font-semibold tracking-[-0.01em]">{t("app.name")}</span>
          <button
            type="button"
            onClick={closeSidebar}
            title={t("chat.menu.close")}
            aria-label={t("chat.menu.close")}
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-secondary transition hover:bg-soft hover:text-primary md:hidden"
          >
            <IconX size={18} stroke={1.7} />
          </button>
        </div>

        <nav class="min-h-0 flex-1 overflow-y-auto px-2.5 py-1">
          {items.length === 0 ? (
            <p class="px-3 py-3 text-xs text-secondary">{t("tera.empty")}</p>
          ) : (
            <ul class="space-y-1">
              {items.map((tera) => {
                const active = activeTeraId.value === tera.id;

                return (
                  <li
                    key={tera.id}
                    onContextMenu={(event) => {
                      // ブラウザのメニューではなく、この Tera の操作を出す。
                      event.preventDefault();
                      setMenu({ point: { x: event.clientX, y: event.clientY }, tera });
                    }}
                  >
                    <button
                      type="button"
                      title={tera.name}
                      aria-current={active ? "true" : undefined}
                      onClick={() => {
                        closeSidebar();
                        void openTera(tera.id);
                      }}
                      class={`w-full truncate rounded-2xl py-2.5 pl-3.5 pr-3.5 text-left text-sm transition ${
                        active
                          ? "bg-[var(--app-accent-soft)] font-medium text-[var(--app-accent-ink)]"
                          : "text-secondary hover:bg-soft hover:text-primary"
                      }`}
                    >
                      {tera.name}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </nav>

        {error !== null && (
          <div class="shrink-0 px-2.5 pb-2">
            <ErrorNotice
              error={error}
              action={
                <button
                  type="button"
                  onClick={clearTeraError}
                  class="shrink-0 text-xs text-secondary transition hover:text-primary"
                >
                  {t("error.dismiss")}
                </button>
              }
            />
          </div>
        )}

        <SettingsButton />
      </aside>

      {/* 確認は aside の外に置く。aside は translate で変形されるので、
          中に置くと fixed の基準が aside になってしまう。 */}
      {deleting.target !== null && (
        <ConfirmDialog
          title={t("tera.deleteTitle")}
          subject={deleting.target.name}
          message={t("tera.deleteMessage")}
          confirmLabel={t("common.delete")}
          cancelLabel={t("common.cancel")}
          danger
          onConfirm={() => deleting.confirm(removeTera, showTeraError)}
          onCancel={deleting.close}
        />
      )}

      {/* 右クリックのメニューも aside の外に置く（確認と同じ理由）。 */}
      {menu !== null && (
        <ContextMenu
          label={t("tera.menu", { name: menu.tera.name })}
          point={menu.point}
          items={[
            {
              label: t("routine.title"),
              icon: <IconRepeat size={15} stroke={1.7} class="shrink-0" />,
              onSelect: () => {
                closeSidebar();
                focusTeraId.value = menu.tera.id;
                openSettings("teras");
              },
            },
            {
              label: t("common.delete"),
              icon: <IconTrash size={15} stroke={1.7} class="shrink-0" />,
              danger: true,
              onSelect: () => deleting.open(menu.tera),
            },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}

function SettingsButton() {
  return (
    <div class="shrink-0 p-2.5">
      <button
        type="button"
        onClick={() => {
          closeSidebar();
          openSettings();
        }}
        class="flex w-full items-center gap-2.5 rounded-2xl px-3.5 py-2.5 text-left text-sm text-secondary transition hover:bg-soft hover:text-primary"
      >
        <IconSettings size={16} stroke={1.6} class="shrink-0" />
        {t("settings.title")}
      </button>
    </div>
  );
}
