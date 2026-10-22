/**
 * Exa。検索とページ取得の両方を提供する。
 * 検索: https://api.exa.ai/search
 * 取得: https://api.exa.ai/contents
 *
 * 認証は x-api-key（Bearer も受け付けるが、公式の例に合わせて x-api-key にする）。
 */

import { FETCH_TIMEOUT_MS, MAX_FETCH_CHARS, SEARCH_TIMEOUT_MS } from "../constants";
import { WebSearchError } from "../errors";
import { requestJson } from "../http";
import type { ProviderAdapter } from "../types";
import { arrayOf, numberLimit, snippetOf, stringOf, stringOrNull } from "./helpers";

const SEARCH_URL = "https://api.exa.ai/search";
const CONTENTS_URL = "https://api.exa.ai/contents";

export const exa: ProviderAdapter = {
  id: "exa",
  name: "Exa",
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
          numResults: numberLimit(request.limit),
          type: "auto",
          // 抜粋に使う本文だけを短く取る（結果全体を大きくしない）。
          contents: { text: { maxCharacters: 1_200 } },
        }),
      },
      { timeoutMs: SEARCH_TIMEOUT_MS, signal: request.signal, provider: "Exa" },
    );

    return {
      results: arrayOf(json, "results")
        .map((item) => ({
          title: stringOf(item["title"], "(untitled)"),
          url: stringOf(item["url"]),
          snippet: snippetOf(stringOf(item["text"])),
          publishedAt: stringOrNull(item["publishedDate"]),
        }))
        .filter((result) => result.url.length > 0),
    };
  },

  async fetchPage(context, request) {
    const json = await requestJson(
      context.fetch,
      CONTENTS_URL,
      {
        method: "POST",
        headers: authHeaders(context.apiKey),
        body: JSON.stringify({ urls: [request.url], text: { maxCharacters: MAX_FETCH_CHARS } }),
      },
      { timeoutMs: FETCH_TIMEOUT_MS, signal: request.signal, provider: "Exa" },
    );

    const first = arrayOf(json, "results")[0];
    if (first === undefined) {
      throw new WebSearchError("unavailable", "Exa returned no content for the URL.");
    }

    return {
      url: stringOf(first["url"], request.url),
      title: stringOrNull(first["title"]),
      text: stringOf(first["text"]),
    };
  },
};

function authHeaders(apiKey: string): Record<string, string> {
  return { Accept: "application/json", "Content-Type": "application/json", "x-api-key": apiKey };
}
