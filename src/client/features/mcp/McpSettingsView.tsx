import { IconExternalLink, IconPlus, IconRefresh } from "@tabler/icons-preact";
import { useEffect, useState } from "preact/hooks";
import type { McpServerState, McpServerView } from "../../../shared/api/settings";
import { useDeleteTarget } from "../../hooks/useDeleteTarget";
import type { MessageKey } from "../../i18n";
import { t } from "../../i18n";
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
} from "../../state/mcp";
import { Button } from "../../ui/Button";
import { ResourceList } from "../../ui/ResourceList";
import { SectionHeader } from "../../ui/SectionHeader";
import { DeleteAction, EditAction } from "../../ui/CardActions";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { SettingsSection } from "../../ui/SettingsSection";
import { type BadgeTone, StatusBadge } from "../../ui/StatusBadge";
import { CARD_ACTION_CLASS, CARD_CLASS } from "../../ui/styles";
import { McpServerDialog, type McpDialogMode } from "./McpServerDialog";

/** 接続状態の文言。 */
const STATE_LABELS: Record<McpServerState, MessageKey> = {
  unknown: "settings.mcp.state.unknown",
  connected: "settings.mcp.state.connected",
  authorizing: "settings.mcp.state.authorizing",
  authorization_required: "settings.mcp.state.authorization_required",
  failed: "settings.mcp.state.failed",
};

/** 接続状態の色。 */
const STATE_TONES: Record<McpServerState, BadgeTone> = {
  unknown: "neutral",
  connected: "success",
  authorizing: "info",
  authorization_required: "warning",
  failed: "danger",
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
  const deleting = useDeleteTarget<McpServerView>();

  useEffect(() => {
    // 設定画面を直接開いた場合に備えて、まだ読めていなければここで読む。
    if (mcpServers.value !== null || isLoadingMcp.value) return;
    void loadMcpServers().catch(showMcpError);
  }, []);

  const runCheck = (serverId: string) => void checkServer(serverId).catch(showMcpError);

  return (
    <SettingsSection title={t("settings.mcp.title")} error={error} onDismiss={clearMcpError}>
      <SectionHeader
        description={t("settings.mcp.description")}
        action={
          <Button variant="primary" onClick={() => setDialog({ kind: "add" })}>
            <IconPlus size={16} stroke={1.6} class="shrink-0" />
            {t("settings.mcp.add")}
          </Button>
        }
      />

      <ResourceList data={view === null ? null : view.servers} empty={t("settings.mcp.empty")}>
        {(server) => (
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
            onDelete={() => deleting.open(server)}
          />
        )}
      </ResourceList>

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

      {deleting.target !== null && (
        <ConfirmDialog
          title={t("settings.mcp.deleteTitle")}
          subject={deleting.target.id}
          message={t("settings.mcp.deleteMessage")}
          confirmLabel={t("common.delete")}
          cancelLabel={t("common.cancel")}
          danger
          onConfirm={() => deleting.confirm(removeMcpServer, showMcpError)}
          onCancel={deleting.close}
        />
      )}
    </SettingsSection>
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
    <div class={CARD_CLASS}>
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-center gap-2">
            <p class="truncate text-sm font-medium">{server.id}</p>
            <StatusBadge tone={STATE_TONES[state]}>
              {authorizing ? t("settings.mcp.authorizing") : t(STATE_LABELS[state])}
            </StatusBadge>
          </div>

          <p class="mt-0.5 truncate font-mono text-[11px] text-secondary">
            {server.type === "stdio" ? [server.command, ...server.args].join(" ") : server.url}
          </p>

          {detail !== null && <p class="mt-1.5 break-words text-xs leading-5 text-secondary">{detail}</p>}

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
              <summary class="cursor-pointer text-xs text-secondary">
                {t("settings.mcp.tools", { count: tools.length })}
              </summary>
              {tools.length === 0 ? (
                <p class="mt-1 text-xs text-secondary">{t("settings.mcp.noTools")}</p>
              ) : (
                <ul class="mt-1 flex flex-wrap gap-1">
                  {tools.map((tool) => (
                    <li key={tool} class="rounded-full bg-surface px-2.5 py-1 font-mono text-[11px] text-secondary">
                      {tool}
                    </li>
                  ))}
                </ul>
              )}
            </details>
          )}
        </div>

        <div class="flex shrink-0 flex-col items-start gap-1 sm:items-end">
          <div class="flex items-center gap-1">
            <EditAction onClick={onEdit} />
            <DeleteAction onClick={onDelete} />
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
                  class="rounded-full bg-[var(--app-accent-fill)] px-3 py-1.5 text-xs font-medium text-[var(--app-on-accent)] transition hover:bg-[var(--app-accent-hover)]"
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
                {checking ? t("common.checking") : t("common.check")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
