import { IconExternalLink } from "@tabler/icons-preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { mcpServerIdProblem } from "../../../shared/ids";
import type { McpServerForm, McpServerView, McpTestView } from "../../../shared/types";
import * as api from "../../lib/api";
import { toErrorState, type ErrorState } from "../../lib/errors";
import { t } from "../../i18n";
import { AUTHORIZATION_POLL_MS, AUTHORIZATION_TIMEOUT_MS, saveMcpServer } from "../../state/mcp";
import { Button } from "../../ui/Button";
import { ErrorNotice } from "../../ui/ErrorNotice";
import { Field } from "../../ui/Field";
import { Modal } from "../../ui/Modal";

/** 新しく追加するか、設定済みのものを変更するか。 */
export type McpDialogMode = { kind: "add" } | { kind: "edit"; server: McpServerView };

const INPUT_CLASS =
  "w-full rounded-lg border border-neutral-300 bg-white px-3 py-1.5 text-sm outline-none focus:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-neutral-600";

const TEXTAREA_CLASS = `${INPUT_CLASS} font-mono text-xs leading-relaxed`;

/** 接続を確かめられたときの入力と、そのときに見えたツール。 */
type Checked = { signature: string; tools: readonly string[] };

/**
 * MCP サーバーを追加・変更するダイアログ。
 *
 * 追加は「入力を埋める → 接続を確認 →（必要なら認可）→ 追加する」の順に進める。
 * 繋がることを確かめるまで追加できない。OAuth が要るかどうかは設定に書かず、
 * 確かめたときにサーバーが認可を求めたら、その場で認可へ進む。
 *
 * 変更は接続情報を書き換えるだけにして、確かめるのは保存の後（設定画面が引き受ける）。
 */
