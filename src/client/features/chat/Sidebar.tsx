import { IconSettings, IconX } from "@tabler/icons-preact";
import { useEffect } from "preact/hooks";
import { t } from "../../i18n";
import { openTera } from "../../state/chat";
import { openSettings } from "../../state/route";
import { activeTeraId, teras } from "../../state/session";
import { closeSidebar, sidebarOpen } from "../../state/sidebar";

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
      {open && <div class="fixed inset-0 z-40 bg-black/40 md:hidden" aria-hidden="true" onClick={closeSidebar} />}

      <aside
        class={`fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] shrink-0 flex-col border-r border-black/5 bg-[#f4f8f5] transition-[transform,visibility] duration-200 md:visible md:static md:z-auto md:w-60 md:max-w-none md:translate-x-0 dark:border-white/5 dark:bg-[#0b100d] ${
          open ? "visible translate-x-0 shadow-xl md:shadow-none" : "invisible -translate-x-full"
        }`}
      >
        <div class="flex h-14 shrink-0 items-center gap-2 px-4">
          <span class="min-w-0 flex-1 truncate text-sm font-semibold tracking-wide">{t("app.name")}</span>
          <button
            type="button"
            onClick={closeSidebar}
            title={t("chat.menu.close")}
            aria-label={t("chat.menu.close")}
            class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-black/5 md:hidden dark:text-neutral-400 dark:hover:bg-white/5"
          >
            <IconX size={18} stroke={1.7} />
          </button>
        </div>

        <nav class="min-h-0 flex-1 overflow-y-auto p-2">
          {items.length === 0 ? (
            <p class="px-2 py-3 text-xs text-neutral-500 dark:text-neutral-400">{t("tera.empty")}</p>
          ) : (
            <ul class="space-y-0.5">
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
                      class={`w-full truncate rounded-xl px-3 py-2.5 text-left text-sm transition md:py-2 ${
                        active
                          ? "bg-[#06c755]/12 font-medium text-[#066c36] dark:bg-[#06c755]/15 dark:text-[#7be0a3]"
                          : "text-neutral-700 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
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
    <div class="shrink-0 border-t border-black/5 p-2 dark:border-white/5">
      <button
        type="button"
        onClick={() => {
          closeSidebar();
          openSettings();
        }}
        class="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm text-neutral-600 transition hover:bg-black/5 md:py-2 dark:text-neutral-300 dark:hover:bg-white/5"
      >
        <IconSettings size={16} stroke={1.6} class="shrink-0" />
        {t("settings.title")}
      </button>
    </div>
  );
}
