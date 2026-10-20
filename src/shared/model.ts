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

/**
 * モデル ID を、プロバイダ名とモデル名に分ける。
 * 分解の仕方を各所に書くと、区切りの扱いが場所ごとにずれる。
 */
export function modelParts(model: ModelId): { provider: string; model: string } {
  const boundary = model.indexOf("/");
  return { provider: model.slice(0, boundary), model: model.slice(boundary + 1) };
}

/**
 * プロバイダ名とモデル名から、モデル ID を組み立てる。
 * 組み立てを各所に書くと、区切りや検証の有無が場所ごとにずれる。
 */
export function modelId(provider: string, model: string): ModelId {
  return `${provider}/${model}`;
}
