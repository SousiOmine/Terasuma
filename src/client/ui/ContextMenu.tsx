import type { ComponentChildren } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { fitMenuPosition, type MenuPoint } from "../lib/context-menu";

/** メニューの 1 項目。 */
export type ContextMenuItem = {
  label: string;
  /** 文字の左に置くアイコン。 */
  icon?: ComponentChildren;
  /** 取り消せない操作のとき true。文字を赤くする。 */
  danger?: boolean;
  onSelect: () => void;
};

export type ContextMenuProps = {
  /** 何のメニューかを読み上げる名前。 */
  label: string;
  /** 右クリックした位置（画面の左上からの px）。 */
  point: MenuPoint;
  items: readonly ContextMenuItem[];
  onClose: () => void;
};

/**
 * 右クリックした位置に出すメニュー。
 *
 * 画面の端では、はみ出さない位置へ寄せる。大きさを測ってから置き直すので、ちらつかない。
 * 外側の押下・Escape・スクロール・画面の大きさの変化で閉じる。
 *
 * ダイアログと同じく、変形（transform）された要素の中には置かない
 * （中に置くと fixed の基準がその要素になってしまうため）。
 */
export function ContextMenu({ label, point, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<MenuPoint>(point);

  // 測ってから、画面からはみ出さない位置へ置き直す（描画の前に済ませる）。
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const rect = element.getBoundingClientRect();
    setPosition(
      fitMenuPosition(
        point,
        { width: rect.width, height: rect.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
    element.focus();
  }, [point]);

  // Escape・スクロール・画面の大きさの変化で閉じる。
  useEffect(() => {
    const close = (): void => onClose();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    const handleViewportChange = (): void => close();

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("scroll", handleViewportChange, true);
    window.addEventListener("resize", handleViewportChange);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("scroll", handleViewportChange, true);
      window.removeEventListener("resize", handleViewportChange);
    };
  }, [onClose]);

  return (
    <>
      {/* メニューの外の押下はこの受け皿で受ける。下の要素へ届かせない。
          pointerdown で閉じると、受け皿が消えたあとの click が下へ抜けるので click で閉じる。 */}
      <div
        class="fixed inset-0 z-50"
        aria-hidden="true"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />

      <div
        ref={ref}
        role="menu"
        aria-label={label}
        tabIndex={-1}
        style={{ left: `${position.x}px`, top: `${position.y}px` }}
        class="fixed z-50 min-w-44 rounded-[18px] border border-stroke bg-surface p-1 shadow-[var(--app-shadow-16)] outline-none"
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              item.onSelect();
            }}
            class={`flex w-full items-center gap-2 rounded-[12px] px-3 py-2 text-left text-sm transition ${
              item.danger ? "text-[var(--app-danger)] hover:bg-[var(--app-danger-soft)]" : "text-primary hover:bg-soft"
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
