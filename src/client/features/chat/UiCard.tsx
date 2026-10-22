import { useId, useState } from "preact/hooks";
import type { UiBlock, UiChoiceBlock, UiField, UiFormBlock, UiView } from "../../../shared/ui-markup";
import { interactiveBlock } from "../../../shared/ui-markup";
import { t } from "../../i18n";
import { choiceMessage, formComplete, formMessage } from "../../lib/ui";
import { sendMessage } from "../../state/chat";
import { Flowchart } from "../../ui/Flowchart";
import { INPUT_CLASS } from "../../ui/styles";

/**
 * Tera が送った UI のカード。
 *
 * 中身は chat_ui のツール呼び出しのマークアップから組み立てた UiView。
 * 選択肢を押すと、そのラベルを新しいユーザー発言として送る（ターンを待たない）。
 * 応答を作っている間は押せない（送っても次のターンとして扱われないため）。
 *
 * マークアップを読めなかったときは、理由を出さずに断りのカードを出す。
 * 直せなかった理由はツールの戻り値としてモデルへ渡っている。
 */
export function UiCard({ view, disabled }: { view: UiView | null; disabled: boolean }) {
  if (view === null) {
    return (
      <section class="rounded-[20px] border border-[var(--app-stroke)] bg-[var(--app-surface-alt)] p-4">
        <p class="text-xs leading-5 text-[var(--app-text-secondary)]">{t("chat.ui.invalid")}</p>
      </section>
    );
  }

  const awaitingTurn = disabled && interactiveBlock(view) !== null;

  return (
    <section class="rounded-[20px] border border-[var(--app-stroke)] bg-[var(--app-surface-alt)] p-4">
      {view.title !== null && <h3 class="mb-2 text-[13px] font-medium text-[var(--app-text)]">{view.title}</h3>}

      <div class="flex flex-col gap-3">
        {view.blocks.map((block, index) => (
          <BlockView key={index} block={block} disabled={disabled} />
        ))}
      </div>

      {awaitingTurn && (
        <p class="mt-3 text-[11px] leading-5 text-[var(--app-text-tertiary)]">{t("chat.ui.awaitingTurn")}</p>
      )}
    </section>
  );
}

function BlockView({ block, disabled }: { block: UiBlock; disabled: boolean }) {
  switch (block.type) {
    case "text":
      return <p class="whitespace-pre-wrap break-words text-[13px] leading-6 text-[var(--app-text)]">{block.text}</p>;

    case "list":
      return <ListBlock block={block} />;

    case "table":
      return <TableBlock rows={block.rows} />;

    case "flow":
      return <Flowchart block={block} />;

    case "choice":
      return <ChoiceBlock block={block} disabled={disabled} />;

    case "form":
      return <FormBlock block={block} disabled={disabled} />;
  }
}

function ListBlock({ block }: { block: Extract<UiBlock, { type: "list" }> }) {
  const items = block.items.map((item, index) => (
    <li key={index} class="break-words">
      {item}
    </li>
  ));

  return block.ordered ? (
    <ol class="list-decimal pl-5 text-[13px] leading-6 text-[var(--app-text)]">{items}</ol>
  ) : (
    <ul class="list-disc pl-5 text-[13px] leading-6 text-[var(--app-text)]">{items}</ul>
  );
}

