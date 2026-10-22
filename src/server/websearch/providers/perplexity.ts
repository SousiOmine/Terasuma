/**
 * Perplexity Search API。検索だけを提供する（ページ取得は直接取得を使う）。
 * 検索: https://api.perplexity.ai/search
 *
 * 認証は Authorization: Bearer。回答の生成はせず、順位付きの結果だけを返す API を使う。
 */

import { SEARCH_TIMEOUT_MS } from "../constants";
import { requestJson } from "../http";
import type { ProviderAdapter } from "../types";
import { arrayOf, numberLimit, snippetOf, stringOf, stringOrNull } from "./helpers";

const SEARCH_URL = "https://api.perplexity.ai/search";

export const perplexity: ProviderAdapter = {
  id: "perplexity",
  name: "Perplexity",
  supportsFetch: false,

  async search(context, request) {
    const json = await requestJson(
      context.fetch,
      SEARCH_URL,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${context.apiKey}`,
        },
        body: JSON.stringify({ query: request.query, max_results: numberLimit(request.limit) }),
      },
      { timeoutMs: SEARCH_TIMEOUT_MS, signal: request.signal, provider: "Perplexity" },
    );

    return {
      results: arrayOf(json, "results")
        .map((item) => ({
          title: stringOf(item["title"], "(untitled)"),
          url: stringOf(item["url"]),
          snippet: snippetOf(stringOf(item["snippet"])),
          publishedAt: stringOrNull(item["date"]) ?? stringOrNull(item["last_updated"]),
        }))
        .filter((result) => result.url.length > 0),
    };
  },
};
