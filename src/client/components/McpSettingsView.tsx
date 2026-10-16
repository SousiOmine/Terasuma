import { IconExternalLink, IconPencil, IconPlus, IconRefresh, IconTrash } from "@tabler/icons-preact";
import { useEffect, useState } from "preact/hooks";
import type { McpServerState, McpServerView } from "../../shared/types";
import type { MessageKey } from "../i18n";
import { t } from "../i18n";
import {
  authorizationUrl,
  authorizingServer,
  cancelAuthorization,
  checkServer,
  checkingServer,
  clearMcpError,
  isLoadingMcp,
  loadMcpServers,
  mcpError,
  mcpServers,
  removeMcpServer,
  showMcpError,
  startAuthorization,
} from "../mcpSettings";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorNotice } from "./ErrorNotice";
import { McpServerDialog, type McpDialogMode } from "./McpServerDialog";

const CARD_ACTION_CLASS = "rounded-lg px-2 py-1 text-xs transition hover:bg-neutral-100 dark:hover:bg-neutral-800";

/** 接続状態の表示。色と文言をここにまとめる。 */
const STATE_LABELS: Record<McpServerState, MessageKey> = {
  unknown: "settings.mcp.state.unknown",
  connected: "settings.mcp.state.connected",
  authorizing: "settings.mcp.state.authorizing",
  authorization_required: "settings.mcp.state.authorization_required",
  failed: "settings.mcp.state.failed",
};

const STATE_CLASSES: Record<McpServerState, string> = {
  unknown: "bg-neutral-200 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300",
  connected: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  authorizing: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  authorization_required: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300",
  failed: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
};

/**
 * 設定の「詳細設定」。
 *
 * MCP サーバーの接続だけを置く。一覧を開いただけでは繋ぎに行かず、「接続を確認」を押したときだけ確かめる
 * （落ちているサーバーがあるたびに設定画面が固まらないようにするため）。
 * 追加はダイアログの中で繋がることを確かめてから行い、変更は保存したあとにここで確かめる。
 */
