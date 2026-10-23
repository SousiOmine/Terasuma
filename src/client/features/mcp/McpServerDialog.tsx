import { useEffect, useRef, useState } from "preact/hooks";
import type { McpServerForm, McpServerView, McpTestView } from "../../../shared/api/settings";
import { useInFlight } from "../../hooks/useInFlight";
import { t } from "../../i18n";
import { type ErrorState, toErrorState } from "../../lib/errors";
import { saveMcpServer, testMcpServer, waitForTestAuthorization } from "../../state/mcp";
import { Button } from "../../ui/Button";
import { ErrorNotice } from "../../ui/ErrorNotice";
import { Field } from "../../ui/Field";
import { Modal } from "../../ui/Modal";
import { Segmented } from "../../ui/Segmented";
import { INPUT_CLASS, TEXTAREA_CLASS } from "../../ui/styles";
import { buildForm, envToText, type McpFormFields } from "./mcpForm";
import { AuthorizationNotice, CheckedNotice } from "./McpNotices";

/** 新しく追加するか、設定済みのものを変更するか。 */
export type McpDialogMode = { kind: "add" } | { kind: "edit"; server: McpServerView };

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

  /** 送信中の要求。素早く二度押しされると busy が立つ前に 2 回目が走るので、押した瞬間に閉じる門を置く。 */
  const inFlight = useInFlight();
  /** 走っている確認の番号。入力が変わったときと閉じたときに進めて、その結果を捨てる。 */
  const run = useRef(0);
  /** 一度開いた認可画面。同じタブを開き直さないための控え。 */
  const opened = useRef<string | null>(null);

  const inputs: McpFormFields = { id, type, command, args, env, url };
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
    if (inFlight.isRunning() || authorizing !== null) return;

    const parsed = buildForm(inputs, takenIds);
    if (parsed.kind === "error") {
      setError({ code: "input", detail: t(parsed.message) });
      return;
    }

    inFlight.run(async () => {
      setBusy("checking");
      setError(null);
      setChecked(null);
      const current = run.current + 1;
      run.current = current;
      await probe(parsed.form, signature, current);
    });
  };

  const submit = () => {
    if (inFlight.isRunning()) return;

    const parsed = buildForm(inputs, takenIds);
    if (parsed.kind === "error") {
      setError({ code: "input", detail: t(parsed.message) });
      return;
    }

    inFlight.run(async () => {
      setBusy("saving");
      setError(null);

      try {
        await saveMcpServer(parsed.form, editing ? "edit" : "add");
        onClose(parsed.form.id);
      } catch (failure) {
        setError(toErrorState(failure));
        setBusy(null);
      }
    });
  };

  /** 1 回分の接続確認。 */
  async function probe(form: McpServerForm, signature: string, current: number): Promise<void> {
    try {
      apply(await testMcpServer(form), form, signature, current);
    } catch (failure) {
      if (run.current !== current) return;
      setError(toErrorState(failure));
      setBusy(null);
    }
  }

  /**
   * 認可が終わるまで、接続の確認を繰り返す。
   * 待ち方（間隔・上限・中断）は state/mcp.ts が持つ。
   */
  async function waitForAuthorization(form: McpServerForm, signature: string, current: number): Promise<void> {
    const outcome = await waitForTestAuthorization({
      form,
      cancelled: () => run.current !== current,
      onProbe: (status) => {
        if (run.current === current) setAuthorizing(status.authorizationUrl);
      },
    });

    if (outcome.kind === "cancelled") return;

    if (outcome.kind === "value") {
      apply(outcome.value, form, signature, current);
      return;
    }
    if (outcome.kind === "error") {
      if (run.current !== current) return;
      setError(toErrorState(outcome.error));
      setAuthorizing(null);
      return;
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
          <Button onClick={() => onClose()}>{t("common.cancel")}</Button>

          {editing ? (
            <Button variant="primary" disabled={busy !== null} onClick={submit}>
              {t(busy === "saving" ? "common.saving" : "settings.mcp.form.save")}
            </Button>
          ) : (
            <>
              <Button disabled={busy !== null || authorizing !== null} onClick={check}>
                {t(busy === "checking" ? "common.checking" : "common.check")}
              </Button>
              <Button variant="primary" disabled={checkedNow === null || busy !== null} onClick={submit}>
                {t(busy === "saving" ? "common.adding" : "common.add")}
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
          <Segmented
            options={[
              { value: "stdio", label: t("settings.mcp.form.type.stdio") },
              { value: "http", label: t("settings.mcp.form.type.http") },
            ]}
            value={type}
            onChange={(value) => change(setType, value)}
          />
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
              <p class="pt-2 text-xs text-secondary">{t("settings.mcp.form.needCheck")}</p>
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

/** 見出しの下に出す、いま設定されている接続先。 */
function subtitleOf(server: McpServerView | null): string | undefined {
  if (server === null) return undefined;
  if (server.type === "stdio") return [server.command, ...server.args].join(" ");
  return server.url ?? undefined;
}
