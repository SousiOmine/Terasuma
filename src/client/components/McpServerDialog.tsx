import { useState } from "preact/hooks";
import type { McpServerForm, McpServerView } from "../../shared/types";
import { toErrorState, type ErrorState } from "../errors";
import { t } from "../i18n";
import { saveMcpServer } from "../mcpSettings";
import { Button } from "./Button";
import { ErrorNotice } from "./ErrorNotice";
import { Field } from "./Field";
import { Modal } from "./Modal";

/** 新しく追加するか、設定済みのものを変更するか。 */
export type McpDialogMode = { kind: "add" } | { kind: "edit"; server: McpServerView };

const INPUT_CLASS =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-600";

const TEXTAREA_CLASS = `${INPUT_CLASS} font-mono text-xs leading-relaxed`;

/** 名前（id）に使える文字。ツール名の先頭に付くため、サーバー側と同じ規則にする。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * MCP サーバーを追加・変更するダイアログ。
 *
 * 接続の確認はここでは行わない（OAuth は保存済みの設定が要るため、保存してから確かめる）。
 * 閉じたときに保存先の id を返し、呼び出し側がそのまま接続を確かめられるようにする。
 */
export function McpServerDialog({
  mode,
  onClose,
}: {
  mode: McpDialogMode;
  onClose: (savedId?: string) => void;
}) {
  const editing = mode.kind === "edit";
  const server = editing ? mode.server : null;

  const [id, setId] = useState(server?.id ?? "");
  const [type, setType] = useState<"stdio" | "http">(server?.type ?? "stdio");
  const [command, setCommand] = useState(server?.command ?? "");
  const [args, setArgs] = useState(server?.args.join("\n") ?? "");
  const [env, setEnv] = useState(() => envToText(server?.env ?? {}));
  const [url, setUrl] = useState(server?.url ?? "");
  const [oauth, setOauth] = useState(server?.oauth ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorState | null>(null);

  /** 送信中の要求。素早く二度押しされると busy が立つ前に 2 回目が走るので、ここで閉じる。 */
  const [inFlight, setInFlight] = useState(false);

  const submit = () => {
    if (inFlight) return;

    const form = buildForm({ id, type, command, args, env, url, oauth }, setError);
    if (form === null) return;

    setInFlight(true);
    setBusy(true);
    setError(null);

    void saveMcpServer(form, editing ? "edit" : "add")
      .then(() => onClose(form.id))
      .catch((failure: unknown) => {
        setError(toErrorState(failure));
        setInFlight(false);
        setBusy(false);
      });
  };

  return (
    <Modal
      title={t(editing ? "settings.mcp.form.editTitle" : "settings.mcp.form.addTitle")}
      subtitle={subtitleOf(server)}
      onClose={() => onClose()}
      footer={
        <>
          <Button onClick={() => onClose()}>{t("settings.mcp.form.cancel")}</Button>
          <Button variant="primary" disabled={busy} onClick={submit}>
            {t(busy ? "settings.mcp.form.saving" : "settings.mcp.form.save")}
          </Button>
        </>
      }
    >
      <div class="space-y-1">
        <Field
          label={t("settings.mcp.form.name.label")}
          description={t("settings.mcp.form.name.description")}
          hint={editing ? t("settings.mcp.form.idFixed") : undefined}
        >
          <input
            type="text"
            value={id}
            disabled={editing}
            spellcheck={false}
            autocomplete="off"
            placeholder={t("settings.mcp.form.name.placeholder")}
            aria-label={t("settings.mcp.form.name.label")}
            class={`${INPUT_CLASS} disabled:opacity-60`}
            onInput={(event) => setId(event.currentTarget.value)}
          />
        </Field>

        <Field label={t("settings.mcp.form.type.label")}>
          <div class="flex gap-1 rounded-lg bg-neutral-200/60 p-0.5 dark:bg-neutral-800">
            {(["stdio", "http"] as const).map((value) => {
              const active = type === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setType(value)}
                  class={`flex-1 rounded-md px-3 py-1 text-xs transition ${
                    active
                      ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900"
                      : "text-neutral-600 hover:bg-neutral-200 dark:text-neutral-300 dark:hover:bg-neutral-700"
                  }`}
                >
                  {t(value === "stdio" ? "settings.mcp.form.type.stdio" : "settings.mcp.form.type.http")}
                </button>
              );
            })}
          </div>
        </Field>

        {type === "stdio" ? (
          <>
            <Field label={t("settings.mcp.form.command.label")} description={t("settings.mcp.form.command.description")}>
              <input
                type="text"
                value={command}
                spellcheck={false}
                autocomplete="off"
                aria-label={t("settings.mcp.form.command.label")}
                class={INPUT_CLASS}
                onInput={(event) => setCommand(event.currentTarget.value)}
              />
            </Field>

            <Field label={t("settings.mcp.form.args.label")} description={t("settings.mcp.form.args.description")}>
              <textarea
                value={args}
                rows={3}
                spellcheck={false}
                aria-label={t("settings.mcp.form.args.label")}
                class={TEXTAREA_CLASS}
                onInput={(event) => setArgs(event.currentTarget.value)}
              />
            </Field>

            <Field label={t("settings.mcp.form.env.label")} description={t("settings.mcp.form.env.description")}>
              <textarea
                value={env}
                rows={3}
                spellcheck={false}
                aria-label={t("settings.mcp.form.env.label")}
                class={TEXTAREA_CLASS}
                onInput={(event) => setEnv(event.currentTarget.value)}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label={t("settings.mcp.form.url.label")} description={t("settings.mcp.form.url.description")}>
              <input
                type="text"
                value={url}
                spellcheck={false}
                autocomplete="off"
                aria-label={t("settings.mcp.form.url.label")}
                class={INPUT_CLASS}
                onInput={(event) => setUrl(event.currentTarget.value)}
              />
            </Field>

            <label class="flex items-start gap-2 py-2 text-sm">
              <input
                type="checkbox"
                checked={oauth}
                class="mt-1"
                onChange={(event) => setOauth(event.currentTarget.checked)}
              />
              <span class="min-w-0">
                {t("settings.mcp.form.oauth.label")}
                <span class="mt-0.5 block text-xs text-neutral-500 dark:text-neutral-400">
                  {t("settings.mcp.form.oauth.description")}
                </span>
              </span>
            </label>
          </>
        )}

        {error !== null && (
          <div class="pt-2">
            <ErrorNotice error={error} />
          </div>
        )}
      </div>
    </Modal>
  );
}

