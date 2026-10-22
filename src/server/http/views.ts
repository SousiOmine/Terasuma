import type { McpServersSettings, ModelSettings, StoredWebSearchSettings } from "../data/settings-schema";
import type { McpServersView, ModelSettingsView, WebSearchSettingsView } from "../../shared/types";
import type { McpManager } from "../mcp/manager";
import { isWebSearchProviderId, providerInfo, WEB_SEARCH_PROVIDERS } from "../websearch/index";

/**
 * 保存されている設定を、画面へ返す形に整える。
 * API キーそのものは返さず、設定済みかどうかだけを返す。
 */

/** 設定から画面用の形を作る。名前は label があればそれ、無ければ id（カタログの名前はクライアントが当てる）。 */
export function toSettingsView(settings: ModelSettings): ModelSettingsView {
  return {
    model: settings.model,
    providers: Object.entries(settings.providers).map(([id, provider]) => ({
      id,
      name: provider.label ?? id,
      baseUrl: provider.baseUrl ?? null,
      hasApiKey: provider.apiKey !== undefined,
    })),
  };
}

/** MCP サーバーの設定を、画面に出す形にする。接続状態は manager が持っているものを当てる。 */
export function toMcpView(servers: McpServersSettings, mcp: McpManager): McpServersView {
  return {
    servers: Object.entries(servers).map(([id, server]) => ({
      id,
      type: server.type,
      command: server.type === "stdio" ? server.command : null,
      args: server.type === "stdio" ? (server.args ?? []) : [],
      env: server.type === "stdio" ? (server.env ?? {}) : {},
      url: server.type === "http" ? server.url : null,
      status: mcp.status(id),
    })),
  };
}

/**
 * Web 検索の設定を、画面に出す形にする。
 * API キーそのものは返さず、設定済みかどうかだけを返す。
 */
export function toWebSearchView(webSearch: StoredWebSearchSettings): WebSearchSettingsView {
  const providers = Object.entries(webSearch.providers).map(([id, provider]) => {
    const info = isWebSearchProviderId(id) ? providerInfo(id) : null;

    return {
      id,
      name: info?.name ?? id,
      supportsFetch: info?.supportsFetch ?? false,
      hasApiKey: provider.apiKey.length > 0,
      isDefault: webSearch.default === id,
    };
  });

  const registered = new Set(Object.keys(webSearch.providers));
  const available = WEB_SEARCH_PROVIDERS.filter((info) => !registered.has(info.id)).map((info) => ({
    id: info.id,
    name: info.name,
    supportsFetch: info.supportsFetch,
  }));

  return { defaultId: webSearch.default, providers, available };
}

/** 認可の結果をブラウザに出す 1 枚のページ。サーバを言語非依存に保つため日英を併記する。 */
export function authorizationPage(status: number, title: string, lines: readonly string[]): Response {
  const paragraphs = lines
    .map((line) => `<p style="margin:.4rem 0;font-size:.9rem;color:#404040">${escapeHtml(line)}</p>`)
    .join("");

  const html = `<!doctype html>
<html lang="ja">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Terasuma</title></head>
<body style="margin:0;padding:3rem 1.5rem;font-family:system-ui,-apple-system,sans-serif;line-height:1.7;color:#171717;background:#fafafa">
<main style="max-width:32rem;margin:0 auto;background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:1.5rem 1.75rem">
<h1 style="margin:0 0 .5rem;font-size:1.05rem">${escapeHtml(title)}</h1>
${paragraphs}
</main>
</body></html>`;

  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}