export function McpServerDialog({
  mode,
  existingIds,
  onClose,
}: {
  mode: McpDialogMode;
  /** すでに設定されているサーバーの id。追加のときは、名前の重複をここで弾く。 */
  existingIds: readonly string[];
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
  const [busy, setBusy] = useState<"checking" | "saving" | null>(null);
  const [checked, setChecked] = useState<Checked | null>(null);
  /** 認可を待っているときの、ブラウザで開く画面の URL。 */
  const [authorizing, setAuthorizing] = useState<string | null>(null);
  const [error, setError] = useState<ErrorState | null>(null);

  /** 送信中の要求。素早く二度押しされると busy が立つ前に 2 回目が走るので、押した瞬間に閉じる門をここに置く。 */
  const inFlight = useRef(false);
  /** 走っている確認の番号。入力が変わったときと閉じたときに進めて、その結果を捨てる。 */
  const run = useRef(0);
  /** 一度開いた認可画面。同じタブを開き直さないための控え。 */
  const opened = useRef<string | null>(null);

  const inputs: FormFields = { id, type, command, args, env, url };
  /** 入力そのもの。確かめた結果が今の入力に対するものかを比べるのにも使う。 */
  const signature = JSON.stringify(inputs);
  const checkedNow = checked !== null && checked.signature === signature ? checked : null;
  /** 追加のときだけ名前の重複を見る（変更では名前を変えられない）。 */
  const takenIds = editing ? [] : existingIds;

  useEffect(
    () => () => {
      run.current += 1;
    },
    [],
  );

  /** 入力が変わったら、確かめた結果と待っている認可は捨てる（別の接続先を確かめることになるため）。 */
  const change = <T,>(set: (value: T) => void, value: T): void => {
    set(value);
    setChecked(null);
    setAuthorizing(null);
    run.current += 1;
  };

  /** いまの入力で接続を確かめる。認可が要る場合は、終わるまで待つ。 */
  const check = () => {
    if (inFlight.current || authorizing !== null) return;

    const form = buildForm(inputs, takenIds, setError);
    if (form === null) return;

    inFlight.current = true;
    setBusy("checking");
    setError(null);
    setChecked(null);
    const current = run.current + 1;
    run.current = current;
    void probe(form, signature, current).finally(() => {
      inFlight.current = false;
    });
  };

  const submit = () => {
    if (inFlight.current) return;

    const form = buildForm(inputs, takenIds, setError);
    if (form === null) return;

    inFlight.current = true;
    setBusy("saving");
    setError(null);

    void saveMcpServer(form, editing ? "edit" : "add")
      .then(() => onClose(form.id))
      .catch((failure: unknown) => {
        setError(toErrorState(failure));
        setBusy(null);
      })
      .finally(() => {
        inFlight.current = false;
      });
  };

  /** 1 回分の接続確認。 */
  async function probe(form: McpServerForm, signature: string, current: number): Promise<void> {
    try {
      apply(await api.testMcpServer(form), form, signature, current);
    } catch (failure) {
      if (run.current !== current) return;
      setError(toErrorState(failure));
      setBusy(null);
    }
  }

  /**
   * 認可が終わるまで、接続の確認を繰り返す。
   * 認可はブラウザの別タブで進むため、こちらからは状態を尋ねるしかない。
   */
  async function waitForAuthorization(form: McpServerForm, signature: string, current: number): Promise<void> {
    const deadline = Date.now() + AUTHORIZATION_TIMEOUT_MS;

    while (run.current === current && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, AUTHORIZATION_POLL_MS));
      if (run.current !== current) return;

      try {
        const result = await api.testMcpServer(form);
        if (run.current !== current) return;
        if (result.state !== "authorizing" && result.state !== "authorization_required") {
          apply(result, form, signature, current);
          return;
        }
        setAuthorizing(result.authorizationUrl);
      } catch (failure) {
        if (run.current !== current) return;
        setError(toErrorState(failure));
        setAuthorizing(null);
        return;
      }
    }

    if (run.current !== current) return;
    setError({ code: "mcp_unreachable", detail: t("settings.mcp.form.authorizationTimeout") });
    setAuthorizing(null);
  }

  /** 確かめた結果を画面に反映する。入力が変わっていたら何もしない。 */
  function apply(result: McpTestView, form: McpServerForm, signature: string, current: number): void {
    if (run.current !== current) return;

    if (result.state === "connected") {
      setChecked({ signature, tools: result.tools });
      setAuthorizing(null);
      setError(null);
      setBusy(null);
      return;
    }

    if (result.state === "failed") {
      setChecked(null);
      setAuthorizing(null);
      setError({ code: "mcp_unreachable", detail: result.detail });
      setBusy(null);
      return;
    }

    // サーバーが認可を求めている。画面を開いて、認可が終わるまで待つ。
    setChecked(null);
    setError(null);
    setBusy(null);
    setAuthorizing(result.authorizationUrl);
    openAuthorization(result.authorizationUrl);
    void waitForAuthorization(form, signature, current);
  }

  /** 認可画面を新しいタブで開く。塞がれたときのために、URL は画面にも残す。 */
  function openAuthorization(target: string | null): void {
    if (target === null || opened.current === target) return;
    opened.current = target;
    window.open(target, "_blank", "noopener");
  }

  return (
    <Modal
      title={t(editing ? "settings.mcp.form.editTitle" : "settings.mcp.form.addTitle")}
      subtitle={subtitleOf(server)}
      onClose={() => onClose()}
      footer={
        <>
          <Button onClick={() => onClose()}>{t("settings.mcp.form.cancel")}</Button>

          {editing ? (
            <Button variant="primary" disabled={busy !== null} onClick={submit}>
              {t(busy === "saving" ? "settings.mcp.form.saving" : "settings.mcp.form.save")}
            </Button>
          ) : (
            <>
              <Button disabled={busy !== null || authorizing !== null} onClick={check}>
                {t(busy === "checking" ? "settings.mcp.checking" : "settings.mcp.check")}
              </Button>
              <Button variant="primary" disabled={checkedNow === null || busy !== null} onClick={submit}>
                {t(busy === "saving" ? "settings.mcp.form.adding" : "settings.mcp.form.add")}
              </Button>
            </>
          )}
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
            onInput={(event) => change(setId, event.currentTarget.value)}
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
                  onClick={() => change(setType, value)}
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
            <Field
              label={t("settings.mcp.form.command.label")}
              description={t("settings.mcp.form.command.description")}
            >
              <input
                type="text"
                value={command}
                spellcheck={false}
                autocomplete="off"
                aria-label={t("settings.mcp.form.command.label")}
                class={INPUT_CLASS}
                onInput={(event) => change(setCommand, event.currentTarget.value)}
              />
            </Field>

            <Field label={t("settings.mcp.form.args.label")} description={t("settings.mcp.form.args.description")}>
              <textarea
                value={args}
                rows={3}
                spellcheck={false}
                aria-label={t("settings.mcp.form.args.label")}
                class={TEXTAREA_CLASS}
                onInput={(event) => change(setArgs, event.currentTarget.value)}
              />
            </Field>

            <Field label={t("settings.mcp.form.env.label")} description={t("settings.mcp.form.env.description")}>
              <textarea
                value={env}
                rows={3}
                spellcheck={false}
                aria-label={t("settings.mcp.form.env.label")}
                class={TEXTAREA_CLASS}
                onInput={(event) => change(setEnv, event.currentTarget.value)}
              />
            </Field>
          </>
        ) : (
          <Field label={t("settings.mcp.form.url.label")} description={t("settings.mcp.form.url.description")}>
            <input
              type="text"
              value={url}
              spellcheck={false}
              autocomplete="off"
              aria-label={t("settings.mcp.form.url.label")}
              class={INPUT_CLASS}
              onInput={(event) => change(setUrl, event.currentTarget.value)}
            />
          </Field>
        )}

        {!editing && (
          <>
            {checkedNow !== null && <CheckedNotice tools={checkedNow.tools} />}
            {authorizing !== null && <AuthorizationNotice url={authorizing} />}
            {checkedNow === null && authorizing === null && (
              <p class="pt-2 text-xs text-neutral-500 dark:text-neutral-400">{t("settings.mcp.form.needCheck")}</p>
            )}
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
};

/** 見出しの下に出す、いま設定されている接続先。 */
function subtitleOf(server: McpServerView | null): string | undefined {
  if (server === null) return undefined;
  if (server.type === "stdio") return [server.command, ...server.args].join(" ");
  return server.url ?? undefined;
}

/** 接続を確かめられたことと、そのときに見えたツール。 */
function CheckedNotice({ tools }: { tools: readonly string[] }) {
  return (
    <div class="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-200">
      <p>{t("settings.mcp.form.connected")}</p>
      {tools.length === 0 ? (
        <p class="mt-0.5 opacity-80">{t("settings.mcp.noTools")}</p>
      ) : (
        <ul class="mt-1 flex flex-wrap gap-1">
          {tools.map((tool) => (
            <li key={tool} class="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[11px] dark:bg-neutral-900/60">
              {tool}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 認可を待っている間の案内。ブラウザのタブを閉じてしまっても、ここから開き直せる。 */
function AuthorizationNotice({ url }: { url: string }) {
  return (
    <div class="rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-xs text-sky-900 dark:border-sky-900 dark:bg-sky-950/50 dark:text-sky-200">
      <p>{t("settings.mcp.form.authorize")}</p>
      <a href={url} target="_blank" rel="noreferrer noopener" class="mt-1 inline-flex items-center gap-1 underline">
        <IconExternalLink size={12} stroke={1.6} class="shrink-0" />
        {t("settings.mcp.openAuthorization")}
      </a>
    </div>
  );
}

/** 入力を検証して送れる形にする。読めない場合は理由を出して null を返す。 */
function buildForm(
  fields: FormFields,
  takenIds: readonly string[],
  fail: (error: ErrorState) => void,
): McpServerForm | null {
  const id = fields.id.trim();
  const idProblem = mcpServerIdProblem(id);
  if (idProblem !== null) {
    fail({
      code: "input",
      detail: t(idProblem === "reserved" ? "settings.mcp.form.reservedName" : "settings.mcp.form.invalidName"),
    });
    return null;
  }

  // 同じ id は設定でもツール名でも衝突する。サーバー側でも弾くが、繋ぎに行く前にここで止める。
  if (takenIds.includes(id)) {
    fail({ code: "input", detail: t("settings.mcp.form.nameTaken") });
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

    return { id, type: "stdio", command, args: lines(fields.args), env, url: null };
  }

  const url = fields.url.trim();
  if (url.length === 0) {
    fail({ code: "input", detail: t("settings.mcp.form.needUrl") });
    return null;
  }

  return { id, type: "http", command: null, args: null, env: null, url };
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