type FormFields = {
  id: string;
  type: "stdio" | "http";
  command: string;
  args: string;
  env: string;
  url: string;
  oauth: boolean;
};

/** 見出しの下に出す、いま設定されている接続先。 */
function subtitleOf(server: McpServerView | null): string | undefined {
  if (server === null) return undefined;
  if (server.type === "stdio") return [server.command, ...server.args].join(" ");
  return server.url ?? undefined;
}

/** 入力を検証して送れる形にする。読めない場合は理由を出して null を返す。 */
function buildForm(fields: FormFields, fail: (error: ErrorState) => void): McpServerForm | null {
  const id = fields.id.trim();
  if (!ID_PATTERN.test(id)) {
    fail({ code: "input", detail: t("settings.mcp.form.invalidName") });
    return null;
  }

  if (fields.type === "stdio") {
    const command = fields.command.trim();
    if (command.length === 0) {
      fail({ code: "input", detail: t("settings.mcp.form.needCommand") });
      return null;
    }

    const env = parseEnv(fields.env);
    if (env === null) {
      fail({ code: "input", detail: t("settings.mcp.form.invalidEnv") });
      return null;
    }

    return { id, type: "stdio", command, args: lines(fields.args), env, url: null, oauth: false };
  }

  const url = fields.url.trim();
  if (url.length === 0) {
    fail({ code: "input", detail: t("settings.mcp.form.needUrl") });
    return null;
  }

  return { id, type: "http", command: null, args: null, env: null, url, oauth: fields.oauth };
}

/** 1 行 1 項目の入力を、空行を除いた配列にする。 */
function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** KEY=VALUE を 1 行ずつ読む。読めない行があれば null。 */
function parseEnv(value: string): Record<string, string> | null {
  const variables: Record<string, string> = {};

  for (const line of lines(value)) {
    const separator = line.indexOf("=");
    if (separator <= 0) return null;

    const name = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
    variables[name] = line.slice(separator + 1).trim();
  }
  return variables;
}

function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
}
