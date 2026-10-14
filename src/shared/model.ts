/**
 * モデル ID（"provider/model"）の扱い。
 * サーバもクライアントも同じ規則で読み書きできるよう、ここに 1 つだけ置く。
 */

/**
 * "provider/model" の形のモデル ID。
 * プロバイダ名の後にさらにスラッシュが続く形（openrouter/anthropic/...）も許す。
 */
export type ModelId = `${string}/${string}`;

/**
 * "provider/model" の形かどうかを判定する。
 * プロバイダ名の後にさらにスラッシュが続く形（openrouter/anthropic/...）も許す。
 */
export function isModelId(value: string): value is ModelId {
  return /^[^/\s]+\/.+$/.test(value);
}

/**
 * モデル ID の先頭部分（プロバイダ名）。
 * isModelId を通った値にだけ使う。
 */
export function modelProvider(model: ModelId): string {
  return model.slice(0, model.indexOf("/"));
}