/** 先頭の行を見出しにした表。 */
function TableBlock({ rows }: { rows: readonly (readonly string[])[] }) {
  const header = rows[0];
  if (header === undefined) return null;

  return (
    <div class="max-w-full overflow-x-auto">
      <table class="w-full border-collapse text-left text-[12px]">
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th
                key={index}
                class="border-b border-[var(--app-stroke)] px-2 py-1.5 font-medium text-[var(--app-text-secondary)]"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(1).map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td
                  key={cellIndex}
                  class="border-b border-[var(--app-stroke)] px-2 py-1.5 align-top text-[var(--app-text)]"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const OPTION_CLASS =
  "rounded-[14px] border px-3 py-2 text-left transition disabled:cursor-not-allowed disabled:opacity-50";
const OPTION_ON_CLASS = "border-[var(--app-accent)] bg-[var(--app-accent-soft)]";
const OPTION_OFF_CLASS = "border-[var(--app-stroke)] bg-[var(--app-surface)] hover:bg-[var(--app-soft)]";

/** 押すとラベルを発言として送る選択肢。 */
function ChoiceBlock({ block, disabled }: { block: UiChoiceBlock; disabled: boolean }) {
  const [selected, setSelected] = useState<readonly number[]>([]);

  const toggle = (index: number): void => {
    if (disabled) return;

    // 1 つだけ選ぶときは、押した時点で送る（もう一度確定させない）。
    if (!block.multiple) {
      setSelected([index]);
      void sendMessage(choiceMessage(block, [index]), []);
      return;
    }

    setSelected((current) =>
      current.includes(index) ? current.filter((entry) => entry !== index) : [...current, index],
    );
  };

  const submit = (): void => {
    if (disabled || selected.length === 0) return;
    void sendMessage(choiceMessage(block, selected), []);
  };

  return (
    <div class="flex flex-col gap-2">
      {block.multiple && <p class="text-[11px] text-[var(--app-text-tertiary)]">{t("chat.ui.multiple")}</p>}

      <div class="flex flex-col gap-1.5">
        {block.options.map((option, index) => {
          const picked = selected.includes(index);

          return (
            <button
              key={index}
              type="button"
              disabled={disabled}
              aria-pressed={block.multiple ? picked : undefined}
              onClick={() => toggle(index)}
              class={`${OPTION_CLASS} ${picked ? OPTION_ON_CLASS : OPTION_OFF_CLASS}`}
            >
              <span class="block text-[13px] font-medium text-[var(--app-text)]">{option.label}</span>
              {option.description !== null && (
                <span class="mt-0.5 block text-[11px] leading-5 text-[var(--app-text-secondary)]">
                  {option.description}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {block.multiple && (
        <button
          type="button"
          disabled={disabled || selected.length === 0}
          onClick={submit}
          class="self-start rounded-full bg-[var(--app-accent-fill)] px-4 py-2 text-xs font-medium whitespace-nowrap text-[var(--app-on-accent)] shadow-[var(--app-shadow-2)] transition hover:bg-[var(--app-accent-hover)] disabled:cursor-not-allowed disabled:opacity-30"
        >
          {t("chat.ui.submit")}
        </button>
      )}
    </div>
  );
}

/** 入力して送信するフォーム。必須の欄が埋まるまで送れない。 */
function FormBlock({ block, disabled }: { block: UiFormBlock; disabled: boolean }) {
  const [values, setValues] = useState<Readonly<Record<number, string | boolean>>>({});
  const complete = formComplete(block, values);

  const setValue = (index: number, value: string | boolean): void => {
    setValues((current) => ({ ...current, [index]: value }));
  };

  const submit = (): void => {
    if (disabled || !complete) return;
    void sendMessage(formMessage(block, values, { yes: t("chat.ui.yes"), no: t("chat.ui.no") }), []);
  };

  return (
    <form
      class="flex flex-col gap-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {block.fields.map((field, index) => (
        <FieldView
          key={index}
          field={field}
          disabled={disabled}
          value={values[index]}
          onChange={(value) => setValue(index, value)}
        />
      ))}

      <button
        type="submit"
        disabled={disabled || !complete}
        class="self-start rounded-full bg-[var(--app-accent-fill)] px-4 py-2 text-xs font-medium whitespace-nowrap text-[var(--app-on-accent)] shadow-[var(--app-shadow-2)] transition hover:bg-[var(--app-accent-hover)] disabled:cursor-not-allowed disabled:opacity-30"
      >
        {block.submit ?? t("chat.ui.submit")}
      </button>
    </form>
  );
}

function FieldView({
  field,
  disabled,
  value,
  onChange,
}: {
  field: UiField;
  disabled: boolean;
  value: string | boolean | undefined;
  onChange: (value: string | boolean) => void;
}) {
  // 入力欄とラベルを結びつける id。欄ごとに 1 つでよい（種類は変わらない）。
  const id = useId();
  const required = field.required ? <span class="text-[var(--app-danger)]"> *</span> : null;

  if (field.type === "checkbox") {
    return (
      <label class="flex items-center gap-2 text-[13px] text-[var(--app-text)]">
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
          class="h-4 w-4 shrink-0 accent-[var(--app-accent-fill)]"
        />
        <span>
          {field.label}
          {required}
        </span>
      </label>
    );
  }

  if (field.type === "select") {
    return (
      <label class="flex flex-col gap-1">
        <span class="text-[12px] font-medium text-[var(--app-text)]">
          {field.label}
          {required}
        </span>
        <select
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
          class={INPUT_CLASS}
        >
          <option value="">{field.placeholder ?? t("chat.ui.choose")}</option>
          {field.options.map((option, index) => (
            <option key={index} value={option.label}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }

  const text = typeof value === "string" ? value : "";

  return (
    <div class="flex flex-col gap-1">
      <label for={id} class="text-[12px] font-medium text-[var(--app-text)]">
        {field.label}
        {required}
      </label>
      {/* type を変数で渡すと Preact の型が絞れないので、数値だけ別に書く。 */}
      {field.type === "number" ? (
        <input
          id={id}
          type="number"
          value={text}
          placeholder={field.placeholder ?? undefined}
          disabled={disabled}
          onInput={(event) => onChange(event.currentTarget.value)}
          class={INPUT_CLASS}
        />
      ) : (
        <input
          id={id}
          type="text"
          value={text}
          placeholder={field.placeholder ?? undefined}
          disabled={disabled}
          onInput={(event) => onChange(event.currentTarget.value)}
          class={INPUT_CLASS}
        />
      )}
    </div>
  );
}
