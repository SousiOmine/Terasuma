import { IconSettings, IconX } from "@tabler/icons-preact";
import { useEffect } from "preact/hooks";
import { t } from "../../i18n";
import { openTera } from "../../state/chat";
import { openSettings } from "../../state/route";
import { activeTeraId, teras } from "../../state/session";
import { closeSidebar, sidebarOpen } from "../../state/sidebar";
import { ChatAvatar } from "./ChatAvatar";

/**
 * Tera の一覧。会話は Tera ごとに 1 本なので、並ぶのは会話ではなく Tera。
 * いまは既定の 1 体だけなので、増やす導線は置いていない。
 *
 * md 未満では、チャットに重ねて開くドロワーになる。
 * 開閉の状態は state/sidebar.ts が持ち、ヘッダーのメニューボタンから切り替える。
 */
export function Sidebar() {
  const items = teras.value;
  const open = sidebarOpen.value;

  // 開いている間は Escape でも閉じられるようにする（ダイアログと同じ操作感にする）。
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeSidebar();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

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
                  <li key={tera.id}>
                    <button
                      type="button"
                      title={tera.name}
                      aria-current={active ? "true" : undefined}
                      onClick={() => {
                        closeSidebar();
                        void openTera(tera.id);
                      }}
                      class={`w-full truncate rounded-2xl px-3.5 py-2.5 text-left text-sm transition ${
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

        <SettingsButton />
      </aside>
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
