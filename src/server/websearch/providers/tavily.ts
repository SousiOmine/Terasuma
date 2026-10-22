/**
 * Tavily。検索とページ取得（Extract）の両方を提供する。
 * 検索: https://api.tavily.com/search
 * 取得: https://api.tavily.com/extract
 *
 * 認証は Authorization: Bearer。
 */

import { FETCH_TIMEOUT_MS, SEARCH_TIMEOUT_MS } from "../constants";
import { WebSearchError } from "../errors";
import { requestJson } from "../http";
import type { ProviderAdapter } from "../types";
import { arrayOf, numberLimit, snippetOf, stringOf, stringOrNull } from "./helpers";

const SEARCH_URL = "https://api.tavily.com/search";
const EXTRACT_URL = "https://api.tavily.com/extract";

export const tavily: ProviderAdapter = {
  id: "tavily",
  name: "Tavily",
  supportsFetch: true,

  async search(context, request) {
    const json = await requestJson(
      context.fetch,
      SEARCH_URL,
      {
        method: "POST",
        headers: authHeaders(context.apiKey),
        body: JSON.stringify({
          query: request.query,
          max_results: numberLimit(request.limit),
          search_depth: "basic",
          include_answer: false,
          include_raw_content: false,
        }),
      },
      { timeoutMs: SEARCH_TIMEOUT_MS, signal: request.signal, provider: "Tavily" },
    );

    return {
      results: arrayOf(json, "results")
        .map((item) => ({
          title: stringOf(item["title"], "(untitled)"),
          url: stringOf(item["url"]),
          snippet: snippetOf(stringOf(item["content"])),
          publishedAt: stringOrNull(item["published_date"]),
        }))
        .filter((result) => result.url.length > 0),
    };
  },

  async fetchPage(context, request) {
    const json = await requestJson(
      context.fetch,
      EXTRACT_URL,
      {
        method: "POST",
        headers: authHeaders(context.apiKey),
        body: JSON.stringify({
          urls: [request.url],
          extract_depth: "basic",
          format: "markdown",
          timeout: 30,
        }),
      },
      { timeoutMs: FETCH_TIMEOUT_MS, signal: request.signal, provider: "Tavily" },
    );

    const first = arrayOf(json, "results")[0];
    if (first === undefined) {
      // 失敗した URL は failed_results に理由が入る（HTTP は 200 のことがある）。
      const failure = arrayOf(json, "failed_results")[0];
      throw new WebSearchError("unavailable", stringOf(failure?.["error"], "Tavily could not extract the page."));
    }

    return {
      url: stringOf(first["url"], request.url),
      title: stringOrNull(first["title"]),
      text: stringOf(first["raw_content"]),
    };
  },
};

function authHeaders(apiKey: string): Record<string, string> {
  return { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` };
}
