import { IconExternalLink } from "@tabler/icons-preact";
import type { ComponentChildren } from "preact";
import { Button } from "../../ui/Button";

export type ConnectorFormProps = {
  /** 接続の手順を開くページ。 */
  setupUrl: string;
  /** 手順のリンクの文言。 */
  setupLabel: string;
  /** 送信ボタンの文言。 */
  submitLabel: string;
  submitDisabled: boolean;
  onSubmit: () => void;
  /** 送信の左に置く操作（チャットのカードの「やめる」）。 */
  cancel?: ComponentChildren;
  /** 入力欄（Field を縦に並べる）。 */
  children: ComponentChildren;
};

/**
 * コネクタのカードの中身。
 *
 * コネクタごとに部品の位置が変わると、どこを押せばよいか毎回探すことになる。
 * 入力欄 → 区切り線 → 左に手順のリンク、右に送信、の 1 つの形に揃える。
 */
export function ConnectorForm({
  setupUrl,
  setupLabel,
  submitLabel,
  submitDisabled,
  onSubmit,
  cancel,
  children,
}: ConnectorFormProps) {
  return (
    <div class="mt-3">
      <div class="space-y-1">{children}</div>
      <div class="mt-2 flex flex-col gap-3 border-t border-stroke pt-3 sm:flex-row sm:items-center sm:justify-between">
        {setupUrl.length > 0 ? (
          <a
            href={setupUrl}
            target="_blank"
            rel="noreferrer noopener"
            class="inline-flex items-center gap-1 text-xs text-secondary underline underline-offset-2"
          >
            <IconExternalLink size={12} stroke={1.6} class="shrink-0" />
            {setupLabel}
          </a>
        ) : (
          <span />
        )}
        <div class="flex items-center justify-end gap-2">
          {cancel}
          <Button variant="primary" disabled={submitDisabled} onClick={onSubmit}>
            {submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
