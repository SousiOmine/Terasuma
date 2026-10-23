/**
 * ルート表に無い要求と、パスはあるがメソッドが合わない要求を区別する。
 * Bun はどちらも fetch() へ回すので、そこで JSON の 404 と 405 を作り分ける。
 */
export type RouteProblem = "not_found" | "method_not_allowed";

export function routeProblem(routes: Record<string, unknown>, pathname: string, method: string): RouteProblem | null {
  for (const [pattern, entry] of Object.entries(routes)) {
    if (!pattern.startsWith("/api/")) continue;
    if (!matchesPath(pattern, pathname)) continue;

    // パスとメソッドが合っていれば、Bun がここへ回すことはない。
    if (!isHandlerMap(entry)) return null;
    return method in entry ? null : "method_not_allowed";
  }
  return "not_found";
}

/** ルートの値が、メソッドごとのハンドラを持つ表かどうか。 */
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

function isHandlerMap(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && METHODS.some((method) => method in value);
}

/** `/api/teras/:id/messages` のような表のパスが、実際のパスに合うかどうか。 */
function matchesPath(pattern: string, pathname: string): boolean {
  // 画面の中継は接頭辞で受ける。
  if (pattern.endsWith("/*")) return pathname.startsWith(pattern.slice(0, -1));
  if (!pattern.includes(":")) return pattern === pathname;

  const source = pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : escapeRegExp(segment)))
    .join("/");
  return new RegExp(`^${source}$`).test(pathname);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
