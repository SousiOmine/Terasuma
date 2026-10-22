import { IconCheck, IconCopy } from "@tabler/icons-preact";
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n";

/**
 * 認可コードのような、ユーザーが別の画面へ入力する短い文字列。
 *
 * クリップボードは HTTPS か localhost でしか使えないため、失敗してもコードは選べるようにしておく
 * （コピーできなくても、手で写せる）。
 */
export function CopyCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  // 別のコードに変わったら、コピーの表示を戻す。
  useEffect(() => {
    setCopied(false);
  }, [code]);

  const copy = async (): Promise<void> => {
    if (navigator.clipboard === undefined) return;

    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      // クリップボードが使えなくても、コードは選択して写せる。
    }
  };

  return (
    <div class="flex flex-wrap items-center gap-2">
      <code class="select-all rounded-[10px] bg-[var(--app-surface)] px-3 py-1.5 font-mono text-sm tracking-[0.08em]">
        {code}
      </code>
      <button
        type="button"
        onClick={() => void copy()}
        class="inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs font-medium text-[var(--app-text-secondary)] transition hover:bg-[var(--app-soft-strong)] hover:text-[var(--app-text)]"
      >
        {copied ? <IconCheck size={13} stroke={1.8} /> : <IconCopy size={13} stroke={1.8} />}
        {t(copied ? "common.copied" : "common.copy")}
      </button>
    </div>
  );
}