export function McpSettingsView() {
  const view = mcpServers.value;
  const error = mcpError.value;
  const checking = checkingServer.value;
  const authorizing = authorizingServer.value;

  const [dialog, setDialog] = useState<McpDialogMode | null>(null);
  const [deleting, setDeleting] = useState<McpServerView | null>(null);

  useEffect(() => {
    // 設定画面を直接開いた場合に備えて、まだ読めていなければここで読む。
    if (mcpServers.value !== null || isLoadingMcp.value) return;
    void loadMcpServers().catch(showMcpError);
  }, []);

  const runCheck = (serverId: string) => void checkServer(serverId).catch(showMcpError);

  const confirmDelete = async () => {
    const target = deleting;
    setDeleting(null);
    if (target === null) return;

    try {
      await removeMcpServer(target.id);
    } catch (failure) {
      showMcpError(failure);
    }
  };

  return (
    <div class="mx-auto w-full max-w-2xl">
      <h2 class="text-base font-semibold">{t("settings.mcp.title")}</h2>

      {error !== null && (
        <div class="mt-4">
          <ErrorNotice
            error={error}
            action={
              <button type="button" onClick={clearMcpError} class="text-xs opacity-70 transition hover:opacity-100">
                {t("error.dismiss")}
              </button>
            }
          />
        </div>
      )}

      <div class="mt-6 flex items-start justify-between gap-6">
        <p class="min-w-0 text-xs text-neutral-500 dark:text-neutral-400">{t("settings.mcp.description")}</p>
        <Button variant="primary" onClick={() => setDialog({ kind: "add" })}>
          <IconPlus size={16} stroke={1.6} class="shrink-0" />
          {t("settings.mcp.add")}
        </Button>
      </div>

      <div class="mt-3 space-y-2">
        {view === null ? (
          <p class="text-xs text-neutral-500 dark:text-neutral-400">{t("chat.loading")}</p>
        ) : view.servers.length === 0 ? (
          <p class="text-xs text-neutral-500 dark:text-neutral-400">{t("settings.mcp.empty")}</p>
        ) : (
          view.servers.map((server) => (
            <McpServerCard
              key={server.id}
              server={server}
              checking={checking === server.id}
              authorizing={authorizing === server.id}
              authorizationUrl={authorizing === server.id ? authorizationUrl.value : null}
              onCheck={() => runCheck(server.id)}
              onAuthorize={(url) => void authorize(server.id, url).catch(showMcpError)}
              onCancel={() => void cancelAuthorization(server.id).catch(showMcpError)}
              onEdit={() => setDialog({ kind: "edit", server })}
              onDelete={() => setDeleting(server)}
            />
          ))
        )}
      </div>

      {dialog !== null && (
        <McpServerDialog
          mode={dialog}
          existingIds={view?.servers.map((server) => server.id) ?? []}
          onClose={(savedId) => {
            setDialog(null);
            // 保存したサーバーは、そのまま繋がるか確かめる（繋がらなくても設定は残る）。
            if (savedId !== undefined) runCheck(savedId);
          }}
        />
      )}

      {deleting !== null && (
        <ConfirmDialog
          title={t("settings.mcp.deleteTitle")}
          subject={deleting.id}
          message={t("settings.mcp.deleteMessage")}
          confirmLabel={t("settings.mcp.delete")}
          cancelLabel={t("common.cancel")}
          danger
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}

/** 認可を始める。返ってきた URL は、ポップアップが塞がれても開けるよう画面にも出す。 */
async function authorize(serverId: string, knownUrl: string | null): Promise<void> {
  const url = await startAuthorization(serverId);
  const target = url ?? knownUrl;
  if (target !== null) window.open(target, "_blank", "noopener");
}

type McpServerCardProps = {
  server: McpServerView;
  checking: boolean;
  authorizing: boolean;
  authorizationUrl: string | null;
  onCheck: () => void;
  onAuthorize: (url: string | null) => void;
  onCancel: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

function McpServerCard({
  server,
  checking,
  authorizing,
  authorizationUrl,
  onCheck,
  onAuthorize,
  onCancel,
  onEdit,
  onDelete,
}: McpServerCardProps) {
  const { state, tools, detail } = server.status;
  // 認可が要るかどうかは設定ではなく接続の結果で決まる。http は、繋がらない理由が
  // 認可（未認可・失効）であることもあるので、やり直せるようにしておく。
  const canAuthorize = server.type === "http" && (state === "authorization_required" || state === "failed");

  return (
    <div class="rounded-xl border border-neutral-200 px-4 py-3 dark:border-neutral-800">
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <p class="truncate text-sm font-medium">{server.id}</p>
            <span class={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${STATE_CLASSES[state]}`}>
              {authorizing ? t("settings.mcp.authorizing") : t(STATE_LABELS[state])}
            </span>
          </div>

          <p class="mt-0.5 truncate text-xs text-neutral-500 dark:text-neutral-400">
            {server.type === "stdio" ? [server.command, ...server.args].join(" ") : server.url}
          </p>

          {detail !== null && (
            <p class="mt-1 break-words text-xs text-red-600 dark:text-red-400">{detail}</p>
          )}

          {authorizing && authorizationUrl !== null && (
            <a
              href={authorizationUrl}
              target="_blank"
              rel="noreferrer noopener"
              class="mt-1 inline-flex items-center gap-1 text-xs underline"
            >
              <IconExternalLink size={12} stroke={1.6} class="shrink-0" />
              {t("settings.mcp.openAuthorization")}
            </a>
          )}

          {state === "connected" && (
            <details class="mt-2">
              <summary class="cursor-pointer text-xs text-neutral-500 dark:text-neutral-400">
                {t("settings.mcp.tools")} ({tools.length})
              </summary>
              {tools.length === 0 ? (
                <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">{t("settings.mcp.noTools")}</p>
              ) : (
                <ul class="mt-1 flex flex-wrap gap-1">
                  {tools.map((tool) => (
                    <li
                      key={tool}
                      class="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] dark:bg-neutral-800"
                    >
                      {tool}
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
        </div>

        <div class="flex shrink-0 flex-col items-end gap-1">
          <div class="flex items-center gap-1">
            <button type="button" onClick={onEdit} class={`${CARD_ACTION_CLASS} flex items-center gap-1`}>
              <IconPencil size={14} stroke={1.6} class="shrink-0" />
              {t("settings.mcp.edit")}
            </button>
            <button
              type="button"
              onClick={onDelete}
              class={`${CARD_ACTION_CLASS} flex items-center gap-1 text-red-600 dark:text-red-400`}
            >
              <IconTrash size={14} stroke={1.6} class="shrink-0" />
              {t("settings.mcp.delete")}
            </button>
          </div>

          {authorizing ? (
            <button type="button" onClick={onCancel} class={CARD_ACTION_CLASS}>
              {t("settings.mcp.cancelAuthorize")}
            </button>
          ) : (
            <div class="flex items-center gap-1">
              {canAuthorize && (
                <button
                  type="button"
                  onClick={() => onAuthorize(authorizationUrl)}
                  class="rounded-lg bg-neutral-900 px-2 py-1 text-xs text-white transition hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
                >
                  {t("settings.mcp.authorize")}
                </button>
              )}
              <button
                type="button"
                disabled={checking}
                onClick={onCheck}
                class={`${CARD_ACTION_CLASS} flex items-center gap-1 disabled:opacity-50`}
              >
                <IconRefresh size={14} stroke={1.6} class="shrink-0" />
                {checking ? t("settings.mcp.checking") : t("settings.mcp.check")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
