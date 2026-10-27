import { useEffect, useRef, useState } from "preact/hooks";
import type { McpServerForm, McpServerView, McpTestView } from "../../../shared/api/settings";
import { useVerifiedForm } from "../../hooks/useVerifiedForm";
import { t } from "../../i18n";
import { toErrorState } from "../../lib/errors";
import { cancelMcpTest, saveMcpServer, testMcpServer, waitForTestAuthorization } from "../../state/mcp";
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
  /** 認可を待っているときの、ブラウザで開く画面の URL。 */
  const [authorizing, setAuthorizing] = useState<string | null>(null);

  const inputs: McpFormFields = { id, type, command, args, env, url };
  /** 入力そのもの。確かめた結果が今の入力に対するものかを比べるのにも使う。 */
  const signature = JSON.stringify(inputs);

  /**
   * 「入力を確かめる → 保存する」の状態（走っている操作・確認結果・失敗・世代番号）。
   * 認可の待ちは、この世代番号が変わったら諦める。
   */
  const verified = useVerifiedForm<Checked>(signature);
  const { busy, error, checked: checkedNow } = verified;
  /** 一度開いた認可画面。同じタブを開き直さないための控え。 */
  const opened = useRef<string | null>(null);
  /** いまの id。ダイアログを閉じたとき、待っている認可を片付けるのに使う。 */
  const currentId = useRef(id);
  currentId.current = id;

  /** 追加のときだけ名前の重複を見る（変更では名前を変えられない）。 */
  const takenIds = editing ? [] : existingIds;

  useEffect(
    () => () => {
      // 閉じたら、走っている確認の結果は捨てる。
      verified.cancelPending();

      // 保存前の確認で認可を待っていたら、サーバ側の待ちも片付ける。
      // 残すと、同じ設定でやり直しても古い URL が返り続ける。
      if (currentId.current.length > 0) {
        void cancelMcpTest(currentId.current).catch(() => undefined);
      }
    },
    [],
  );

  // id を書き換えたら、前の id で待っていた認可を片付ける。
  const previousId = useRef(id);
  useEffect(() => {
    if (previousId.current !== id && previousId.current.length > 0) {
      void cancelMcpTest(previousId.current).catch(() => undefined);
    }
    previousId.current = id;
  }, [id]);

  /** 入力が変わったら、確かめた結果と待っている認可は捨てる（別の接続先を確かめることになるため）。 */
  const change = <T,>(set: (value: T) => void, value: T): void => {
    set(value);
    verified.invalidate();
    setAuthorizing(null);
  };

  /** いまの入力で接続を確かめる。認可が要る場合は、終わるまで待つ。 */
  const check = async (): Promise<void> => {
    if (authorizing !== null) return;

    const parsed = buildForm(inputs, takenIds);
    if (parsed.kind === "error") {
      verified.setError({ code: "input", detail: t(parsed.message) });
      return;
    }

    // 認可が要る場合は probe が待ちを続けるので、結果はここでは返さない（待ちの中で置く）。
    await verified.check(async () => {
      await probe(parsed.form, signature, verified.generation() + 1);
      return null;
    });
  };

  const submit = async (): Promise<void> => {
    const parsed = buildForm(inputs, takenIds);
    if (parsed.kind === "error") {
      verified.setError({ code: "input", detail: t(parsed.message) });
      return;
    }

    await verified.save(async () => {
      await saveMcpServer(parsed.form, editing ? "edit" : "add");
      onClose(parsed.form.id);
    });
  };

  /** 1 回分の接続確認。 */
  async function probe(input: McpServerForm, sig: string, current: number): Promise<void> {
    try {
      apply(await testMcpServer(input), input, sig, current);
    } catch (failure) {
      if (verified.generation() !== current) return;
      verified.setError(toErrorState(failure));
      verified.cancelPending();
    }
  }

  /**
   * 認可が終わるまで、接続の確認を繰り返す。
   * 待ち方（間隔・上限・中断）は state/mcp.ts が持つ。
   */
  async function waitForAuthorization(form: McpServerForm, signature: string, current: number): Promise<void> {
    const outcome = await waitForTestAuthorization({
      form,
      cancelled: () => verified.generation() !== current,
      onProbe: (status) => {
        if (verified.generation() === current) setAuthorizing(status.authorizationUrl);
      },
    });

    if (outcome.kind === "cancelled") return;

    if (outcome.kind === "value") {
      apply(outcome.value, form, signature, current);
      return;
    }
    if (outcome.kind === "error") {
      if (verified.generation() !== current) return;
      verified.setError(toErrorState(outcome.error));
      setAuthorizing(null);
      return;
    }

    if (verified.generation() !== current) return;

    // 待つのをやめたら、サーバ側もやり直せる状態に戻す。
    void cancelMcpTest(form.id).catch(() => undefined);
    verified.setError({ code: "mcp_unreachable", detail: t("settings.mcp.form.authorizationTimeout") });
    setAuthorizing(null);
  }

  /** 確かめた結果を画面に反映する。入力が変わっていたら何もしない。 */
  function apply(result: McpTestView, form: McpServerForm, signature: string, current: number): void {
    if (verified.generation() !== current) return;

    if (result.state === "connected") {
      verified.setChecked({ signature, tools: result.tools });
      setAuthorizing(null);
      verified.clearError();
      verified.cancelPending();
      return;
    }

    if (result.state === "failed") {
      verified.invalidate();
      setAuthorizing(null);
      verified.setError({ code: "mcp_unreachable", detail: result.detail });
      verified.cancelPending();
      return;
    }

    // サーバーが認可を求めている。画面を開いて、認可が終わるまで待つ。
    verified.invalidate();
    verified.clearError();
    verified.cancelPending();
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
