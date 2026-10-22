/**
 * Brave Search。検索だけを提供する（ページ取得は直接取得を使う）。
 * 検索: https://api.search.brave.com/res/v1/web/search
 *
 * 認証は X-Subscription-Token。
 */

import { SEARCH_TIMEOUT_MS } from "../constants";
import { requestJson } from "../http";
import type { ProviderAdapter } from "../types";
import { numberLimit, recordOf, snippetOf, stringOf, stringOrNull } from "./helpers";

const SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

export const brave: ProviderAdapter = {
  id: "brave",
  name: "Brave Search",
  supportsFetch: false,

  async search(context, request) {
    const params = new URLSearchParams({
      q: request.query,
      count: String(numberLimit(request.limit)),
      text_decorations: "false",
      safesearch: "moderate",
    });

    const json = await requestJson(
      context.fetch,
      `${SEARCH_URL}?${params.toString()}`,
      {
        method: "GET",
        headers: { Accept: "application/json", "X-Subscription-Token": context.apiKey },
      },
      { timeoutMs: SEARCH_TIMEOUT_MS, signal: request.signal, provider: "Brave Search" },
    );

    // 結果は web.results に入る。web が無い（0 件）こともある。
    const web = recordOf(recordOf(json)?.["web"]);
    const list = web?.["results"];
    if (!Array.isArray(list)) return { results: [] };

    return {
      results: list
        .map(recordOf)
        .filter((item): item is Record<string, unknown> => item !== null)
        .map((item) => ({
          title: stringOf(item["title"], "(untitled)"),
          url: stringOf(item["url"]),
          snippet: snippetOf(stringOf(item["description"])),
          publishedAt: stringOrNull(item["page_age"]) ?? stringOrNull(item["age"]),
        }))
        .filter((result) => result.url.length > 0),
    };
  },
};
